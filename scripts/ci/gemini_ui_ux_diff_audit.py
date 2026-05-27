#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types


EXTENSIONS = {".css", ".scss", ".tsx", ".jsx", ".ts", ".js", ".html"}
MAX_FILES = 12
MAX_CHARS_PER_FILE = 12_000
MAX_TOTAL_CHARS = 80_000
REPORT_PATH = Path(".runtime-cache/artifacts/uiux/gemini-uiux-diff-audit.json")
PROMPT = """
You are a strict senior frontend reviewer (UI/UX + a11y + design-system governance).
Review the provided code diff and changed file snapshots.

Hard rules:
1) Accessibility (WCAG 2.2 AA): semantic controls, labels, keyboard focus, aria misuse.
2) UI consistency: avoid ad-hoc styles; keep consistent tokens/spacing/typography.
3) Interaction quality: clear states for loading/disabled/error; avoid ambiguous UX.
4) Maintainability: avoid fragile selectors/styles, avoid visual hacks.

Return STRICT JSON ONLY:
{
  "passed": true|false,
  "summary": "string",
  "issues": [
    {
      "file": "path",
      "severity": "error|warning",
      "category": "a11y|ui-consistency|ux-flow|maintainability",
      "reason": "what is wrong",
      "fix": "concrete fix suggestion"
    }
  ]
}
Mark severity=error only for issues that should block merge.
""".strip()


def _run_git(args: list[str]) -> str:
    try:
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()
    except subprocess.CalledProcessError:
        return ""


def _filter_targets(paths: list[str]) -> list[str]:
    keep: list[str] = []
    for path in paths:
        if not path:
            continue
        p = Path(path)
        if p.suffix.lower() not in EXTENSIONS:
            continue
        normalized = str(p)
        if normalized.startswith("apps/command-center/"):
            candidates = [p, Path("frontend") / normalized.removeprefix("apps/command-center/")]
        else:
            candidates = [p]
        existing = next(
            (
                candidate
                for candidate in candidates
                if candidate.exists() and not candidate.is_dir()
            ),
            None,
        )
        if existing is None:
            continue
        if not (
            normalized.startswith("apps/command-center/")
            or normalized.startswith("tests/web-harness/")
        ):
            continue
        keep.append(normalized)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in keep:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    deduped.sort(key=lambda item: (0 if item.startswith("tests/web-harness/") else 1, item))
    return deduped[:MAX_FILES]


def _detect_targets(cli_files: list[str]) -> list[str]:
    # Prefer git ranges, because pre-push often has no staged files.
    raw = _run_git(["diff", "--name-only", "@{upstream}...HEAD"])
    if raw:
        return _filter_targets(raw.splitlines())

    raw = _run_git(["diff", "--cached", "--name-only"])
    if raw:
        return _filter_targets(raw.splitlines())

    raw = _run_git(["diff", "--name-only", "HEAD~1..HEAD"])
    if raw:
        return _filter_targets(raw.splitlines())

    # pre-commit --all-files for pre-push can pass every file; skip by default to avoid huge LLM calls.
    if os.getenv("UIQ_GEMINI_UIUX_ALLOW_ALL_FILES", "").strip().lower() in {"1", "true", "yes"}:
        return _filter_targets(cli_files)
    return []


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        env[key] = value
    return env


def _load_api_key() -> str:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if key:
        return key
    file_env = _read_env_file(Path(".env"))
    return file_env.get("GEMINI_API_KEY", "").strip()


def _resolve_model() -> str:
    if os.getenv("GEMINI_UI_UX_AUDIT_MODEL", "").strip():
        return os.getenv("GEMINI_UI_UX_AUDIT_MODEL", "").strip()
    if os.getenv("GEMINI_FAST_MODEL", "").strip():
        return os.getenv("GEMINI_FAST_MODEL", "").strip()
    file_env = _read_env_file(Path(".env"))
    if file_env.get("GEMINI_FAST_MODEL", "").strip():
        return file_env["GEMINI_FAST_MODEL"].strip()
    return "models/gemini-3.0-flash"


def _build_model_candidates(primary: str) -> list[str]:
    candidates = [
        primary,
        "models/gemini-3.0-flash",
        "gemini-3.0-flash",
        "models/gemini-3-flash-preview",
        "gemini-3-flash-preview",
        "models/gemini-2.5-flash",
        "gemini-2.5-flash",
        "models/gemini-2.0-flash",
        "gemini-2.0-flash",
    ]
    return [m for m in dict.fromkeys(candidates) if m]


def _collect_payload(files: list[str]) -> dict[str, Any]:
    remaining = MAX_TOTAL_CHARS
    snapshots: list[dict[str, str]] = []
    for file in files:
        content = Path(file).read_text(encoding="utf-8", errors="ignore")
        if len(content) > MAX_CHARS_PER_FILE:
            content = content[:MAX_CHARS_PER_FILE]
        if len(content) > remaining:
            content = content[:remaining]
        if not content:
            continue
        snapshots.append({"path": file, "content": content})
        remaining -= len(content)
        if remaining <= 0:
            break

    diff = _run_git(["diff", "--unified=0", "--", *files])
    if not diff:
        diff = _run_git(["diff", "--cached", "--unified=0", "--", *files])
    if not diff:
        diff = _run_git(["show", "--pretty=format:", "--unified=0", "HEAD", "--", *files])
    if len(diff) > 50_000:
        diff = diff[:50_000]
    return {"files": snapshots, "diff": diff}


def _parse_json(text: str) -> dict[str, Any]:
    body = (text or "").strip()
    if not body:
        return {"passed": False, "summary": "empty response", "issues": []}
    try:
        data = json.loads(body)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    start = body.find("{")
    end = body.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(body[start : end + 1])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    return {"passed": False, "summary": "invalid json response", "issues": [{"severity": "error"}]}


def main() -> int:
    targets = _detect_targets(sys.argv[1:])
    if not targets:
        print("gemini-uiux: no frontend UI/UX file changes detected; skip")
        return 0

    api_key = _load_api_key()
    if not api_key:
        print("gemini-uiux: missing GEMINI_API_KEY in env/.env", file=sys.stderr)
        return 1

    model = _resolve_model()
    payload = _collect_payload(targets)
    client = genai.Client(api_key=api_key)
    used_model = ""
    response = None
    last_error: Exception | None = None
    for candidate in _build_model_candidates(model):
        try:
            response = client.models.generate_content(
                model=candidate,
                contents=[
                    PROMPT,
                    types.Part.from_text(text=json.dumps(payload, ensure_ascii=False)),
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.1,
                ),
            )
            used_model = candidate
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            err_text = str(exc)
            if "404" in err_text or "NOT_FOUND" in err_text or "not found" in err_text.lower():
                continue
            print(f"gemini-uiux: generation failed on model {candidate}: {exc}", file=sys.stderr)
            return 1

    if response is None:
        print(
            f"gemini-uiux: failed to resolve an available flash model; last_error={last_error}",
            file=sys.stderr,
        )
        return 1

    parsed = _parse_json(getattr(response, "text", "") or "")
    issues = parsed.get("issues")
    if not isinstance(issues, list):
        issues = []
    blocking = [
        i for i in issues if isinstance(i, dict) and str(i.get("severity", "")).lower() == "error"
    ]
    model_declared_failed = parsed.get("passed") is False
    if model_declared_failed and not blocking:
        blocking.append(
            {
                "severity": "error",
                "category": "maintainability",
                "reason": "model_marked_failed_without_error_severity",
                "fix": "Mark at least one blocking issue with severity=error when passed=false.",
            }
        )
    passed = not blocking and not model_declared_failed

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(
        json.dumps(
            {
                "model": model,
                "used_model": used_model,
                "targets": targets,
                "result": parsed,
                "blocking_count": len(blocking),
                "passed": passed,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    blocking_mode = os.getenv("GEMINI_UI_UX_BLOCKING", "1").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if blocking and blocking_mode:
        print(f"gemini-uiux: failed ({len(blocking)} blocking issues)", file=sys.stderr)
        print(f"report: {REPORT_PATH}", file=sys.stderr)
        return 1

    if blocking:
        print(
            f"gemini-uiux: advisory mode, {len(blocking)} blocking-class findings recorded (not blocking)."
        )
    print(f"gemini-uiux: passed ({len(issues)} findings)")
    print(f"report: {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
