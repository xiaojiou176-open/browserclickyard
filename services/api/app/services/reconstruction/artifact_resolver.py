from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from fastapi import HTTPException, status


@dataclass
class ResolvedArtifacts:
    start_url: str
    session_dir: Path
    video_path: Path | None
    har_path: Path | None
    html_path: Path | None
    html_content: str
    har_entries: list[dict[str, Any]]


def safe_resolve_under(
    root: Path, candidate: str | Path, allowed_exts: set[str] | None, max_bytes: int
) -> Path:
    resolved_root = root.resolve()
    try:
        candidate_path = Path(candidate)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"invalid artifact path: {candidate}",
        ) from exc
    if not candidate_path.is_absolute():
        candidate_path = resolved_root / candidate_path
    try:
        resolved_candidate = candidate_path.resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"invalid artifact path: {candidate_path}",
        ) from exc

    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"artifact path outside runtime root: {candidate_path}",
        ) from exc

    if allowed_exts:
        normalized_exts = {
            ext.lower() if ext.startswith(".") else f".{ext.lower()}" for ext in allowed_exts
        }
        suffix = resolved_candidate.suffix.lower()
        if suffix not in normalized_exts:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"invalid artifact extension for path: {candidate_path}",
            )

    try:
        exists = resolved_candidate.exists()
        is_file = resolved_candidate.is_file() if exists else False
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"invalid artifact path: {candidate_path}",
        ) from exc

    if exists and is_file:
        try:
            size = resolved_candidate.stat().st_size
        except OSError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"unable to read artifact metadata: {candidate_path}",
            ) from exc
        if size > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"artifact exceeds max bytes ({max_bytes}): {candidate_path}",
            )
    return resolved_candidate


def resolve_artifacts(
    runtime_root: Path,
    artifacts: dict[str, Any],
    artifact_max_bytes: int,
    discover_start_url: Callable[[list[dict[str, Any]]], str | None],
) -> ResolvedArtifacts:
    session_dir = resolve_session_dir(runtime_root, artifacts, artifact_max_bytes)
    har_path = resolve_optional_path(
        runtime_root,
        session_dir,
        artifacts.get("har_path"),
        "register.har",
        allowed_exts={".har", ".json"},
        artifact_max_bytes=artifact_max_bytes,
    )
    html_path = resolve_optional_path(
        runtime_root,
        session_dir,
        artifacts.get("html_path"),
        "page.html",
        allowed_exts={".html", ".htm"},
        artifact_max_bytes=artifact_max_bytes,
    )
    video_path = resolve_optional_path(
        runtime_root,
        session_dir,
        artifacts.get("video_path"),
        "session.mp4",
        allowed_exts={".mp4", ".webm", ".mov", ".mkv"},
        artifact_max_bytes=artifact_max_bytes,
    )

    html_content = str(artifacts.get("html_content") or "")
    if not html_content and html_path and html_path.exists():
        html_content = html_path.read_text(encoding="utf-8", errors="ignore")

    har_entries = _parse_har_entries(har_path)
    start_url = str(artifacts.get("metadata", {}).get("start_url") or "").strip()
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


def resolve_session_dir(
    runtime_root: Path, artifacts: dict[str, Any], artifact_max_bytes: int
) -> Path:
    session_dir_value = str(artifacts.get("session_dir") or "").strip()
    if session_dir_value:
        resolved = safe_resolve_under(
            runtime_root, session_dir_value, allowed_exts=None, max_bytes=artifact_max_bytes
        )
        if not resolved.exists() or not resolved.is_dir():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"session_dir is not an existing directory: {session_dir_value}",
            )
        return resolved

    latest_pointer = runtime_root / "latest-session.json"
    if latest_pointer.exists():
        try:
            raw = json.loads(latest_pointer.read_text(encoding="utf-8"))
            session_dir = str(raw.get("sessionDir") or "").strip()
            if session_dir:
                resolved = safe_resolve_under(
                    runtime_root,
                    session_dir,
                    allowed_exts=None,
                    max_bytes=artifact_max_bytes,
                )
                if not resolved.exists() or not resolved.is_dir():
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"latest sessionDir is not an existing directory: {session_dir}",
                    )
                return resolved
        except json.JSONDecodeError:
            pass

    fallback = runtime_root / "session-fallback"
    fallback.mkdir(parents=True, exist_ok=True)
    return safe_resolve_under(
        runtime_root, fallback, allowed_exts=None, max_bytes=artifact_max_bytes
    )


def resolve_optional_path(
    runtime_root: Path,
    session_dir: Path,
    raw_path: Any,
    fallback_name: str,
    *,
    allowed_exts: set[str],
    artifact_max_bytes: int,
) -> Path | None:
    value = str(raw_path or "").strip()
    if value:
        resolved = safe_resolve_under(
            runtime_root,
            value,
            allowed_exts=allowed_exts,
            max_bytes=artifact_max_bytes,
        )
        if not resolved.exists():
            return None
        if not resolved.is_file():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"artifact path must be a file: {value}",
            )
        return resolved
    candidate = session_dir / fallback_name
    if not candidate.exists():
        return None
    resolved = safe_resolve_under(
        runtime_root,
        candidate,
        allowed_exts=allowed_exts,
        max_bytes=artifact_max_bytes,
    )
    if not resolved.is_file():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"artifact path must be a file: {candidate}",
        )
    return resolved


def _parse_har_entries(har_path: Path | None) -> list[dict[str, Any]]:
    if not har_path or not har_path.exists():
        return []

    entries: list[dict[str, Any]] = []
    try:
        parsed = json.loads(har_path.read_text(encoding="utf-8"))
        raw_entries = parsed.get("log", {}).get("entries", []) if isinstance(parsed, dict) else []
        for entry in raw_entries:
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
            entries.append(
                {
                    "method": str(request.get("method") or "").upper(),
                    "url": url,
                    "path": parsed_url.path if parsed_url else "",
                    "status": int(response.get("status") or 0),
                    "content_type": content_type,
                }
            )
    except json.JSONDecodeError:
        return []

    return entries
