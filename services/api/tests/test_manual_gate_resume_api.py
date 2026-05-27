from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.main import app
from app.models.run import RunLogEntry, RunRecord, RunWaitContext
from app.services.automation_service import RunningTask, automation_service
from app.services.universal_platform_service import universal_platform_service

TEST_AUTOMATION_TOKEN = "test-token-0123456789"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-manual-gate",
    },
)


@pytest.fixture(autouse=True)
def reset_manual_gate_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    access_control.reset_for_tests()


def test_resume_run_uses_canonical_resume_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_env: dict[str, str] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured_env.clear()
        captured_env.update(env_overrides)
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="resume-task-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)

    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "manual-gate-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "demo"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "resume-user"}}
    )
    run = RunRecord.model_validate(created.json()["run"])
    run.status = "waiting_user"
    run.task_id = None
    run.wait_context = RunWaitContext(
        reason_code="provider_protected_payment_step",
        resume_from_step_id="checkout",
        allowed_resume_kinds=["approval", "input"],
    )
    run.logs.append(
        RunLogEntry(
            ts=datetime.now(timezone.utc),
            level="warn",
            message="waiting for manual approval",
        )
    )
    universal_platform_service._upsert_run(run)

    resumed = client.post(
        f"/api/runs/{run.run_id}/resume",
        json={"kind": "approval", "approved": True, "confirmation_note": "approved in browser"},
    )
    assert resumed.status_code == 200
    payload = resumed.json()["run"]
    assert payload["status"] == "queued"
    assert payload["task_id"] == "resume-task-1"
    assert captured_env["FLOW_MANUAL_APPROVED"] == "true"
    assert captured_env["FLOW_RESUME_CONTEXT"] == "true"
    assert captured_env["FLOW_FROM_STEP_ID"] == "checkout"


def test_resume_run_rejects_unsupported_checkpoint_ack(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        _ = (command_id, env_overrides, requested_by)
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="checkpoint-task-1",
            command_id="automation-replay-flow",
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)

    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "checkpoint-manual-gate-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "demo"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "resume-user"}}
    )
    run = RunRecord.model_validate(created.json()["run"])
    run.status = "waiting_user"
    run.task_id = None
    run.wait_context = RunWaitContext(
        reason_code="manual_checkpoint_required",
        resume_from_step_id="checkpoint",
        allowed_resume_kinds=["approval"],
    )
    universal_platform_service._upsert_run(run)

    resumed = client.post(
        f"/api/runs/{run.run_id}/resume",
        json={"kind": "checkpoint_ack", "checkpoint_id": "cp-1"},
    )
    assert resumed.status_code == 422
    assert resumed.json()["detail"] == "checkpoint_ack is not supported by the resume endpoint"
