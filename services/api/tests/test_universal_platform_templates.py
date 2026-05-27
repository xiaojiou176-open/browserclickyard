from __future__ import annotations

import shutil
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
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
    universal_dir = universal_platform_service._base_dir
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


def test_universal_matrix_register_like(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)

    session = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com/register", "mode": "manual"}
    )
    assert session.status_code == 200
    session_id = session.json()["session_id"]

    flow_resp = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com/register",
            "source_event_count": 10,
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://example.com/register"},
                {"step_id": "s2", "action": "type", "value_ref": "${params.email}"},
                {"step_id": "s3", "action": "type", "value_ref": "${secrets.password}"},
            ],
        },
    )
    assert flow_resp.status_code == 200
    flow_id = flow_resp.json()["flow_id"]

    template_resp = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "register-template",
            "params_schema": [
                {"key": "email", "type": "email", "required": True},
                {"key": "password", "type": "secret", "required": True},
            ],
            "defaults": {"email": "demo@example.com", "password": "secret-raw"},
            "policies": {
                "retries": 1,
                "timeout_seconds": 90,
                "otp": {"required": False, "provider": "manual"},
            },
        },
    )
    assert template_resp.status_code == 200
    template = template_resp.json()
    assert "password" not in template["defaults"]

    run_resp = client.post(
        "/api/runs",
        json={
            "template_id": template["template_id"],
            "params": {"email": "u@example.com", "password": "Strong!Pass123"},
        },
    )
    assert run_resp.status_code == 200
    run = run_resp.json()["run"]
    assert run["status"] == "queued"
    assert run["task_id"] is not None
    assert run["params"]["email"] == "u@example.com"
    assert "password" not in run["params"]
    assert "validated_params_snapshot" not in run


def test_universal_matrix_game_like_and_export_scrub(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://game.example.com/farm", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://game.example.com/farm",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://game.example.com/farm"},
                {
                    "step_id": "s2",
                    "action": "click",
                    "target": {"selectors": [{"kind": "css", "value": "#collect", "score": 80}]},
                },
                {
                    "step_id": "s3",
                    "action": "click",
                    "target": {"selectors": [{"kind": "css", "value": "#plant", "score": 76}]},
                },
            ],
        },
    ).json()["flow_id"]

    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "farm-template",
            "params_schema": [
                {"key": "username", "type": "string", "required": True},
                {"key": "password", "type": "secret", "required": True},
            ],
            "defaults": {"username": "farmer", "password": "plain-should-not-store"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]

    export_resp = client.get(f"/api/templates/{template_id}/export")
    assert export_resp.status_code == 200
    exported = export_resp.json()
    assert exported["name"] == "farm-template"
    assert exported["defaults"].get("password") in (None, "***")

    run_resp = client.post(
        "/api/runs",
        json={"template_id": template_id, "params": {"username": "farmer", "password": "pw"}},
    )
    assert run_resp.status_code == 200
    assert run_resp.json()["run"]["status"] == "queued"


def test_universal_template_update_and_run_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_run_command(monkeypatch)
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://ops.example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://ops.example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://ops.example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "ops-template",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "u"},
            "policies": {"otp": {"required": False, "provider": "manual"}},
        },
    ).json()["template_id"]

    updated = client.patch(
        f"/api/templates/{template_id}",
        json={
            "name": "ops-template-v2",
            "params_schema": [{"key": "username", "type": "string", "required": True}],
            "defaults": {"username": "u2"},
            "policies": {"otp": {"required": False, "provider": "manual"}, "timeout_seconds": 60},
        },
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "ops-template-v2"

    run = client.post(
        "/api/runs", json={"template_id": template_id, "params": {"username": "runner"}}
    )
    assert run.status_code == 200
    run_id = run.json()["run"]["run_id"]
    assert "validated_params_snapshot" not in run.json()["run"]

    listed_runs = client.get("/api/runs?limit=20")
    assert listed_runs.status_code == 200
    assert any(item["run_id"] == run_id for item in listed_runs.json()["runs"])
    assert all("validated_params_snapshot" not in item for item in listed_runs.json()["runs"])

    cancelled = client.post(f"/api/runs/{run_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["run"]["status"] == "cancelled"
    assert "validated_params_snapshot" not in cancelled.json()["run"]
