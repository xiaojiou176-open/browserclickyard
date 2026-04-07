from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

import app.services.universal_platform_service as service_module
from app.models.automation import (
    ReconstructionGenerateRequest,
    ReconstructionPreviewResponse,
)
from app.models.flow import FlowRecord, SessionRecord
from app.models.run import RunRecord
from app.models.template import TemplatePolicies, TemplateRecord
from app.services.universal_platform_service import UniversalPlatformService


def _new_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> UniversalPlatformService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("UNIVERSAL_PLATFORM_DATA_DIR", str(runtime_root / "universal"))
    return UniversalPlatformService()


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _make_run(
    *,
    run_id: str,
    template_id: str = "tp-test",
    version: int = 1,
    status: str = "queued",
) -> RunRecord:
    now = datetime.now(UTC)
    return RunRecord(
        run_id=run_id,
        template_id=template_id,
        version=version,
        status=status,  # type: ignore[arg-type]
        params={},
        created_at=now,
        updated_at=now,
    )


def _make_template(
    *,
    template_id: str = "tp-test",
    flow_id: str = "fl-test",
    created_by: str | None = "owner-a",
) -> TemplateRecord:
    now = datetime.now(UTC)
    return TemplateRecord(
        template_id=template_id,
        flow_id=flow_id,
        name="template",
        params_schema=[],
        defaults={},
        policies=TemplatePolicies.model_validate(
            {"otp": {"required": False, "provider": "manual"}}
        ),
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )


def _make_flow(flow_id: str = "fl-test", session_id: str = "ss-test") -> FlowRecord:
    now = datetime.now(UTC)
    return FlowRecord(
        flow_id=flow_id,
        session_id=session_id,
        start_url="https://example.com",
        steps=[],
        created_at=now,
        updated_at=now,
    )


def test_import_latest_flow_draft_failure_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    latest_pointer = service._runtime_root / "latest-session.json"

    with pytest.raises(HTTPException) as missing_pointer:
        service.import_latest_flow_draft()
    assert missing_pointer.value.status_code == 404

    latest_pointer.parent.mkdir(parents=True, exist_ok=True)
    latest_pointer.write_text("{bad json", encoding="utf-8")
    with pytest.raises(HTTPException) as pointer_invalid:
        service.import_latest_flow_draft()
    assert pointer_invalid.value.status_code == 500

    _write_json(latest_pointer, {"sessionId": "ss-x"})
    with pytest.raises(HTTPException) as pointer_missing_keys:
        service.import_latest_flow_draft()
    assert pointer_missing_keys.value.status_code == 500

    session_dir = service._runtime_root / "sess-x"
    session_dir.mkdir(parents=True, exist_ok=True)
    _write_json(latest_pointer, {"sessionId": "ss-x", "sessionDir": str(session_dir)})

    calls = {"count": 0}

    def _runtime_check(_path: Path) -> bool:
        calls["count"] += 1
        return calls["count"] == 1

    monkeypatch.setattr(service, "_is_within_runtime_root", _runtime_check)
    with pytest.raises(HTTPException) as flow_path_outside:
        service.import_latest_flow_draft()
    assert flow_path_outside.value.status_code == 400
    assert "latest flow path is outside runtime root" in flow_path_outside.value.detail

    monkeypatch.setattr(service, "_is_within_runtime_root", lambda _path: True)
    with pytest.raises(HTTPException) as no_draft:
        service.import_latest_flow_draft()
    assert no_draft.value.status_code == 404

    draft = session_dir / "flow-draft.json"
    draft.write_text("{bad json", encoding="utf-8")
    with pytest.raises(HTTPException) as draft_invalid_json:
        service.import_latest_flow_draft()
    assert draft_invalid_json.value.status_code == 500

    _write_json(draft, ["not", "dict"])
    with pytest.raises(HTTPException) as draft_invalid_format:
        service.import_latest_flow_draft()
    assert draft_invalid_format.value.status_code == 500

    _write_json(draft, {"start_url": "https://example.com"})
    with pytest.raises(HTTPException) as draft_missing_fields:
        service.import_latest_flow_draft()
    assert draft_missing_fields.value.status_code == 422

    now = datetime.now(UTC).isoformat()
    _write_json(
        service._sessions_path,
        [
            {
                "session_id": "ss-x",
                "start_url": "https://example.com",
                "mode": "manual",
                "owner": "owner-a",
                "started_at": now,
            }
        ],
    )
    _write_json(
        draft,
        {
            "start_url": "https://example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        },
    )
    with pytest.raises(HTTPException) as owner_denied:
        service.import_latest_flow_draft(owner="owner-b")
    assert owner_denied.value.status_code == 403


def test_session_flow_access_and_update_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as empty_url:
        service.start_session(" ", "manual")
    assert empty_url.value.status_code == 422

    with pytest.raises(HTTPException) as bad_mode:
        service.start_session("https://example.com", "weird")
    assert bad_mode.value.status_code == 422

    session = service.start_session("https://example.com", "midscene", owner="owner-a")
    assert session.mode == "ai"
    assert len(service.list_sessions(limit=0, requester="owner-a")) == 1

    with pytest.raises(HTTPException) as missing_session:
        service.get_session("ss-missing")
    assert missing_session.value.status_code == 404

    with pytest.raises(HTTPException) as denied_session:
        service.get_session(session.session_id, requester="owner-b")
    assert denied_session.value.status_code == 403

    with pytest.raises(HTTPException) as denied_finish:
        service.finish_session(session.session_id, owner="owner-b")
    assert denied_finish.value.status_code == 403

    finished = service.finish_session(session.session_id, owner="owner-a")
    assert finished.finished_at is not None

    with pytest.raises(HTTPException) as missing_finish:
        service.finish_session("ss-missing", owner="owner-a")
    assert missing_finish.value.status_code == 404

    with pytest.raises(HTTPException) as missing_flow_session:
        service.create_flow(
            session_id="ss-missing",
            start_url="https://example.com",
            steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
            requester="owner-a",
        )
    assert missing_flow_session.value.status_code == 404

    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        requester="owner-a",
    )
    assert service.list_flows(limit=0, requester="owner-b") == []
    assert len(service.list_flows(limit=0, requester="owner-a")) == 1

    with pytest.raises(HTTPException) as missing_flow:
        service.get_flow("fl-missing", requester="owner-a")
    assert missing_flow.value.status_code == 404

    with pytest.raises(HTTPException) as update_conflict:
        service.update_flow(flow.flow_id, expected_version=999, requester="owner-a")
    assert update_conflict.value.status_code == 409

    updated = service.update_flow(flow.flow_id, start_url="   ", requester="owner-a")
    assert updated.start_url == "https://example.com"

    with pytest.raises(HTTPException) as invalid_steps:
        service.update_flow(flow.flow_id, steps=[{}], requester="owner-a")
    assert invalid_steps.value.status_code == 422
    detail = invalid_steps.value.detail
    assert isinstance(detail, dict)
    assert detail.get("message") == "invalid flow steps payload"

    with pytest.raises(HTTPException) as update_missing:
        service.update_flow("fl-missing", requester="owner-a")
    assert update_missing.value.status_code == 404


def test_save_run_locked_and_load_branches(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    service = _new_service(monkeypatch, tmp_path)

    run = _make_run(run_id="rn-1", status="success")
    assert service._save_run_locked(run, extras={"legacy": "keep"}, expected_version=0) is True

    changed = _make_run(run_id="rn-1", version=2, status="failed")
    assert service._save_run_locked(changed, expected_version=999) is False
    assert service._save_run_locked(changed, expected_version=1) is False
    assert (
        service._save_run_locked(changed, expected_version=1, forbid_terminal_regression=False)
        is True
    )

    stored = service._read_json_unlocked(service._runs_path)
    assert stored[0]["legacy"] == "keep"

    assert service._save_run_locked(_make_run(run_id="rn-2"), expected_version=2) is False
    assert service._load_run_locked("rn-missing") is None


def test_cache_snapshot_and_non_negative_env_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)

    assert service._normalize_snapshot_params(None) == {}
    assert service._normalize_snapshot_params({1: "x", "ok": 2}) == {"ok": ""}

    now = time.time()
    service._cache_ttl_seconds = 0
    service._cache_max_entries = 1
    service._validated_params_cache = {
        "run-a": (now - 10, {"a": "1"}),
        "run-b": (now - 5, {"b": "2"}),
        "run-c": (now - 1, {"c": "3"}),
    }
    service._prune_validated_params_cache_locked(now_ts=now)
    assert set(service._validated_params_cache.keys()) == {"run-c"}

    monkeypatch.setenv("CACHE_EMPTY", "")
    assert service._read_non_negative_int_env("CACHE_EMPTY", 7) == 7


def test_audit_rotation_prune_and_write_failure_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    service._audit_max_bytes = 1
    service._audit_backup_count = 2
    service._audit_retention_days = 1

    service._audit_path.parent.mkdir(parents=True, exist_ok=True)
    service._audit_path.write_text("active", encoding="utf-8")
    backup_1 = service._audit_path.with_name(f"{service._audit_path.name}.1")
    backup_2 = service._audit_path.with_name(f"{service._audit_path.name}.2")
    backup_1.write_text("backup-1", encoding="utf-8")
    backup_2.write_text("backup-2", encoding="utf-8")

    service._rotate_audit_if_needed(50)
    assert backup_1.exists()
    assert backup_2.exists()

    old_ts = time.time() - (10 * 24 * 60 * 60)
    for candidate in (service._audit_path, backup_1, backup_2):
        if candidate.exists():
            os.utime(candidate, (old_ts, old_ts))
    service._prune_audit_history()
    assert not service._audit_path.exists()
    assert not backup_1.exists()
    assert not backup_2.exists()

    before = service._audit_write_failures

    def _raise_oserror(_incoming_bytes: int) -> None:
        raise OSError("forced failure")

    monkeypatch.setattr(service, "_rotate_audit_if_needed", _raise_oserror)
    service._audit("unit.test", None, {"token": "abc123"})
    assert service._audit_write_failures == before + 1


def test_template_owner_run_owner_and_access_fallback_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)

    template = _make_template(template_id="tp-owner", created_by=None)
    flow = _make_flow(flow_id="fl-owner")
    monkeypatch.setattr(service, "get_flow", lambda _flow_id: flow)
    monkeypatch.setattr(service, "_flow_owner", lambda _flow: "owner-fallback")
    assert service._template_owner(template) == "owner-fallback"

    run = _make_run(run_id="rn-owner", template_id="tp-missing")
    monkeypatch.setattr(
        service,
        "get_template",
        lambda *_a, **_k: (_ for _ in ()).throw(HTTPException(status_code=404, detail="missing")),
    )
    _write_json(service._runs_path, [{"run_id": "rn-owner", "owner": "owner-from-run"}])
    assert service._run_owner(run) == "owner-from-run"

    _write_json(service._runs_path, [{"run_id": "rn-owner"}])
    assert service._run_owner(run) is None

    session = SessionRecord(
        session_id="ss-x",
        start_url="https://example.com",
        mode="manual",
        owner="owner-a",
        started_at=datetime.now(UTC),
    )
    service._ensure_session_access(session, None)
    service._ensure_flow_access(flow, None)


def test_generate_reconstruction_preview_validation_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as missing_preview:
        service.generate_reconstruction(ReconstructionGenerateRequest())
    assert missing_preview.value.status_code == 422

    invalid_preview = ReconstructionPreviewResponse(
        preview_id="pv-invalid",
        flow_draft={"steps": []},
        reconstructed_flow_quality=1,
    )
    monkeypatch.setattr(
        service_module.video_reconstruction_service,
        "load_preview",
        lambda _preview_id: invalid_preview,
    )
    with pytest.raises(HTTPException) as invalid_draft:
        service.generate_reconstruction(
            ReconstructionGenerateRequest(preview_id="pv-invalid", template_name="tmp")
        )
    assert invalid_draft.value.status_code == 422
