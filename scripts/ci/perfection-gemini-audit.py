#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types


PROMPT = (
    "You are a senior UI/UX + QA auditor. "
    "Given screenshot/video and HAR summary, produce strict JSON only with keys: "
    "overall_score (0-100), functional_status (pass|warning|fail), "
    "critical_findings (array of {id,severity,summary,evidence,fix}), "
    "ux_findings (array of {id,severity,summary,evidence,fix}), "
    "test_gaps (string[]), next_actions (string[]), verdict (string). "
    "Evaluation rubric: mark functional_status=pass when core user journey is successful and no blocking 4xx/5xx failures are observed. "
    "Do not downgrade to warning/fail based only on canceled/aborted network entries (status -1) because they may be expected during navigation, retries, or teardown. "
    "Treat placeholders/skeleton blocks as warning only when they clearly block the tested flow."
)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_bytes(path: Path) -> bytes:
    return path.read_bytes()


def _parse_response_text(text: str) -> dict[str, Any]:
    body = text.strip()
    if not body:
        return {"verdict": "empty-response"}
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            return parsed
        return {"raw": parsed}
    except json.JSONDecodeError:
        start = body.find("{")
        end = body.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(body[start : end + 1])
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass
        return {"raw": body}


def _extract_thought_summary(response: Any) -> str | None:
    candidates = getattr(response, "candidates", None)
    if not isinstance(candidates, list):
        return None
    chunks: list[str] = []
    for cand in candidates:
        content = getattr(cand, "content", None)
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            is_thought = bool(getattr(part, "thought", False))
            if not is_thought:
                continue
            txt = getattr(part, "text", None)
            if isinstance(txt, str) and txt.strip():
                chunks.append(txt.strip())
    if not chunks:
        return None
    joined = " ".join(chunks).strip()
    return joined if joined else None


def _normalize_thinking_level(raw: str | None) -> str:
    allowed = {"minimal", "low", "medium", "high"}
    value = (raw or "").strip().lower()
    if value in allowed:
        return value
    return "high"


def _resolve_temperature(raw: str | None) -> float:
    default = 0.1
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if value < 0:
        return 0.0
    if value > 2:
        return 2.0
    return value


def _video_mime_type(path: Path) -> str:
    suffix = path.suffix.strip().lower()
    if suffix == ".mp4":
        return "video/mp4"
    if suffix == ".webm":
        return "video/webm"
    return "application/octet-stream"


def _is_blocking_severity(raw: Any) -> bool:
    value = str(raw or "").strip().lower()
    return value in {"critical", "blocker", "high", "error", "fail"}


def _count_blocking_http_statuses(har_summary: dict[str, Any]) -> int:
    status_counts = har_summary.get("statusCounts") if isinstance(har_summary, dict) else None
    blocking = 0
    if not isinstance(status_counts, dict):
        return blocking
    for raw_code, count in status_counts.items():
        try:
            code = int(raw_code)
        except (TypeError, ValueError):
            continue
        if 400 <= code <= 599:
            try:
                blocking += int(count or 0)
            except (TypeError, ValueError):
                continue
    return blocking


def _count_blocking_findings(parsed: dict[str, Any]) -> int:
    total = 0
    for key in ("critical_findings", "ux_findings"):
        findings = parsed.get(key)
        if not isinstance(findings, list):
            continue
        for item in findings:
            if not isinstance(item, dict):
                continue
            if _is_blocking_severity(item.get("severity")):
                total += 1
    return total


def _normalize_warning_status(parsed: dict[str, Any], har_summary: dict[str, Any]) -> None:
    functional_status = str(parsed.get("functional_status") or "warning").strip().lower()
    if functional_status != "warning":
        return

    blocking_http = _count_blocking_http_statuses(har_summary)
    blocking_findings = _count_blocking_findings(parsed)

    if blocking_http == 0 and blocking_findings == 0:
        parsed["functional_status"] = "pass"
        parsed["normalization_note"] = (
            "Upgraded warning->pass: no blocking HTTP 4xx/5xx and no blocking-severity findings."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Gemini multimodal UI audit")
    parser.add_argument("--screenshot", required=True, help="PNG screenshot path")
    parser.add_argument("--video", required=True, help="WebM/MP4 video path")
    parser.add_argument("--har-summary", required=True, help="HAR summary JSON path")
    parser.add_argument("--output", required=True, help="output JSON path")
    parser.add_argument("--model", default=os.getenv("GEMINI_MODEL", "gemini-3.1-pro-preview"))
    parser.add_argument("--thinking-level", default=os.getenv("GEMINI_THINKING_LEVEL", "high"))
    parser.add_argument("--temperature", default=os.getenv("GEMINI_TEMPERATURE", "0.1"))
    args = parser.parse_args()

    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("missing GEMINI_API_KEY")

    screenshot_path = Path(args.screenshot)
    video_path = Path(args.video)
    har_summary_path = Path(args.har_summary)
    output_path = Path(args.output)

    har_summary = _read_json(har_summary_path)
    screenshot_bytes = _load_bytes(screenshot_path)
    video_bytes = _load_bytes(video_path)
    video_mime_type = _video_mime_type(video_path)
    thinking_level = _normalize_thinking_level(args.thinking_level)
    temperature = _resolve_temperature(args.temperature)
    debug_thoughts = os.getenv("GEMINI_AUDIT_DEBUG_THOUGHTS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=args.model,
        contents=[
            PROMPT,
            types.Part.from_text(
                text=f"HAR summary: {json.dumps(har_summary, ensure_ascii=False)}"
            ),
            types.Part.from_bytes(data=screenshot_bytes, mime_type="image/png"),
            types.Part.from_bytes(data=video_bytes, mime_type=video_mime_type),
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=temperature,
            thinking_config=types.ThinkingConfig(
                thinking_level=thinking_level,
                include_thoughts=debug_thoughts,
            ),
        ),
    )

    parsed = _parse_response_text(getattr(response, "text", "") or "")

    functional_status = str(parsed.get("functional_status") or "warning").strip().lower()
    if functional_status not in {"pass", "warning", "fail"}:
        functional_status = "warning"
        parsed["functional_status"] = "warning"
    _normalize_warning_status(parsed, har_summary)
    functional_status = str(parsed.get("functional_status") or functional_status).strip().lower()

    output = {
        "analysis": parsed,
        "analysis_meta": {
            "model": args.model,
            "thinking_level": thinking_level,
            "temperature": temperature,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "inputs": {
                "screenshot": str(screenshot_path),
                "video": str(video_path),
                "video_mime_type": video_mime_type,
                "har_summary": str(har_summary_path),
            },
        },
    }
    if debug_thoughts:
        output["analysis_meta"]["thought_summary"] = _extract_thought_summary(response)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.stderr.write(f"perfection-gemini-audit failed: {exc}\n")
        raise SystemExit(1) from exc
