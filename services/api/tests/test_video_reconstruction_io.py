from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.video_reconstruction.io import (
    default_generator_outputs,
    discover_start_url,
    materialize_generated_outputs,
    parse_har_entries,
    persist_preview,
    resolve_artifacts,
    resolve_optional_path,
    resolve_runtime_path,
    resolve_session_dir,
    safe_recon_path,
)


def test_resolve_runtime_path_allows_descendant(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    target = runtime_root / "a" / "b.json"
    target.parent.mkdir(parents=True)
    target.write_text("{}", encoding="utf-8")

    resolved = resolve_runtime_path(runtime_root, str(target))
    assert resolved == target.resolve()


def test_resolve_runtime_path_rejects_outside_root(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")

    with pytest.raises(HTTPException, match="outside runtime root"):
        resolve_runtime_path(runtime_root, str(outside))


def test_safe_recon_path_rejects_path_traversal(tmp_path: Path) -> None:
    parent = tmp_path / "base"
    parent.mkdir()
    with pytest.raises(HTTPException, match="path traversal detected"):
        safe_recon_path(parent, "../escape.txt")


def test_resolve_session_dir_uses_explicit_value(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s1"
    session_dir.mkdir()

    resolved = resolve_session_dir(runtime_root, {"session_dir": str(session_dir)})
    assert resolved == session_dir.resolve()


def test_resolve_session_dir_uses_latest_pointer(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s-latest"
    session_dir.mkdir()
    (runtime_root / "latest-session.json").write_text(
        json.dumps({"sessionDir": str(session_dir)}), encoding="utf-8"
    )

    resolved = resolve_session_dir(runtime_root, {})
    assert resolved == session_dir.resolve()


def test_resolve_session_dir_falls_back_when_pointer_invalid(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    (runtime_root / "latest-session.json").write_text("{invalid-json", encoding="utf-8")

    resolved = resolve_session_dir(runtime_root, {})
    assert resolved == (runtime_root / "session-fallback").resolve()
    assert resolved.exists()


def test_resolve_optional_path_prefers_explicit_runtime_path(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s"
    session_dir.mkdir()
    explicit = runtime_root / "x" / "explicit.har"
    explicit.parent.mkdir(parents=True)
    explicit.write_text("{}", encoding="utf-8")

    resolved = resolve_optional_path(runtime_root, session_dir, str(explicit), "register.har")
    assert resolved == explicit.resolve()


def test_resolve_optional_path_uses_fallback_if_exists(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s"
    session_dir.mkdir()
    fallback = session_dir / "register.har"
    fallback.write_text("{}", encoding="utf-8")

    resolved = resolve_optional_path(runtime_root, session_dir, "", "register.har")
    assert resolved == fallback.resolve()


def test_parse_har_entries_handles_invalid_and_normalizes(tmp_path: Path) -> None:
    har_path = tmp_path / "register.har"
    har_payload = {
        "log": {
            "entries": [
                "not-a-dict",
                {
                    "request": {
                        "method": "post",
                        "url": "https://example.com/api/register",
                        "headers": [{"name": "Content-Type", "value": "application/json"}],
                    },
                    "response": {"status": 201},
                },
                {
                    "request": {
                        "method": "GET",
                        "url": "https://example.com/health",
                        "headers": [],
                    },
                    "response": {"status": 200},
                },
            ]
        }
    }
    har_path.write_text(json.dumps(har_payload), encoding="utf-8")

    parsed = parse_har_entries(har_path)
    assert len(parsed) == 2
    assert parsed[0]["method"] == "POST"
    assert parsed[0]["path"] == "/api/register"
    assert parsed[0]["status"] == 201
    assert parsed[0]["content_type"] == "application/json"
    assert parsed[1]["method"] == "GET"
    assert parsed[1]["path"] == "/health"


def test_parse_har_entries_returns_empty_on_invalid_json(tmp_path: Path) -> None:
    har_path = tmp_path / "register.har"
    har_path.write_text("{broken", encoding="utf-8")
    assert parse_har_entries(har_path) == []


def test_discover_start_url_uses_first_http_entry() -> None:
    entries = [{"url": "mailto:test@example.com"}, {"url": "https://example.com/start"}]
    assert discover_start_url(entries) == "https://example.com/start"


def test_resolve_artifacts_prefers_metadata_start_url_and_loads_html(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s1"
    session_dir.mkdir()
    html_path = session_dir / "page.html"
    html_path.write_text("<html><body>ok</body></html>", encoding="utf-8")
    har_path = session_dir / "register.har"
    har_path.write_text(
        json.dumps(
            {
                "log": {
                    "entries": [
                        {
                            "request": {"method": "GET", "url": "https://example.com/from-har"},
                            "response": {"status": 200},
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    video_path = session_dir / "session.mp4"
    video_path.write_bytes(b"video")

    artifacts = resolve_artifacts(
        runtime_root,
        {
            "session_dir": str(session_dir),
            "metadata": {"start_url": "https://example.com/from-metadata"},
        },
    )

    assert artifacts.start_url == "https://example.com/from-metadata"
    assert artifacts.html_content.startswith("<html>")
    assert artifacts.video_path == video_path.resolve()
    assert artifacts.har_path == har_path.resolve()
    assert len(artifacts.har_entries) == 1


def test_resolve_artifacts_falls_back_to_har_or_default_start_url(tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    session_dir = runtime_root / "s2"
    session_dir.mkdir()
    (runtime_root / "latest-session.json").write_text(
        json.dumps({"sessionDir": str(session_dir)}), encoding="utf-8"
    )

    # First without har: should use default.
    artifacts_no_har = resolve_artifacts(runtime_root, {})
    assert artifacts_no_har.start_url == "https://example.com"

    # Then with har: should discover start url from har entries.
    (session_dir / "register.har").write_text(
        json.dumps(
            {
                "log": {
                    "entries": [
                        {
                            "request": {"method": "GET", "url": "https://example.com/discovered"},
                            "response": {"status": 200},
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    artifacts_with_har = resolve_artifacts(runtime_root, {})
    assert artifacts_with_har.start_url == "https://example.com/discovered"


def test_default_generator_outputs_and_persist_preview(tmp_path: Path) -> None:
    generated_dir = tmp_path / "generated"
    outputs = default_generator_outputs(
        preview_id="prv-123",
        preview_id_pattern=re.compile(r"^prv-[0-9]+$"),
        generated_dir=generated_dir,
    )
    assert outputs["flow_draft"].endswith("flow-draft.json")
    assert outputs["playwright_spec"].endswith("generated-playwright.spec.ts")
    assert outputs["api_spec"].endswith("generated-api.spec.ts")
    assert outputs["readiness_report"].endswith("run-readiness-report.json")

    preview_dir = tmp_path / "preview"
    persist_preview(preview_dir, "prv-123", {"ok": True})
    preview_file = preview_dir / "prv-123.json"
    assert preview_file.exists()
    assert json.loads(preview_file.read_text(encoding="utf-8"))["ok"] is True


def test_materialize_generated_outputs_writes_files_and_readiness(tmp_path: Path) -> None:
    generated_dir = tmp_path / "generated"
    flow_draft = {
        "flow_id": "flow-1",
        "steps": [
            {"step_id": "s1", "action": "navigate"},
            {"step_id": "s2", "action": "manual_gate", "unsupported_reason": "needs_captcha"},
        ],
        "action_endpoint": {"path": "/api/register", "method": "POST"},
        "bootstrap_sequence": [{"action": "wait"}],
    }

    output_paths = materialize_generated_outputs(
        preview_id="prv-999",
        flow_draft=flow_draft,
        generated_dir=generated_dir,
        preview_id_pattern=re.compile(r"^prv-[0-9]+$"),
        playwright_builder=lambda _: "// pw",
        api_builder=lambda _: "// api",
    )

    for key in ("flow_draft", "playwright_spec", "api_spec", "readiness_report"):
        assert Path(output_paths[key]).exists()

    readiness = json.loads(Path(output_paths["readiness_report"]).read_text(encoding="utf-8"))
    assert readiness["ready"] is True
    assert readiness["api_replay_ready"] is True
    assert readiness["required_bootstrap_steps"] == 1
    assert readiness["manual_gate_reasons"] == ["needs_captcha"]
