from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Generator

from fastapi import HTTPException, status
from fastapi.testclient import TestClient
import pytest
from pytest import MonkeyPatch

import app.api.automation as automation_api
from app.api.dependencies.security import AutomationSecurityContext
from app.main import app


def _task_payload(
    task_id: str,
    *,
    status_value: str = "queued",
    command_id: str = "script-pipeline-capture",
    include_command: bool = False,
    include_updated_at: bool = True,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "task_id": task_id,
        "command_id": command_id,
        "status": status_value,
        "created_at": now,
    }
    if include_command:
        payload["command"] = command_id
    if include_updated_at:
        payload["updated_at"] = now
    return payload


@pytest.fixture
def api_client(monkeypatch: MonkeyPatch) -> Generator[tuple[TestClient, str], None, None]:
    actor = "token:test-branch-expansion"

    def _security_override() -> AutomationSecurityContext:
        return AutomationSecurityContext(
            actor=actor,
            verified_actor=actor,
            client_host="testclient",
            path="/api/automation/tasks",
            x_automation_token=None,
            verified_token=None,
            client_id="pytest-client",
        )

    def _require_actor(*args: Any, **kwargs: Any) -> str:
        return actor

    def _require_access(*args: Any, **kwargs: Any) -> None:
        return None

    app.dependency_overrides[automation_api.require_automation_access] = _security_override
    monkeypatch.setattr(automation_api, "require_actor", _require_actor)
    monkeypatch.setattr(automation_api, "require_access", _require_access)
    client = TestClient(app)
    try:
        yield client, actor
    finally:
        client.close()
        app.dependency_overrides.pop(automation_api.require_automation_access, None)


def test_list_commands_returns_wrapped_response_shape(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client
    monkeypatch.setattr(
        automation_api.automation_service,
        "list_commands",
        lambda: [
            {
                "command_id": "script-pipeline-capture",
                "title": "Run UI",
                "description": "Execute UI tests",
                "tags": ["ui"],
                "accepts_env": True,
            }
        ],
    )

    response = client.get("/api/automation/commands")

    assert response.status_code == 200
    body = response.json()
    assert list(body.keys()) == ["commands"]
    assert body["commands"][0]["command_id"] == "script-pipeline-capture"


def test_list_commands_propagates_access_http_error(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client

    def _deny(*args: Any, **kwargs: Any) -> None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid automation token"
        )

    monkeypatch.setattr(automation_api, "require_access", _deny)
    response = client.get("/api/automation/commands")

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid automation token"


def test_list_tasks_forwards_valid_query_filters(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_list_tasks(
        *, status: str | None, command_id: str | None, limit: int, requested_by: str | None
    ) -> list[dict[str, Any]]:
        captured.update(
            {
                "status": status,
                "command_id": command_id,
                "limit": limit,
                "requested_by": requested_by,
            }
        )
        return [_task_payload("task-running", status_value="running", command_id="script-pipeline-capture")]

    monkeypatch.setattr(automation_api.automation_service, "list_tasks", _fake_list_tasks)
    response = client.get("/api/automation/tasks?status=running&command_id=script-pipeline-capture&limit=7")

    assert response.status_code == 200
    assert captured == {
        "status": "running",
        "command_id": "script-pipeline-capture",
        "limit": 7,
        "requested_by": actor,
    }
    task = response.json()["tasks"][0]
    assert task["status"] == "running"
    assert task["command"] == "script-pipeline-capture"
    assert task["command_id"] == "script-pipeline-capture"


def test_list_tasks_uses_default_query_values(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_list_tasks(
        *, status: str | None, command_id: str | None, limit: int, requested_by: str | None
    ) -> list[dict[str, Any]]:
        captured.update(
            {
                "status": status,
                "command_id": command_id,
                "limit": limit,
                "requested_by": requested_by,
            }
        )
        return []

    monkeypatch.setattr(automation_api.automation_service, "list_tasks", _fake_list_tasks)
    response = client.get("/api/automation/tasks")

    assert response.status_code == 200
    assert response.json() == {"tasks": []}
    assert captured == {"status": None, "command_id": None, "limit": 100, "requested_by": actor}


def test_list_tasks_rejects_limit_below_lower_bound(api_client: tuple[TestClient, str]) -> None:
    client, _ = api_client
    response = client.get("/api/automation/tasks?limit=0")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "limit" for item in response.json()["detail"])


def test_list_tasks_rejects_limit_above_upper_bound(api_client: tuple[TestClient, str]) -> None:
    client, _ = api_client
    response = client.get("/api/automation/tasks?limit=501")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "limit" for item in response.json()["detail"])


def test_list_tasks_ignores_non_alias_status_filter_param(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client
    captured: dict[str, Any] = {}

    def _fake_list_tasks(
        *, status: str | None, command_id: str | None, limit: int, requested_by: str | None
    ) -> list[dict[str, Any]]:
        captured["status"] = status
        return []

    monkeypatch.setattr(automation_api.automation_service, "list_tasks", _fake_list_tasks)
    response = client.get("/api/automation/tasks?status_filter=failed")

    assert response.status_code == 200
    assert captured["status"] is None


def test_list_tasks_rejects_invalid_command_id_pattern(
    api_client: tuple[TestClient, str],
) -> None:
    client, _ = api_client
    response = client.get("/api/automation/tasks?command_id=%20invalid")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "command_id" for item in response.json()["detail"])


def test_list_tasks_treats_literal_null_status_as_unfiltered(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client
    captured: dict[str, Any] = {}

    def _fake_list_tasks(
        *, status: str | None, command_id: str | None, limit: int, requested_by: str | None
    ) -> list[dict[str, Any]]:
        captured["status"] = status
        return []

    monkeypatch.setattr(automation_api.automation_service, "list_tasks", _fake_list_tasks)
    response = client.get("/api/automation/tasks?status=null")

    assert response.status_code == 200
    assert captured["status"] is None


def test_get_task_forwards_actor_and_normalizes_response_shape(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_get_task(task_id: str, requested_by: str | None = None) -> dict[str, Any]:
        captured.update({"task_id": task_id, "requested_by": requested_by})
        return _task_payload(task_id, status_value="success", include_updated_at=False)

    monkeypatch.setattr(automation_api.automation_service, "get_task", _fake_get_task)
    valid_task_id = "idem-1234567890abcdef1234567890abcdef"
    response = client.get(f"/api/automation/tasks/{valid_task_id}")

    assert response.status_code == 200
    assert captured == {"task_id": valid_task_id, "requested_by": actor}
    body = response.json()
    assert body["task_id"] == valid_task_id
    assert body["command"] == "script-pipeline-capture"
    assert body["command_id"] == "script-pipeline-capture"
    assert body["updated_at"] is not None


def test_get_task_rejects_invalid_task_id_pattern(api_client: tuple[TestClient, str]) -> None:
    client, _ = api_client
    response = client.get("/api/automation/tasks/%20invalid")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "task_id" for item in response.json()["detail"])


def test_cancel_task_forwards_actor_and_returns_snapshot(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_cancel_task(task_id: str, requested_by: str | None = None) -> dict[str, Any]:
        captured.update({"task_id": task_id, "requested_by": requested_by})
        return _task_payload(task_id, status_value="cancelled")

    monkeypatch.setattr(automation_api.automation_service, "cancel_task", _fake_cancel_task)
    valid_task_id = "idem-fedcba0987654321fedcba0987654321"
    response = client.post(f"/api/automation/tasks/{valid_task_id}/cancel")

    assert response.status_code == 200
    assert captured == {"task_id": valid_task_id, "requested_by": actor}
    assert response.json()["status"] == "cancelled"


def test_cancel_task_rejects_invalid_task_id_pattern(api_client: tuple[TestClient, str]) -> None:
    client, _ = api_client
    response = client.post("/api/automation/tasks/%20invalid/cancel")

    assert response.status_code == 422
    assert any(item["loc"][-1] == "task_id" for item in response.json()["detail"])


def test_run_command_without_env_skips_deprecation_headers(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_run_command(
        command_id: str,
        env_overrides: dict[str, str],
        *,
        used_deprecated_env: bool = False,
        requested_by: str | None = None,
    ) -> dict[str, Any]:
        captured.update(
            {
                "command_id": command_id,
                "env_overrides": env_overrides,
                "used_deprecated_env": used_deprecated_env,
                "requested_by": requested_by,
            }
        )
        return _task_payload("task-no-env", status_value="queued", include_command=False)

    monkeypatch.setattr(automation_api.automation_service, "run_command", _fake_run_command)
    response = client.post(
        "/api/automation/run",
        json={"command": "script-pipeline-capture", "params": {"BASE_URL": "https://example.com"}},
    )

    assert response.status_code == 200
    assert captured == {
        "command_id": "script-pipeline-capture",
        "env_overrides": {"BASE_URL": "https://example.com"},
        "used_deprecated_env": False,
        "requested_by": actor,
    }
    assert response.headers.get("deprecation") is None
    task = response.json()["task"]
    assert task["command"] == "script-pipeline-capture"
    assert task["command_id"] == "script-pipeline-capture"


def test_run_command_with_params_avoids_deprecation_headers(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, actor = api_client
    captured: dict[str, Any] = {}

    def _fake_run_command(
        command_id: str,
        env_overrides: dict[str, str],
        *,
        used_deprecated_env: bool = False,
        requested_by: str | None = None,
    ) -> dict[str, Any]:
        captured.update(
            {
                "command_id": command_id,
                "env_overrides": env_overrides,
                "used_deprecated_env": used_deprecated_env,
                "requested_by": requested_by,
            }
        )
        return _task_payload("task-with-env", status_value="queued", include_command=False)

    monkeypatch.setattr(automation_api.automation_service, "run_command", _fake_run_command)
    response = client.post(
        "/api/automation/run",
        json={"command": "script-pipeline-capture", "params": {"BASE_URL": "https://env.example.com"}},
    )

    assert response.status_code == 200
    assert captured == {
        "command_id": "script-pipeline-capture",
        "env_overrides": {"BASE_URL": "https://env.example.com"},
        "used_deprecated_env": False,
        "requested_by": actor,
    }
    assert response.headers.get("deprecation") is None
    assert response.headers.get("sunset") is None
    assert response.headers.get("link") is None
    task = response.json()["task"]
    assert task["command"] == "script-pipeline-capture"
    assert task["command_id"] == "script-pipeline-capture"


def test_run_command_propagates_service_http_exception(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client

    def _raise_conflict(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="task already running")

    monkeypatch.setattr(automation_api.automation_service, "run_command", _raise_conflict)
    response = client.post("/api/automation/run", json={"command": "script-pipeline-capture", "params": {}})

    assert response.status_code == 409
    assert response.json()["detail"] == "task already running"


def test_run_command_strict_mode_blocks_env_before_service_call(
    api_client: tuple[TestClient, str], monkeypatch: MonkeyPatch
) -> None:
    client, _ = api_client
    service_call_count = {"value": 0}

    def _fake_run_command(*args: Any, **kwargs: Any) -> dict[str, Any]:
        service_call_count["value"] += 1
        return _task_payload("should-not-run")

    monkeypatch.setattr(automation_api, "is_automation_run_payload_strict", lambda: True)
    monkeypatch.setattr(automation_api.automation_service, "run_command", _fake_run_command)

    response = client.post(
        "/api/automation/run",
        json={"command": "script-pipeline-capture", "env": {"BASE_URL": "https://strict.example.com"}},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "env is deprecated, use params"
    assert service_call_count["value"] == 0
