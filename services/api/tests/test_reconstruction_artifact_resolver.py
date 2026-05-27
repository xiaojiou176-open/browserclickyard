from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.reconstruction.artifact_resolver import (
    _parse_har_entries,
    resolve_artifacts,
    resolve_optional_path,
    resolve_session_dir,
    safe_resolve_under,
)


def test_safe_resolve_under_accepts_relative_path(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    target = root / "session" / "a.har"
    target.parent.mkdir(parents=True)
    target.write_text("{}", encoding="utf-8")
    resolved = safe_resolve_under(root, "session/a.har", allowed_exts={".har"}, max_bytes=1024)
    assert resolved == target.resolve()


def test_safe_resolve_under_rejects_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    outside = tmp_path / "outside.har"
    outside.write_text("{}", encoding="utf-8")
    with pytest.raises(HTTPException, match="outside runtime root"):
        safe_resolve_under(root, outside, allowed_exts={".har"}, max_bytes=1024)


def test_safe_resolve_under_rejects_invalid_extension(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    target = root / "x.txt"
    target.write_text("{}", encoding="utf-8")
    with pytest.raises(HTTPException, match="invalid artifact extension"):
        safe_resolve_under(root, target, allowed_exts={".har"}, max_bytes=1024)


def test_safe_resolve_under_rejects_null_byte_path(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    with pytest.raises(HTTPException, match="invalid artifact path"):
        safe_resolve_under(root, "bad\x00path.har", allowed_exts={".har"}, max_bytes=1024)


def test_safe_resolve_under_rejects_too_large_file(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    target = root / "x.har"
    target.write_bytes(b"123456")
    with pytest.raises(HTTPException, match="exceeds max bytes"):
        safe_resolve_under(root, target, allowed_exts={".har"}, max_bytes=5)


def test_safe_resolve_under_raises_when_stat_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    target = root / "x.har"
    target.write_text("{}", encoding="utf-8")
    resolved_target = target.resolve()
    original_exists = Path.exists
    original_is_file = Path.is_file
    original_stat = Path.stat

    def _fake_exists(self: Path) -> bool:
        if self == resolved_target:
            return True
        return original_exists(self)

    def _fake_is_file(self: Path) -> bool:
        if self == resolved_target:
            return True
        return original_is_file(self)

    def _fake_stat(self: Path):
        if self == resolved_target:
            raise OSError("stat failed")
        return original_stat(self)

    monkeypatch.setattr(Path, "exists", _fake_exists)
    monkeypatch.setattr(Path, "is_file", _fake_is_file)
    monkeypatch.setattr(Path, "stat", _fake_stat)
    with pytest.raises(HTTPException, match="unable to read artifact metadata"):
        safe_resolve_under(root, target, allowed_exts={".har"}, max_bytes=1024)


def test_resolve_session_dir_with_explicit_existing_dir(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "s1"
    session_dir.mkdir()
    resolved = resolve_session_dir(root, {"session_dir": str(session_dir)}, artifact_max_bytes=1024)
    assert resolved == session_dir.resolve()


def test_resolve_session_dir_explicit_missing_dir_raises(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    missing = root / "nope"
    with pytest.raises(HTTPException, match="session_dir is not an existing directory"):
        resolve_session_dir(root, {"session_dir": str(missing)}, artifact_max_bytes=1024)


def test_resolve_session_dir_latest_pointer_non_dir_raises(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    file_path = root / "not-dir"
    file_path.write_text("x", encoding="utf-8")
    (root / "latest-session.json").write_text(
        json.dumps({"sessionDir": str(file_path)}), encoding="utf-8"
    )
    with pytest.raises(HTTPException, match="latest sessionDir is not an existing directory"):
        resolve_session_dir(root, {}, artifact_max_bytes=1024)


def test_resolve_session_dir_invalid_pointer_falls_back(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    (root / "latest-session.json").write_text("{bad-json", encoding="utf-8")
    resolved = resolve_session_dir(root, {}, artifact_max_bytes=1024)
    assert resolved == (root / "session-fallback").resolve()


def test_resolve_optional_path_raw_missing_returns_none(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "s"
    session_dir.mkdir()
    resolved = resolve_optional_path(
        root,
        session_dir,
        str(root / "missing.har"),
        "register.har",
        allowed_exts={".har"},
        artifact_max_bytes=1024,
    )
    assert resolved is None


def test_resolve_optional_path_raw_directory_raises(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "s"
    session_dir.mkdir()
    bad = root / "dir.har"
    bad.mkdir()
    with pytest.raises(HTTPException, match="artifact path must be a file"):
        resolve_optional_path(
            root,
            session_dir,
            str(bad),
            "register.har",
            allowed_exts={".har"},
            artifact_max_bytes=1024,
        )


def test_resolve_optional_path_fallback_directory_raises(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "s"
    session_dir.mkdir()
    (session_dir / "register.har").mkdir()
    with pytest.raises(HTTPException, match="artifact path must be a file"):
        resolve_optional_path(
            root,
            session_dir,
            "",
            "register.har",
            allowed_exts={".har"},
            artifact_max_bytes=1024,
        )


def test_parse_har_entries_invalid_json_returns_empty(tmp_path: Path) -> None:
    har_path = tmp_path / "x.har"
    har_path.write_text("{bad", encoding="utf-8")
    assert _parse_har_entries(har_path) == []


def test_parse_har_entries_none_returns_empty() -> None:
    assert _parse_har_entries(None) == []


def test_parse_har_entries_normalizes_mixed_entries(tmp_path: Path) -> None:
    har_path = tmp_path / "x.har"
    har_path.write_text(
        json.dumps(
            {
                "log": {
                    "entries": [
                        "invalid-entry",
                        {"request": "not-dict", "response": "not-dict"},
                        {
                            "request": {
                                "method": "post",
                                "url": "https://example.com/api/register",
                                "headers": "not-a-list",
                            },
                            "response": {"status": 201},
                        },
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    parsed = _parse_har_entries(har_path)
    assert len(parsed) == 2
    assert parsed[0]["method"] == ""
    assert parsed[0]["path"] == ""
    assert parsed[0]["status"] == 0
    assert parsed[0]["content_type"] is None
    assert parsed[1]["method"] == "POST"
    assert parsed[1]["path"] == "/api/register"
    assert parsed[1]["status"] == 201
    assert parsed[1]["content_type"] is None


def test_resolve_artifacts_reads_defaults_and_discovers_start_url(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "session"
    session_dir.mkdir()
    (root / "latest-session.json").write_text(
        json.dumps({"sessionDir": str(session_dir)}), encoding="utf-8"
    )
    (session_dir / "page.html").write_text("<html/>", encoding="utf-8")
    (session_dir / "register.har").write_text(
        json.dumps(
            {
                "log": {
                    "entries": [
                        {
                            "request": {
                                "method": "GET",
                                "url": "https://example.com/start",
                                "headers": [{"name": "content-type", "value": "application/json"}],
                            },
                            "response": {"status": 200},
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    (session_dir / "session.mp4").write_bytes(b"v")

    artifacts = resolve_artifacts(
        runtime_root=root,
        artifacts={},
        artifact_max_bytes=100_000,
        discover_start_url=lambda entries: entries[0]["url"] if entries else None,
    )
    assert artifacts.start_url == "https://example.com/start"
    assert artifacts.video_path is not None
    assert artifacts.html_content == "<html/>"
    assert artifacts.har_entries[0]["content_type"] == "application/json"


def test_resolve_artifacts_defaults_start_url_when_metadata_and_har_missing(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    root.mkdir()
    session_dir = root / "session"
    session_dir.mkdir()

    artifacts = resolve_artifacts(
        runtime_root=root,
        artifacts={"session_dir": str(session_dir)},
        artifact_max_bytes=100_000,
        discover_start_url=lambda entries: entries[0]["url"] if entries else None,
    )
    assert artifacts.start_url == "https://example.com"
