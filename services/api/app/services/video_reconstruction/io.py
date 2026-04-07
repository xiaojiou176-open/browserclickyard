from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Pattern
from urllib.parse import urlparse

from fastapi import HTTPException, status

from .types import ResolvedArtifacts


def resolve_runtime_path(runtime_root: Path, raw_path: str) -> Path:
    resolved = Path(raw_path).resolve()
    resolved_runtime_root = runtime_root.resolve()
    if not resolved.is_relative_to(resolved_runtime_root):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="artifact path is outside runtime root"
        )
    return resolved


def safe_recon_path(parent: Path, child: str) -> Path:
    resolved_parent = parent.resolve()
    resolved = (resolved_parent / child).resolve()
    if not resolved.is_relative_to(resolved_parent):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="path traversal detected"
        )
    return resolved


def resolve_session_dir(runtime_root: Path, artifacts: dict[str, Any]) -> Path:
    session_dir_value = str(artifacts.get("session_dir") or "").strip()
    if session_dir_value:
        return resolve_runtime_path(runtime_root, session_dir_value)

    latest_pointer = runtime_root / "latest-session.json"
    if latest_pointer.exists():
        try:
            raw = json.loads(latest_pointer.read_text(encoding="utf-8"))
            session_dir = str(raw.get("sessionDir") or "").strip()
            if session_dir:
                return resolve_runtime_path(runtime_root, session_dir)
        except json.JSONDecodeError:
            pass

    fallback = runtime_root / "session-fallback"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def resolve_optional_path(
    runtime_root: Path, session_dir: Path, raw_path: Any, fallback_name: str
) -> Path | None:
    value = str(raw_path or "").strip()
    if value:
        return resolve_runtime_path(runtime_root, value)
    candidate = safe_recon_path(session_dir, fallback_name)
    return candidate if candidate.exists() else None


def parse_har_entries(har_path: Path | None) -> list[dict[str, Any]]:
    if har_path is None or not har_path.exists():
        return []
    try:
        parsed_har = json.loads(har_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    entries = parsed_har.get("log", {}).get("entries", []) if isinstance(parsed_har, dict) else []
    normalized_entries: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        request = entry.get("request", {}) if isinstance(entry.get("request"), dict) else {}
        response = entry.get("response", {}) if isinstance(entry.get("response"), dict) else {}
        url = str(request.get("url") or "")
        parsed_url = urlparse(url) if url else None
        raw_headers = request.get("headers")
        headers: list[dict[str, Any]] = []
        if isinstance(raw_headers, list):
            headers = [header for header in raw_headers if isinstance(header, dict)]
        content_type = None
        for header in headers:
            name = str(header.get("name") or "").lower()
            if name == "content-type":
                content_type = str(header.get("value") or "") or None
                break
        normalized_entries.append(
            {
                "method": str(request.get("method") or "").upper(),
                "url": url,
                "path": parsed_url.path if parsed_url else "",
                "status": int(response.get("status") or 0),
                "content_type": content_type,
            }
        )
    return normalized_entries


def discover_start_url(har_entries: list[dict[str, Any]]) -> str | None:
    for entry in har_entries:
        url = str(entry.get("url") or "")
        if url.startswith("http"):
            return url
    return None


def resolve_artifacts(runtime_root: Path, artifacts: dict[str, Any]) -> ResolvedArtifacts:
    session_dir = resolve_session_dir(runtime_root, artifacts)
    har_path = resolve_optional_path(
        runtime_root, session_dir, artifacts.get("har_path"), "register.har"
    )
    html_path = resolve_optional_path(
        runtime_root, session_dir, artifacts.get("html_path"), "page.html"
    )
    video_path = resolve_optional_path(
        runtime_root, session_dir, artifacts.get("video_path"), "session.mp4"
    )

    html_content = str(artifacts.get("html_content") or "")
    if not html_content and html_path and html_path.exists():
        html_content = html_path.read_text(encoding="utf-8", errors="ignore")

    har_entries = parse_har_entries(har_path)

    metadata_raw = artifacts.get("metadata")
    metadata: dict[str, Any] = metadata_raw if isinstance(metadata_raw, dict) else {}
    start_url = str(metadata.get("start_url") or "").strip()
    if not start_url:
        start_url = discover_start_url(har_entries) or "https://example.com"

    return ResolvedArtifacts(
        start_url=start_url,
        session_dir=session_dir,
        video_path=video_path,
        har_path=har_path,
        html_path=html_path,
        html_content=html_content,
        har_entries=har_entries,
    )


def default_generator_outputs(
    preview_id: str, preview_id_pattern: Pattern[str], generated_dir: Path
) -> dict[str, str]:
    from .validation import validate_preview_id

    validate_preview_id(preview_id, preview_id_pattern)
    target_dir = safe_recon_path(generated_dir, preview_id)
    return {
        "flow_draft": str(safe_recon_path(target_dir, "flow-draft.json")),
        "playwright_spec": str(safe_recon_path(target_dir, "generated-playwright.spec.ts")),
        "api_spec": str(safe_recon_path(target_dir, "generated-api.spec.ts")),
        "readiness_report": str(safe_recon_path(target_dir, "run-readiness-report.json")),
    }


def persist_preview(preview_dir: Path, preview_id: str, preview_payload: dict[str, Any]) -> None:
    preview_dir.mkdir(parents=True, exist_ok=True)
    target = safe_recon_path(preview_dir, f"{preview_id}.json")
    target.write_text(json.dumps(preview_payload, ensure_ascii=False, indent=2), encoding="utf-8")


def materialize_generated_outputs(
    preview_id: str,
    flow_draft: dict[str, Any],
    generated_dir: Path,
    preview_id_pattern: Pattern[str],
    playwright_builder: Callable[[dict[str, Any]], str],
    api_builder: Callable[[dict[str, Any]], str],
) -> dict[str, str]:
    output_paths = default_generator_outputs(preview_id, preview_id_pattern, generated_dir)
    target_dir = safe_recon_path(generated_dir, preview_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    flow_path = Path(output_paths["flow_draft"])
    flow_path.write_text(json.dumps(flow_draft, ensure_ascii=False, indent=2), encoding="utf-8")

    playwright_path = Path(output_paths["playwright_spec"])
    playwright_path.write_text(playwright_builder(flow_draft), encoding="utf-8")

    api_path = Path(output_paths["api_spec"])
    api_path.write_text(api_builder(flow_draft), encoding="utf-8")

    readiness_path = Path(output_paths["readiness_report"])
    steps = flow_draft.get("steps", [])
    manual_gate_reasons = [
        str(step.get("unsupported_reason"))
        for step in steps
        if isinstance(step, dict)
        and str(step.get("action") or "") == "manual_gate"
        and step.get("unsupported_reason")
    ]
    bootstrap_steps = flow_draft.get("bootstrap_sequence", [])
    action_endpoint = flow_draft.get("action_endpoint")
    readiness_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(UTC).isoformat(),
                "preview_id": preview_id,
                "flow_id": flow_draft.get("flow_id"),
                "step_count": len(steps),
                "ready": True,
                "api_replay_ready": isinstance(action_endpoint, dict)
                and bool(action_endpoint.get("path")),
                "required_bootstrap_steps": len(bootstrap_steps)
                if isinstance(bootstrap_steps, list)
                else 0,
                "manual_gate_reasons": manual_gate_reasons,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return output_paths
