from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import app.api.command_tower as command_tower
import app.core.access_control as access_control
from app.core.task_store import FileTaskStore, SqlTaskStore, TaskStore, build_task_store
from app.models.automation import TaskSnapshot, TaskStatus


def _request(
    host: str = "127.0.0.1",
    path: str = "/api/automation/commands",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": headers or [],
        "client": (host, 12345),
        "server": ("testserver", 80),
    }
    return Request(scope)


def _snapshot(task_id: str, status: TaskStatus = "queued") -> TaskSnapshot:
    now = datetime.now(timezone.utc)
    return TaskSnapshot(
        task_id=task_id,
        command_id="script-pipeline-full",
        status=status,
        created_at=now,
        updated_at=now,
        output_tail="",
    )


def test_requester_id_and_local_client_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    request = _request(
        host="8.8.8.8",
        headers=[(b"x-automation-client-id", b"pytest-client")],
    )
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "expected")
    assert access_control.requester_id(request, "client-token").startswith("token:")
    assert access_control.requester_id(request, None) == "8.8.8.8:pytest-client"

    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    assert access_control.requester_id(request, None) == "8.8.8.8:pytest-client"

    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "false")
    assert access_control._is_local_client(_request(host="127.0.0.1")) is False
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    assert access_control._is_local_client(_request(host="127.0.0.1")) is True


def test_check_token_and_redis_rate_limit_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    monkeypatch.delenv("AUTOMATION_REQUIRE_TOKEN", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    with pytest.raises(HTTPException) as non_local:
        access_control.check_token(_request(host="8.8.8.8"), None)
    assert non_local.value.status_code == 401

    class AllowRedis:
        def eval(self, *args, **kwargs):
            return 1

    class BlockRedis:
        def eval(self, *args, **kwargs):
            return 0

    access_control.reset_for_tests()
    monkeypatch.setenv("REDIS_URL", "redis://example.local/0")
    monkeypatch.setattr(access_control, "_REDIS_CLIENT", None)
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "")
    monkeypatch.setattr(access_control, "_create_redis_client", lambda _: AllowRedis())
    assert access_control._check_rate_limit_via_redis(_request()) is True

    monkeypatch.setattr(access_control, "_REDIS_CLIENT", BlockRedis())
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "redis://example.local/0")
    with pytest.raises(HTTPException) as limited:
        access_control._check_rate_limit_via_redis(_request())
    assert limited.value.status_code == 429


def test_task_store_base_file_and_sql_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    base = TaskStore()
    with pytest.raises(NotImplementedError):
        _ = base.kind
    with pytest.raises(NotImplementedError):
        base.load()
    with pytest.raises(NotImplementedError):
        base.upsert(_snapshot("x"))
    with pytest.raises(NotImplementedError):
        base.delete("x")
    with pytest.raises(NotImplementedError):
        base.summary()
    base.close()

    file_store = FileTaskStore(tmp_path / "tasks.json")
    file_store._save_all([_snapshot("a", "queued"), _snapshot("b", "failed")])
    assert file_store.kind == "file"
    assert file_store.summary()["failed"] == 1
    file_store.delete("a")
    remaining = file_store.load()
    assert len(remaining) == 1
    assert remaining[0].task_id == "b"

    sqlite_path = tmp_path / "store.db"
    sql_store = SqlTaskStore(f"sqlite+pysqlite:///{sqlite_path}")
    try:
        assert sql_store.kind == "sql"
        sql_store.upsert(_snapshot("sql-1", "running"))
        assert [item.task_id for item in sql_store.load()] == ["sql-1"]
        assert sql_store.summary()["running"] == 1
        sql_store.delete("sql-1")
        assert sql_store.summary()["total"] == 0
    finally:
        sql_store.close()

    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("UIQ_RUNTIME_CACHE_ROOT", raising=False)
    monkeypatch.delenv("RUNTIME_ROOT", raising=False)
    monkeypatch.delenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", raising=False)
    file_backend = build_task_store(tmp_path)
    assert isinstance(file_backend, FileTaskStore)
    assert str(file_backend._state_path).endswith(".runtime-cache/automation/tasks.json")

    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{tmp_path / 'build.db'}")
    sql_backend = build_task_store(tmp_path)
    assert isinstance(sql_backend, SqlTaskStore)
    sql_backend.close()


def test_command_tower_session_resolution_and_flow_loading(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", raising=False)
    monkeypatch.setattr(command_tower, "_RUNTIME_AUTOMATION_ROOT", tmp_path)
    latest = tmp_path / "latest-session.json"
    session_dir = tmp_path / "ss_s1"
    session_dir.mkdir(parents=True)

    assert command_tower.resolve_latest_session() is None
    latest.write_text("{ invalid json", encoding="utf-8")
    assert command_tower.resolve_latest_session() is None

    latest.write_text(json.dumps({"sessionId": "ss_s1"}), encoding="utf-8")
    assert command_tower.resolve_latest_session() == ("ss_s1", session_dir.resolve())

    latest.write_text(json.dumps({"sessionId": "ss_s1", "sessionDir": "../escape"}), encoding="utf-8")
    assert command_tower.resolve_latest_session() == ("ss_s1", session_dir.resolve())

    latest.write_text(
        json.dumps({"sessionId": "ss_s1", "sessionDir": str(session_dir)}), encoding="utf-8"
    )
    assert command_tower.resolve_latest_session() == ("ss_s1", session_dir.resolve())

    assert command_tower.load_latest_flow_draft() is None
    flow_path = session_dir / "flow-draft.json"
    flow_path.write_text("{ nope", encoding="utf-8")
    assert command_tower.load_latest_flow_draft() is None
    flow_path.write_text("[]", encoding="utf-8")
    assert command_tower.load_latest_flow_draft() is None
    flow_path.write_text(
        json.dumps({"start_url": "https://example.com", "steps": [{"action": "navigate"}]}),
        encoding="utf-8",
    )
    loaded = command_tower.load_latest_flow_draft()
    assert loaded is not None
    assert loaded[0] == "ss_s1"


def test_command_tower_normalize_and_evidence_helpers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    with pytest.raises(HTTPException) as missing_start_url:
        command_tower.normalize_flow_draft_update({"steps": []}, {})
    assert missing_start_url.value.status_code == 422
    assert missing_start_url.value.detail == "start_url is required"
    with pytest.raises(HTTPException) as invalid_steps:
        command_tower.normalize_flow_draft_update({"start_url": "https://x", "steps": "nope"}, {})
    assert invalid_steps.value.status_code == 422
    assert invalid_steps.value.detail == "steps must be a list"
    with pytest.raises(HTTPException):
        command_tower.normalize_flow_draft_update({"start_url": "https://x", "steps": [1]}, {})
    with pytest.raises(HTTPException):
        command_tower.normalize_flow_draft_update({"start_url": "https://x", "steps": [{}]}, {})

    normalized = command_tower.normalize_flow_draft_update(
        {"start_url": " https://x ", "steps": [{"action": "navigate"}]},
        {"source_event_count": 1},
    )
    assert normalized["start_url"] == "https://x"
    assert normalized["steps"][0]["step_id"] == "s1"

    session_dir = tmp_path / "session"
    session_dir.mkdir(parents=True)
    image = session_dir / "evidence.gif"
    image.write_bytes(b"GIF89aabcdef")
    (session_dir / "replay-flow-result.json").write_text(
        json.dumps(
            {
                "stepResults": [
                    "ignored",
                    {
                        "step_id": "s2",
                        "action": "click",
                        "ok": True,
                        "screenshot_path": "evidence.gif",
                        "fallback_trail": [
                            {"selector_index": "1", "kind": "css", "value": "#ok", "success": True},
                            "x",
                        ],
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    merged = command_tower.merge_step_evidence(session_dir, "s2")
    assert merged is not None
    assert merged.screenshot_before_path == "evidence.gif"
    assert merged.screenshot_before_data_url is not None

    items = command_tower.read_timeline_items(session_dir)
    assert len(items) == 1
    assert items[0].fallback_trail[0].selector_index == 1
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "1")
    assert len(command_tower.read_timeline_items(session_dir)) == 1
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "not-int")
    assert command_tower.resolve_timeline_limit(None) == 100
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "5")
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_MAX_LIMIT", "2")
    assert command_tower.resolve_timeline_limit(None) == 2
    assert command_tower.resolve_timeline_limit(99) == 2
    assert command_tower.parse_fallback_trail({"fallback_trail": "not-list"}) == []

    assert command_tower._detect_image_mime(b"\xff\xd8\xffaaa") == "image/jpeg"
    assert command_tower._detect_image_mime(b"RIFF1234WEBPmore") == "image/webp"

    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_MAX_BYTES", "not-int")
    assert command_tower._max_evidence_bytes() == 1_048_576
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_MAX_BYTES", "0")
    assert command_tower._max_evidence_bytes() == 1
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_MAX_BYTES", "4")
    assert command_tower.to_data_url(session_dir, "evidence.gif") is None


def test_command_tower_timeline_limit_truncates_items(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session_dir = tmp_path / "session"
    session_dir.mkdir(parents=True)
    (session_dir / "replay-flow-result.json").write_text(
        json.dumps(
            {
                "stepResults": [
                    {"step_id": "s1", "action": "click"},
                    {"step_id": "s2", "action": "click"},
                    {"step_id": "s3", "action": "click"},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "10")
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_MAX_LIMIT", "2")

    items = command_tower.read_timeline_items(session_dir, limit=5)
    assert [item.step_id for item in items] == ["s1", "s2"]
