from __future__ import annotations

import threading
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from fastapi import HTTPException

import app.services.universal_platform.resume as resume_module
from app.models.run import RunRecord, RunStatus, RunWaitContext
from app.services.universal_platform.resume import (
    _run_version_conflict,
    claim_run_for_resume,
    mark_run_resume_failed,
    submit_otp_and_resume,
)


def _run(
    *,
    run_id: str = "run-1",
    status: RunStatus = "waiting_otp",
    version: int = 1,
    wait_context: RunWaitContext | None = None,
) -> RunRecord:
    now = datetime.now(UTC)
    return RunRecord(
        run_id=run_id,
        template_id="tpl-1",
        status=status,
        version=version,
        wait_context=wait_context,
        created_at=now,
        updated_at=now,
    )


class FakeService:
    def __init__(self, run: RunRecord | None) -> None:
        self._lock = threading.RLock()
        self.run = run
        self.saved_expectations: list[int | None] = []
        self.audit_events: list[tuple[str, str | None, dict[str, object]]] = []
        self.params_snapshot = {"otp": "snapshotted"}
        self.resume_from_step_id: str | None = None
        self.save_result = True
        self.template: object | None = SimpleNamespace(
            flow_id="flow-1",
            policies=SimpleNamespace(otp={"required": True}),
        )
        self.flow = SimpleNamespace(start_url="https://example.com")
        self.task_status = "running"

    def get_run(self, run_id: str, requester: str | None = None) -> RunRecord:
        if self.run is None:
            raise HTTPException(status_code=404, detail="run not found")
        return self.run

    def get_template(self, template_id: str, requester: str | None = None) -> object:
        return self.template

    def get_flow(self, flow_id: str, requester: str | None = None) -> object:
        return self.flow

    def _get_validated_params_snapshot(self, run_id: str) -> dict[str, str]:
        return dict(self.params_snapshot)

    def _validate_params(
        self, template: object, params: dict[str, str], otp_policy: object
    ) -> None:
        return None

    def _build_env(self, start_url: str, params: dict[str, str], otp_value: str) -> dict[str, str]:
        env = {"START_URL": start_url}
        if otp_value:
            env["OTP_CODE"] = otp_value
        return env

    def _resolve_resume_from_step_id(self, wait_context: RunWaitContext | None) -> str | None:
        return self.resume_from_step_id

    def _load_run_locked(self, run_id: str) -> RunRecord | None:
        return self.run

    def _save_run_locked(self, run: RunRecord, expected_version: int | None = None) -> bool:
        self.saved_expectations.append(expected_version)
        self.run = run
        return self.save_result

    def _map_task_status(self, task_status: str) -> str:
        if self.task_status == "raise":
            raise RuntimeError("cannot map task")
        return self.task_status

    def _audit(self, action: str, actor: str | None, payload: dict[str, object]) -> None:
        self.audit_events.append((action, actor, payload))

    def _redact_text(self, message: str) -> str:
        return f"redacted::{message}"


def test_submit_resume_waiting_user_without_resume_step_id(monkeypatch: pytest.MonkeyPatch) -> None:
    service = FakeService(
        _run(status="waiting_user", wait_context=RunWaitContext(reason_code="manual_gate"))
    )
    captured: dict[str, object] = {}

    def fake_run_command(
        command_id: str, env: dict[str, str], requested_by: str | None = None
    ) -> object:
        captured["command_id"] = command_id
        captured["env"] = dict(env)
        captured["requested_by"] = requested_by
        return SimpleNamespace(task_id="task-1", status="running")

    monkeypatch.setattr(resume_module.automation_service, "run_command", fake_run_command)

    run = submit_otp_and_resume(service, "run-1", None, actor="owner-a")
    assert run.task_id == "task-1"
    assert run.status == "running"
    assert captured["command_id"] == "automation-replay-flow"
    assert captured["env"] == {
        "START_URL": "https://example.com",
        "FLOW_RESUME_CONTEXT": "true",
    }
    assert service.audit_events[-1][0] == "run.resume_user"


def test_submit_resume_reraises_http_errors_and_handles_missing_run_after_submit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = FakeService(_run())
    service.template = None

    with pytest.raises(HTTPException) as upstream:
        submit_otp_and_resume(service, "run-1", "123456", actor="owner-a")
    assert upstream.value.status_code == 500 or upstream.value.status_code == 404

    service = FakeService(_run())
    monkeypatch.setattr(
        resume_module.automation_service,
        "run_command",
        lambda command_id, env, requested_by=None: SimpleNamespace(
            task_id="task-2", status="queued"
        ),
    )
    service.run = None
    with pytest.raises(HTTPException) as missing_run:
        submit_otp_and_resume(service, "run-1", "123456", actor="owner-a")
    assert missing_run.value.status_code == 404


def test_submit_resume_persist_conflict_and_cancel_failure_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = FakeService(_run(status="waiting_otp"))
    monkeypatch.setattr(
        resume_module.automation_service,
        "run_command",
        lambda command_id, env, requested_by=None: SimpleNamespace(
            task_id="task-3", status="queued"
        ),
    )

    latest = _run(status="running", version=9)
    service.run = _run(status="waiting_otp")
    load_calls = {"count": 0}
    save_calls = {"count": 0}

    def conflict_after_claim(run_id: str) -> RunRecord:
        load_calls["count"] += 1
        if load_calls["count"] < 3:
            assert service.run is not None
            return service.run
        return latest

    def save_then_conflict(run: RunRecord, expected_version: int | None = None) -> bool:
        save_calls["count"] += 1
        service.saved_expectations.append(expected_version)
        service.run = run
        return save_calls["count"] == 1

    service._load_run_locked = conflict_after_claim  # type: ignore[method-assign]
    service._save_run_locked = save_then_conflict  # type: ignore[method-assign]
    monkeypatch.setattr(
        resume_module.automation_service, "cancel_task", lambda task_id, requested_by=None: None
    )

    with pytest.raises(HTTPException) as conflict:
        submit_otp_and_resume(service, "run-1", "123456", actor="owner-a")
    assert conflict.value.status_code == 409
    assert "current version=9, status=running" in conflict.value.detail

    failing_service = FakeService(_run(status="waiting_otp"))
    failing_service.task_status = "raise"
    monkeypatch.setattr(
        resume_module.automation_service,
        "run_command",
        lambda command_id, env, requested_by=None: SimpleNamespace(
            task_id="task-4", status="queued"
        ),
    )
    monkeypatch.setattr(
        resume_module.automation_service,
        "cancel_task",
        lambda task_id, requested_by=None: (_ for _ in ()).throw(RuntimeError("cancel failed")),
    )
    with pytest.raises(HTTPException) as cancel_failure:
        submit_otp_and_resume(failing_service, "run-1", "123456", actor="owner-a")
    assert cancel_failure.value.status_code == 500
    assert (
        cancel_failure.value.detail
        == "failed to persist resumed run and failed to cancel automation task"
    )


def test_claim_run_for_resume_covers_missing_conflict_and_save_failure() -> None:
    service = FakeService(None)
    with pytest.raises(HTTPException) as missing:
        claim_run_for_resume(service, "run-1", "owner-a", "123456")
    assert missing.value.status_code == 404

    hidden_missing = FakeService(_run(status="waiting_otp"))

    def _hidden_get_run(run_id: str, requester: str | None = None) -> RunRecord:
        del run_id, requester
        assert hidden_missing.run is not None
        return cast(RunRecord, hidden_missing.run)

    hidden_missing.get_run = _hidden_get_run  # type: ignore[method-assign]
    hidden_missing._load_run_locked = lambda run_id: None  # type: ignore[method-assign]
    with pytest.raises(HTTPException) as missing_locked:
        claim_run_for_resume(hidden_missing, "run-1", "owner-a", "123456")
    assert missing_locked.value.status_code == 404

    service = FakeService(_run(status="waiting_otp", version=3))
    with pytest.raises(HTTPException) as version_conflict:
        claim_run_for_resume(service, "run-1", "owner-a", "123456", expected_version=2)
    assert version_conflict.value.status_code == 409

    service = FakeService(_run(status="waiting_otp", version=4))
    service.save_result = False
    with pytest.raises(HTTPException) as save_conflict:
        claim_run_for_resume(service, "run-1", "owner-a", "123456")
    assert save_conflict.value.status_code == 409
    assert "expected 4" in save_conflict.value.detail


def test_mark_run_resume_failed_covers_missing_terminal_and_conflict_cases() -> None:
    service = FakeService(None)
    with pytest.raises(HTTPException) as missing:
        mark_run_resume_failed(service, "run-1", "failed")
    assert missing.value.status_code == 404

    success_service = FakeService(_run(status="success", version=7))
    returned = mark_run_resume_failed(success_service, "run-1", "ignored")
    assert returned.status == "success"
    assert returned.version == 7

    failed_service = FakeService(_run(status="failed", version=5))
    failed_service.save_result = False
    latest = _run(status="failed", version=9)
    failed_service._load_run_locked = lambda run_id: latest  # type: ignore[method-assign]
    returned_latest = mark_run_resume_failed(failed_service, "run-1", "boom token=abc")
    assert returned_latest.version == 9

    missing_latest_service = FakeService(_run(status="waiting_otp", version=2))
    missing_latest_service.save_result = False
    calls = {"count": 0}

    def missing_after_conflict(run_id: str) -> RunRecord | None:
        calls["count"] += 1
        return missing_latest_service.run if calls["count"] == 1 else None

    missing_latest_service._load_run_locked = missing_after_conflict  # type: ignore[method-assign]
    with pytest.raises(HTTPException) as missing_latest:
        mark_run_resume_failed(missing_latest_service, "run-1", "boom")
    assert missing_latest.value.status_code == 404


def test_run_version_conflict_reports_current_version() -> None:
    service = FakeService(_run(version=11))
    error = _run_version_conflict(service, "run-1", expected=3)
    assert error.status_code == 409
    assert error.detail == "run version conflict: expected 3, current 11"
