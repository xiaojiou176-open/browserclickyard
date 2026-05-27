from __future__ import annotations

import json
import os
import builtins
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException

import app.api.command_tower as command_tower


def test_resolve_session_for_requester_branch_edges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(HTTPException) as blank_session:
        command_tower.resolve_session_for_requester("actor", session_id="   ")
    assert blank_session.value.status_code == 422

    monkeypatch.setattr(
        command_tower.universal_platform_service,
        "list_sessions",
        lambda limit, requester: [SimpleNamespace(session_id="s-owned")],
    )
    monkeypatch.setattr(command_tower, "_validated_session_dir", lambda root, raw: None)
    assert command_tower.resolve_session_for_requester("actor") is None


@pytest.mark.parametrize("nullish_value", ["null", "None", "  null  ", " none "])
def test_resolve_session_for_requester_accepts_nullish_query_value(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, nullish_value: str
) -> None:
    session_dir = tmp_path / "ss-owned"
    session_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(
        command_tower.universal_platform_service,
        "list_sessions",
        lambda limit, requester: [SimpleNamespace(session_id="ss-owned")],
    )
    monkeypatch.setattr(
        command_tower.universal_platform_service,
        "get_session",
        lambda session_id, requester: (_ for _ in ()).throw(
            AssertionError("explicit lookup should not run for nullish session_id")
        ),
    )
    monkeypatch.setattr(command_tower, "_validated_session_dir", lambda root, raw: session_dir)

    resolved = command_tower.resolve_session_for_requester("actor", session_id=nullish_value)
    assert resolved is not None
    assert resolved[0] == "ss-owned"
    assert resolved[1] == session_dir


def test_normalize_optional_session_id_edges() -> None:
    assert command_tower._normalize_optional_session_id(None) is None
    assert command_tower._normalize_optional_session_id("null") is None
    assert command_tower._normalize_optional_session_id(" None ") is None
    assert command_tower._normalize_optional_session_id("   ") == ""
    assert command_tower._normalize_optional_session_id("ss_valid") == "ss_valid"


def test_runtime_root_falls_back_when_override_resolve_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(command_tower, "_RUNTIME_AUTOMATION_ROOT", tmp_path)
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", "~/bad-runtime")

    def _boom(self: Path) -> Path:
        raise OSError("cannot resolve")

    monkeypatch.setattr(command_tower.Path, "resolve", _boom)
    assert command_tower.runtime_root() == tmp_path


def test_load_latest_flow_draft_edges(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(command_tower, "resolve_latest_session", lambda: None)
    assert command_tower.load_latest_flow_draft() is None

    session_dir = tmp_path / "s1"
    session_dir.mkdir(parents=True)
    monkeypatch.setattr(
        command_tower,
        "resolve_session_for_requester",
        lambda requester, session_id=None: ("s1", session_dir),
    )

    assert command_tower.load_latest_flow_draft("actor") is None

    flow_draft = session_dir / "flow-draft.json"
    flow_draft.write_text("{ bad json", encoding="utf-8")
    assert command_tower.load_latest_flow_draft("actor") is None

    flow_draft.write_text("[]", encoding="utf-8")
    assert command_tower.load_latest_flow_draft("actor") is None


def test_latest_flow_preview_handles_invalid_timestamp_and_selector_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flow = {
        "start_url": "https://example.com",
        "generated_at": "not-an-iso-value",
        "source_event_count": "not-int",
        "steps": [
            {
                "step_id": "s1",
                "action": "click",
                "target": {"selectors": ["#bad-shape"]},
            }
        ],
    }
    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: ("session-a", Path("/tmp"), flow),
    )

    preview = command_tower.latest_flow_preview("actor")
    assert preview.session_id == "session-a"
    assert preview.generated_at is None
    assert preview.source_event_count == 0
    assert preview.steps[0].selector is None


def test_read_step_result_edge_paths(tmp_path: Path) -> None:
    result_path = tmp_path / "replay-flow-result.json"

    assert command_tower.read_step_result(tmp_path, "replay-flow-result.json", "s1") is None

    result_path.write_text("{ malformed", encoding="utf-8")
    assert command_tower.read_step_result(tmp_path, "replay-flow-result.json", "s1") is None

    result_path.write_text("[]", encoding="utf-8")
    assert command_tower.read_step_result(tmp_path, "replay-flow-result.json", "s1") is None

    result_path.write_text(json.dumps({"stepResults": "invalid"}), encoding="utf-8")
    assert command_tower.read_step_result(tmp_path, "replay-flow-result.json", "s1") is None

    result_path.write_text(
        json.dumps({"stepResults": [{"step_id": "s-other", "action": "click"}]}),
        encoding="utf-8",
    )
    assert command_tower.read_step_result(tmp_path, "replay-flow-result.json", "s1") is None


def test_timeline_limit_and_reader_early_returns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_MAX_LIMIT", "not-an-int")
    assert command_tower._timeline_max_limit() == 300

    session_dir = tmp_path / "session"
    session_dir.mkdir(parents=True)
    replay_result = session_dir / "replay-flow-result.json"

    assert command_tower.read_timeline_items(session_dir) == []

    replay_result.write_text("{ malformed", encoding="utf-8")
    assert command_tower.read_timeline_items(session_dir) == []

    replay_result.write_text("[]", encoding="utf-8")
    assert command_tower.read_timeline_items(session_dir) == []

    replay_result.write_text(json.dumps({"stepResults": "invalid"}), encoding="utf-8")
    assert command_tower.read_timeline_items(session_dir) == []


def test_safe_screenshot_path_and_to_data_url_invalid_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session_dir = tmp_path / "session"
    evidence_dir = session_dir / "evidence"
    evidence_dir.mkdir(parents=True)

    file_path = evidence_dir / "image.bin"
    file_path.write_bytes(b"xx")

    assert (
        command_tower._safe_screenshot_path(session_dir, "evidence/../evidence/image.bin") is None
    )

    folder_path = evidence_dir / "folder"
    folder_path.mkdir(parents=True)
    assert command_tower._safe_screenshot_path(session_dir, "evidence/folder") is None

    original_resolve = command_tower.Path.resolve

    def _raise_on_named_path(self: Path) -> Path:
        if self.name == "boom.bin":
            raise OSError("cannot resolve")
        return original_resolve(self)

    monkeypatch.setattr(command_tower.Path, "resolve", _raise_on_named_path)

    assert command_tower._safe_screenshot_path(session_dir, "boom.bin") is None
    assert command_tower.to_data_url(session_dir, "missing.bin") is None
    assert command_tower.to_data_url(session_dir / "not-found.bin") is None


def test_to_data_url_stat_open_read_guards_and_default_mime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    image_path = tmp_path / "image.gif"
    image_path.write_bytes(b"GIF89a")
    original_getsize = command_tower.os.path.getsize

    def _getsize_raises(target: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> int:
        if Path(os.fsdecode(target)) == image_path:
            raise OSError("stat failed")
        return original_getsize(target)

    with monkeypatch.context() as patcher:
        patcher.setattr(command_tower.os.path, "isfile", lambda target: True)
        patcher.setattr(command_tower.os.path, "getsize", _getsize_raises)
        assert command_tower.to_data_url(image_path) is None

    original_open = cast(Any, builtins.open)

    def _open_raises(target: Any, *args: Any, **kwargs: Any) -> Any:
        if Path(target) == image_path:
            raise OSError("open failed")
        return original_open(target, *args, **kwargs)

    with monkeypatch.context() as patcher:
        patcher.setattr(command_tower.os.path, "isfile", lambda target: True)
        patcher.setattr(command_tower.os.path, "getsize", lambda target: 6)
        patcher.setattr(builtins, "open", _open_raises)
        assert command_tower.to_data_url(image_path) is None

    oversized = tmp_path / "oversized.bin"
    oversized.write_bytes(b"ab")

    def _fake_getsize(target: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> int:
        if Path(os.fsdecode(target)) == oversized:
            return 2
        return original_getsize(target)

    with monkeypatch.context() as patcher:
        patcher.setenv("COMMAND_TOWER_EVIDENCE_MAX_BYTES", "1")
        patcher.setattr(command_tower.os.path, "isfile", lambda target: True)
        patcher.setattr(command_tower.os.path, "getsize", _fake_getsize)
        assert command_tower.to_data_url(oversized) is None

    assert command_tower._detect_image_mime(b"not-a-known-signature") == "image/png"
