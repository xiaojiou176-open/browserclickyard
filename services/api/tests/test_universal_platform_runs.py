from __future__ import annotations

import json
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.models.run import RunRecord, RunWaitContext
from app.main import app
from app.services.automation_service import RunningTask, automation_service
from app.services.universal_platform_service import universal_platform_service

TEST_AUTOMATION_TOKEN = "test-token-0123456789"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-universal",
    },
)


@pytest.fixture(autouse=True)
def reset_universal_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    access_control.reset_for_tests()
    universal_dir = Path(os.environ.get("UNIVERSAL_PLATFORM_DATA_DIR", ""))
    if not universal_dir:
        root = Path(__file__).resolve().parents[3]
        universal_dir = root / ".runtime-cache" / "automation" / "universal"
    if universal_dir.exists():
        shutil.rmtree(universal_dir)


def _mock_run_command(monkeypatch: pytest.MonkeyPatch) -> None:
    counter = {"n": 0}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        counter["n"] += 1
        now = datetime.now(timezone.utc)
        task_id = f"mock-task-{counter['n']}"
        return RunningTask(
            task_id=task_id,
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
            message=f"mocked with env keys={sorted(env_overrides.keys())}",
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)


def test_otp_resume_reuses_run_snapshot_not_template_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_env: dict[str, str] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured_env.clear()
        captured_env.update(env_overrides)
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="mock-task-snapshot",
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
            "name": "otp-snapshot",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "default-name"},
            "policies": {
                "otp": {"required": True, "provider": "manual", "regex": "\\b(\\d{6})\\b"}
            },
        },
    ).json()["template_id"]
    run_id = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "snapshot-name"}}
    ).json()["run"]["run_id"]
    assert (
        client.patch(
            f"/api/templates/{template_id}", json={"defaults": {"username": "changed-default"}}
        ).status_code
        == 200
    )
    resumed = client.post(f"/api/runs/{run_id}/otp", json={"otp_code": "123456"})
    assert resumed.status_code == 200
    assert captured_env.get("FLOW_INPUT") == "snapshot-name"


def test_universal_matrix_otp_manual_resume(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com/register", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com/register",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://example.com/register"},
                {"step_id": "s2", "action": "type", "value_ref": "${params.otp}"},
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "otp-template",
            "params_schema": [{"key": "otp", "type": "secret", "required": True}],
            "defaults": {},
            "policies": {
                "otp": {"required": True, "provider": "manual", "regex": "\\b(\\d{6})\\b"}
            },
        },
    ).json()["template_id"]

    first_run = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert first_run.status_code == 200
    run_id = first_run.json()["run"]["run_id"]
    assert first_run.json()["run"]["status"] == "waiting_otp"
    assert first_run.json()["run"]["task_id"] is None
    assert "validated_params_snapshot" not in first_run.json()["run"]

    resume_without_code = client.post(f"/api/runs/{run_id}/otp", json={})
    assert resume_without_code.status_code == 422
    assert resume_without_code.json()["detail"] == "otp_code is required"

    resume = client.post(f"/api/runs/{run_id}/otp", json={"otp_code": "123456"})
    assert resume.status_code == 200
    assert resume.json()["run"]["status"] == "queued"
    assert resume.json()["run"]["task_id"] is not None
    assert "validated_params_snapshot" not in resume.json()["run"]


def test_universal_sessions_finish_and_list() -> None:
    first = client.post(
        "/api/sessions/start", json={"start_url": "https://a.example.com", "mode": "manual"}
    )
    second = client.post(
        "/api/sessions/start", json={"start_url": "https://b.example.com", "mode": "ai"}
    )
    assert first.status_code == 200
    assert second.status_code == 200
    session_id = first.json()["session_id"]

    finished = client.post(f"/api/sessions/{session_id}/finish")
    assert finished.status_code == 200
    assert finished.json()["finished_at"] is not None

    listed = client.get("/api/sessions?limit=10")
    assert listed.status_code == 200
    assert len(listed.json()["sessions"]) >= 2


def test_universal_finish_session_rejects_invalid_session_id_pattern() -> None:
    response = client.post("/api/sessions/not-a-session-id/finish")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "session_id" for item in response.json()["detail"])


def test_universal_get_run_rejects_invalid_run_id_pattern() -> None:
    response = client.get("/api/runs/not-a-run-id")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "run_id" for item in response.json()["detail"])


def test_universal_cancel_run_accepts_literal_null_expected_version() -> None:
    response = client.post(
        "/api/runs/rn_00000000000000000000000000000000/cancel?expected_version=null"
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "run not found"


def test_universal_run_otp_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://x.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://x.example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://x.example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "non-otp-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "a"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run_id = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "b"}}
    ).json()["run"]["run_id"]
    otp = client.post(f"/api/runs/{run_id}/otp", json={"otp_code": "123456"})
    assert otp.status_code == 409


def test_universal_run_otp_resume_concurrent_only_one_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: dict[str, int] = {"count": 0}
    calls_lock = threading.Lock()

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        with calls_lock:
            calls["count"] += 1
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id=f"concurrent-task-{calls['count']}",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)

    session = universal_platform_service.start_session(
        "https://otp-concurrency.example.com", "manual", owner="owner-a"
    )
    flow = universal_platform_service.create_flow(
        session_id=session.session_id,
        start_url="https://otp-concurrency.example.com",
        steps=[
            {"step_id": "s1", "action": "navigate", "url": "https://otp-concurrency.example.com"}
        ],
        requester="owner-a",
    )
    template = universal_platform_service.create_template(
        flow_id=flow.flow_id,
        name="otp-concurrency",
        params_schema=[{"key": "otp", "type": "secret", "required": True}],
        defaults={},
        policies={"otp": {"required": True, "provider": "manual", "regex": r"\b(\d{6})\b"}},
        created_by="owner-a",
    )
    run = universal_platform_service.create_run(template.template_id, params={}, actor="owner-a")
    assert run.status == "waiting_otp"

    barrier = threading.Barrier(2)
    results: list[tuple[str, int | str]] = []
    results_lock = threading.Lock()

    def worker() -> None:
        barrier.wait()
        try:
            resumed = universal_platform_service.submit_otp_and_resume(
                run.run_id, "123456", actor="owner-a"
            )
            with results_lock:
                results.append(("ok", resumed.status))
        except HTTPException as exc:
            with results_lock:
                results.append(("err", exc.status_code))

    threads = [threading.Thread(target=worker), threading.Thread(target=worker)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert len(results) == 2
    assert ("ok", "queued") in results
    assert ("err", 409) in results
    assert calls["count"] == 1


def test_cancelled_run_sync_does_not_regress_and_clears_runtime_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://cancel-sync.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://cancel-sync.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://cancel-sync.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "cancel-sync-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert created.status_code == 200
    run_id = created.json()["run"]["run_id"]
    task_id = created.json()["run"]["task_id"]
    assert task_id is not None

    with universal_platform_service._lock:
        run = universal_platform_service._load_run_locked(run_id)
        assert run is not None
        run.wait_context = RunWaitContext(reason_code="manual_gate")
        universal_platform_service._save_run_locked(run)

    cancelled = client.post(f"/api/runs/{run_id}/cancel")
    assert cancelled.status_code == 200
    cancelled_run = cancelled.json()["run"]
    assert cancelled_run["status"] == "cancelled"
    assert cancelled_run["task_id"] is None
    assert cancelled_run["wait_context"] is None

    with universal_platform_service._lock:
        stale = universal_platform_service._load_run_locked(run_id)
        assert stale is not None
        stale.task_id = task_id
        stale.wait_context = RunWaitContext(reason_code="stale_wait")
        universal_platform_service._save_run_locked(stale)

    def should_not_query_task(_task_id: str, requested_by: str | None = None):
        raise AssertionError("sync_run_status should not query task for cancelled run")

    monkeypatch.setattr(automation_service, "get_task", should_not_query_task)

    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    fetched_run = fetched.json()["run"]
    assert fetched_run["status"] == "cancelled"
    assert fetched_run["task_id"] is None
    assert fetched_run["wait_context"] is None


def test_cancel_resume_race_keeps_cancelled_and_rolls_back_resume_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume_submitted = threading.Event()
    allow_resume_return = threading.Event()
    cancelled_tasks: list[str] = []

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        resume_submitted.set()
        assert allow_resume_return.wait(timeout=5)
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="resume-race-task",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    def fake_cancel_task(task_id: str, requested_by: str | None = None):
        cancelled_tasks.append(task_id)
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="cancelled",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)
    monkeypatch.setattr(automation_service, "cancel_task", fake_cancel_task)

    session = universal_platform_service.start_session(
        "https://cancel-resume-race.example.com", "manual", owner="owner-race"
    )
    flow = universal_platform_service.create_flow(
        session_id=session.session_id,
        start_url="https://cancel-resume-race.example.com",
        steps=[
            {"step_id": "s1", "action": "navigate", "url": "https://cancel-resume-race.example.com"}
        ],
        requester="owner-race",
    )
    template = universal_platform_service.create_template(
        flow_id=flow.flow_id,
        name="cancel-resume-race-template",
        params_schema=[{"key": "otp", "type": "secret", "required": True}],
        defaults={},
        policies={"otp": {"required": True, "provider": "manual", "regex": r"\b(\d{6})\b"}},
        created_by="owner-race",
    )
    run = universal_platform_service.create_run(template.template_id, params={}, actor="owner-race")
    assert run.status == "waiting_otp"

    resume_result: dict[str, str | int] = {}

    def resume_worker() -> None:
        try:
            universal_platform_service.submit_otp_and_resume(
                run.run_id, "123456", actor="owner-race"
            )
            resume_result["status"] = 200
        except HTTPException as exc:
            resume_result["status"] = exc.status_code
            resume_result["detail"] = str(exc.detail)

    thread = threading.Thread(target=resume_worker)
    thread.start()
    assert resume_submitted.wait(timeout=5)

    cancelled = universal_platform_service.cancel_run(run.run_id, actor="owner-race")
    assert cancelled.status == "cancelled"
    allow_resume_return.set()

    thread.join(timeout=5)
    assert not thread.is_alive()
    assert resume_result["status"] == 409
    assert "resume-race-task" in cancelled_tasks

    final_run = universal_platform_service.get_run(run.run_id, requester="owner-race")
    assert final_run.status == "cancelled"
    assert final_run.task_id is None


def test_universal_run_step_logs_visualized_from_task_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://steps.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://steps.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://steps.example.com"},
                {"step_id": "s2", "action": "click"},
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "step-log-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run = client.post("/api/runs", json={"template_id": template_id, "params": {}}).json()["run"]
    run_id = run["run_id"]
    task_id = run["task_id"]
    assert task_id
    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="success",
            created_at=now,
            output_lines=[
                json.dumps(
                    {
                        "stepResults": [
                            {"step_id": "s1", "action": "navigate", "ok": True, "detail": "ok"},
                            {
                                "step_id": "s2",
                                "action": "click",
                                "ok": False,
                                "detail": "selector missing",
                            },
                        ]
                    }
                )
            ],
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    payload = fetched.json()["run"]
    assert payload["step_cursor"] == 2
    assert any("step s1" in item["message"] for item in payload["logs"])
    assert any("step s2" in item["message"] for item in payload["logs"])


def test_manual_gate_maps_waiting_user_with_wait_context(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://gate.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://gate.example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://gate.example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "manual-gate-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run_payload = client.post("/api/runs", json={"template_id": template_id, "params": {}}).json()[
        "run"
    ]
    run_id = run_payload["run_id"]
    task_id = run_payload["task_id"]
    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="running",
            created_at=now,
            output_lines=[
                json.dumps(
                    {
                        "stepResults": [
                            {"step_id": "s1", "action": "navigate", "ok": True, "detail": "ok"}
                        ],
                        "manualGate": {
                            "reasonCode": "captcha_required",
                            "atStepId": "s2",
                            "afterStepId": "s1",
                            "resumeFromStepId": "s3",
                            "resumeHint": "complete captcha then resume",
                            "providerDomain": "gate.example.com",
                            "gateRequiredByPolicy": True,
                        },
                    }
                )
            ],
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    payload = fetched.json()["run"]
    assert payload["status"] == "waiting_user"
    assert payload["task_id"] is None
    assert payload["wait_context"]["reason_code"] == "captcha_required"
    assert payload["wait_context"]["at_step_id"] == "s2"
    assert payload["wait_context"]["after_step_id"] == "s1"
    assert payload["wait_context"]["resume_from_step_id"] == "s3"
    assert payload["wait_context"]["resume_hint"] == "complete captcha then resume"
    assert payload["wait_context"]["provider_domain"] == "gate.example.com"
    assert payload["wait_context"]["gate_required_by_policy"] is True
    assert payload["wait_context"]["allowed_resume_kinds"] == ["approval", "input"]
    assert payload["wait_context"]["evidence_refs"] == []
    assert len(payload["wait_context"]["required_actions"]) >= 1


def test_waiting_user_can_resume_without_otp_code(monkeypatch: pytest.MonkeyPatch) -> None:
    env_calls: list[dict[str, str]] = []

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        env_calls.append(dict(env_overrides))
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id=f"manual-gate-resume-{len(env_calls)}",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)

    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://resume.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://resume.example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://resume.example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "manual-gate-resume-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "runner"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run_payload = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "runner"}}
    ).json()["run"]
    run_id = run_payload["run_id"]
    task_id = run_payload["task_id"]
    assert len(env_calls) == 1
    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="running",
            created_at=now,
            output_lines=[
                json.dumps(
                    {
                        "stepResults": [
                            {"step_id": "s1", "action": "navigate", "ok": True, "detail": "ok"}
                        ],
                        "manualGate": {
                            "reasonCode": "need_manual_confirmation",
                            "resumeFromStepId": "s9",
                            "resumeHint": "confirm action then resume",
                        },
                    }
                )
            ],
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    waiting = client.get(f"/api/runs/{run_id}")
    assert waiting.status_code == 200
    assert waiting.json()["run"]["status"] == "waiting_user"

    resumed = client.post(f"/api/runs/{run_id}/otp", json={})
    assert resumed.status_code == 200
    assert resumed.json()["run"]["status"] == "queued"
    assert resumed.json()["run"]["task_id"] == "manual-gate-resume-2"
    assert len(env_calls) == 2
    assert env_calls[1]["FLOW_RESUME_CONTEXT"] == "true"
    assert env_calls[1]["FLOW_FROM_STEP_ID"] == "s9"


def test_create_run_accepts_camel_case_payload_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://camel.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://camel.example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://camel.example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "camel-case-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]

    created = client.post(
        "/api/runs",
        json={
            "templateId": template_id,
            "sessionId": "ss_legacy_contract",
            "params": {"username": 123},
        },
    )
    assert created.status_code == 200
    payload = created.json()
    assert "run" in payload
    assert payload["run"]["template_id"] == template_id
    assert payload["run"]["status"] == "queued"


def test_submit_run_otp_accepts_otp_code_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://otp-alias.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://otp-alias.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://otp-alias.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "otp-alias-template",
            "params_schema": [{"key": "otp", "type": "secret", "required": True}],
            "defaults": {},
            "policies": {
                "otp": {"required": True, "provider": "manual", "regex": "\\b(\\d{6})\\b"}
            },
        },
    ).json()["template_id"]
    run_id = client.post("/api/runs", json={"template_id": template_id, "params": {}}).json()[
        "run"
    ]["run_id"]

    resumed = client.post(f"/api/runs/{run_id}/otp", json={"otpCode": "123456"})
    assert resumed.status_code == 200
    assert resumed.json()["run"]["status"] == "queued"


def test_run_sync_maps_unknown_task_status_to_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://status-sync.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://status-sync.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://status-sync.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "status-sync-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run_payload = client.post("/api/runs", json={"template_id": template_id, "params": {}}).json()[
        "run"
    ]
    run_id = run_payload["run_id"]
    task_id = run_payload["task_id"]

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return SimpleNamespace(task_id=task_id, status="unknown-status", output_tail="")

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    run = fetched.json()["run"]
    assert run["status"] == "failed"
    assert any("status synced to failed" in entry["message"] for entry in run["logs"])


def test_waiting_user_resume_submit_failure_transitions_run_to_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://manual-fail.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://manual-fail.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://manual-fail.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "manual-fail-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    run_payload = client.post("/api/runs", json={"template_id": template_id, "params": {}}).json()[
        "run"
    ]
    run_id = run_payload["run_id"]
    task_id = run_payload["task_id"]
    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="running",
            created_at=now,
            output_lines=[
                json.dumps(
                    {
                        "stepResults": [
                            {"step_id": "s1", "action": "navigate", "ok": True, "detail": "ok"}
                        ],
                        "manualGate": {
                            "reasonCode": "manual_confirmation_required",
                            "resumeFromStepId": "s2",
                        },
                    }
                )
            ],
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    waiting = client.get(f"/api/runs/{run_id}")
    assert waiting.status_code == 200
    assert waiting.json()["run"]["status"] == "waiting_user"

    def fail_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        raise RuntimeError("queue offline")

    monkeypatch.setattr(automation_service, "run_command", fail_run_command)
    resumed = client.post(f"/api/runs/{run_id}/otp", json={})
    assert resumed.status_code == 500
    assert resumed.json()["detail"] == "failed to submit otp resume run"

    failed = client.get(f"/api/runs/{run_id}")
    assert failed.status_code == 200
    run = failed.json()["run"]
    assert run["status"] == "failed"
    assert any("resume submit failed" in entry["message"] for entry in run["logs"])


def test_flow_update_rejects_stale_expected_version(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://cas-flow.example.com", "mode": "manual"}
    ).json()["session_id"]
    created = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://cas-flow.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://cas-flow.example.com"}
            ],
        },
    )
    assert created.status_code == 200
    flow = created.json()
    flow_id = flow["flow_id"]
    assert flow["version"] == 1

    updated = client.patch(
        f"/api/flows/{flow_id}",
        json={"start_url": "https://cas-flow-updated.example.com", "expected_version": 1},
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    stale = client.patch(
        f"/api/flows/{flow_id}",
        json={"start_url": "https://cas-flow-stale.example.com", "expected_version": 1},
    )
    assert stale.status_code == 409
    assert "flow version conflict" in stale.json()["detail"]


def test_run_resume_rejects_stale_expected_version(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://cas-run.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://cas-run.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://cas-run.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "cas-run-template",
            "params_schema": [{"key": "otp", "type": "secret", "required": True}],
            "defaults": {},
            "policies": {
                "otp": {"required": True, "provider": "manual", "regex": "\\b(\\d{6})\\b"}
            },
        },
    ).json()["template_id"]
    created = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert created.status_code == 200
    run = created.json()["run"]
    run_id = run["run_id"]
    assert run["version"] == 1

    resumed = client.post(
        f"/api/runs/{run_id}/otp", json={"otp_code": "123456", "expected_version": 1}
    )
    assert resumed.status_code == 200
    assert resumed.json()["run"]["version"] >= 2

    stale = client.post(
        f"/api/runs/{run_id}/otp", json={"otp_code": "654321", "expected_version": 1}
    )
    assert stale.status_code == 409
    assert "run version conflict" in stale.json()["detail"]


def test_run_cancel_rejects_stale_expected_version(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://cas-cancel.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://cas-cancel.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://cas-cancel.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "cas-cancel-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert created.status_code == 200
    run = created.json()["run"]
    run_id = run["run_id"]
    assert run["version"] == 1

    cancelled = client.post(f"/api/runs/{run_id}/cancel?expected_version=1")
    assert cancelled.status_code == 200
    assert cancelled.json()["run"]["version"] == 2

    stale = client.post(f"/api/runs/{run_id}/cancel?expected_version=1")
    assert stale.status_code == 409
    assert "run version conflict" in stale.json()["detail"]


def test_sync_stale_snapshot_cannot_override_cancelled_terminal_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://stale-cancelled.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://stale-cancelled.example.com",
            "steps": [
                {
                    "step_id": "s1",
                    "action": "navigate",
                    "url": "https://stale-cancelled.example.com",
                }
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "stale-cancelled-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert created.status_code == 200
    stale_snapshot = RunRecord.model_validate(created.json()["run"])
    run_id = stale_snapshot.run_id
    task_id = stale_snapshot.task_id
    assert task_id is not None

    cancelled = client.post(f"/api/runs/{run_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["run"]["status"] == "cancelled"

    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="success",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    universal_platform_service._sync_run_status(stale_snapshot)
    assert stale_snapshot.status == "cancelled"

    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    final_run = fetched.json()["run"]
    assert final_run["status"] == "cancelled"
    assert final_run["task_id"] is None


def test_sync_stale_snapshot_cannot_override_failed_terminal_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start",
        json={"start_url": "https://stale-failed.example.com", "mode": "manual"},
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://stale-failed.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://stale-failed.example.com"}
            ],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "stale-failed-template",
            "params_schema": [],
            "defaults": {},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]
    created = client.post("/api/runs", json={"template_id": template_id, "params": {}})
    assert created.status_code == 200
    stale_snapshot = RunRecord.model_validate(created.json()["run"])
    run_id = stale_snapshot.run_id
    task_id = stale_snapshot.task_id
    assert task_id is not None

    with universal_platform_service._lock:
        latest = universal_platform_service._load_run_locked(run_id)
        assert latest is not None
        previous_version = latest.version
        latest.status = "failed"
        latest.task_id = None
        latest.wait_context = None
        latest.version += 1
        latest.updated_at = datetime.now(timezone.utc)
        saved = universal_platform_service._save_run_locked(
            latest, expected_version=previous_version
        )
        assert saved

    now = datetime.now(timezone.utc)

    def fake_get_task(_task_id: str, requested_by: str | None = None):
        assert _task_id == task_id
        return RunningTask(
            task_id=task_id,
            command_id="automation-replay-flow",
            status="success",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "get_task", fake_get_task)
    universal_platform_service._sync_run_status(stale_snapshot)
    assert stale_snapshot.status == "failed"

    fetched = client.get(f"/api/runs/{run_id}")
    assert fetched.status_code == 200
    final_run = fetched.json()["run"]
    assert final_run["status"] == "failed"
    assert final_run["task_id"] is None
