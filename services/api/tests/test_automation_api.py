from __future__ import annotations

import time
import hashlib
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from threading import Event
from typing import Any, cast

from fastapi.testclient import TestClient
import pytest
from pytest import MonkeyPatch

import app.core.access_control as access_control
import app.api.automation as automation_api
from app.core.metrics import runtime_metrics
from app.main import app
from app.services.automation_service import RunningTask, automation_service

TEST_AUTOMATION_TOKEN = "test-token-0123456789"
ALT_AUTOMATION_TOKEN = "token-1234567890abcd"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-client",
    },
)


@pytest.fixture(autouse=True)
def reset_automation_state(monkeypatch: MonkeyPatch, request: pytest.FixtureRequest) -> None:
    with automation_service._lock:
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        automation_service._idempotency_records.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    monkeypatch.setenv("APP_ENV", "test")
    access_control.reset_for_tests()

    original_resolve_idempotency_key = automation_service._resolve_idempotency_key

    def scoped_resolve_idempotency_key(
        command_id: str,
        env_overrides: dict[str, str],
        requested_by: str | None,
        raw_env: dict[str, str],
    ) -> str:
        resolved = original_resolve_idempotency_key(
            command_id, env_overrides, requested_by, raw_env
        )
        if resolved.startswith("user:"):
            return resolved
        node_scope = hashlib.sha256(request.node.nodeid.encode("utf-8")).hexdigest()[:12]
        return f"{resolved}:test:{node_scope}"

    monkeypatch.setattr(
        automation_service, "_resolve_idempotency_key", scoped_resolve_idempotency_key
    )


def test_list_automation_commands() -> None:
    response = client.get("/api/automation/commands")
    assert response.status_code == 200
    commands = response.json()["commands"]
    command_ids = {item["command_id"] for item in commands}
    expected = {
        "setup",
        "script-pipeline-full",
        "script-pipeline-full-midscene",
        "script-pipeline-capture",
        "script-pipeline-capture-midscene",
        "clean",
        "map",
        "diagnose",
        "dev-frontend",
        "lint-frontend",
        "automation-install",
        "automation-lint",
        "automation-record",
        "automation-record-manual",
        "automation-record-midscene",
        "automation-extract",
        "automation-generate-case",
        "automation-replay",
        "automation-replay-flow",
        "automation-replay-flow-step",
        "automation-test",
        "backend-test",
    }
    assert expected.issubset(command_ids)


def test_list_tasks_rejects_invalid_status_filter() -> None:
    response = client.get("/api/automation/tasks?status=invalid")
    assert response.status_code == 422
    assert any(
        len(item["loc"]) >= 2 and item["loc"][1] == "status" for item in response.json()["detail"]
    )


def test_run_unknown_command_returns_404() -> None:
    response = client.post(
        "/api/automation/run",
        json={"command": "not-exists", "params": {}},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "command not found"


def test_run_high_risk_command_returns_403() -> None:
    response = client.post(
        "/api/automation/run",
        json={"command": "clean", "params": {}},
    )
    assert response.status_code == 403
    assert "high-risk command is disabled" in response.json()["detail"]


def test_run_command_rejects_oversized_env_value() -> None:
    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "env": {
                "BASE_URL": "https://example.com",
                "SUCCESS_SELECTOR": "#" + ("x" * 2050),
            },
        },
    )
    assert response.status_code == 422


def test_run_command_filters_env(monkeypatch: MonkeyPatch) -> None:
    captured: dict[str, dict[str, str]] = {}
    spawn_called = Event()

    def fake_spawn(argv: list[str], env: dict[str, str]):
        captured["env"] = env
        spawn_called.set()

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = iter(["ok\n"])
                self._finished = False

            def wait(self, timeout: float | None = None) -> int:
                self._finished = True
                return 0

            def terminate(self) -> None:
                return None

            def poll(self) -> int | None:
                return 0 if self._finished else None

        return FakeProcess()

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)

    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "BASE_URL": "https://example.com",
                "START_URL": "https://example.com/custom",
                "AI_PROVIDER": "gemini",
                "AI_SPEED_MODE": "balanced",
                "GEMINI_MODEL": "gemini-2.5-pro",
                "GEMINI_FAST_MODEL": "gemini-2.5-flash",
                "GEMINI_EMBEDDING_MODEL": "text-embedding-004",
                "GEMINI_THINKING_LEVEL": "high",
                "FLOW_FROM_STEP_ID": "s9",
                "FLOW_STEP_ID": "s2",
                "FLOW_OTP_CODE": "123456",
                "SUCCESS_SELECTOR": "#done",
            },
        },
    )

    assert response.status_code == 200
    task_id = response.json()["task"]["task_id"]
    assert task_id
    assert spawn_called.wait(timeout=2), "timed out waiting for fake_spawn to be called"

    # Only whitelisted env vars should pass through.
    assert captured["env"]["BASE_URL"] == "https://example.com"
    assert captured["env"]["START_URL"] == "https://example.com/custom"
    assert captured["env"]["AI_PROVIDER"] == "gemini"
    assert captured["env"]["AI_SPEED_MODE"] == "balanced"
    assert captured["env"]["GEMINI_MODEL"] == "gemini-2.5-pro"
    assert captured["env"]["GEMINI_FAST_MODEL"] == "gemini-2.5-flash"
    assert captured["env"]["GEMINI_EMBEDDING_MODEL"] == "text-embedding-004"
    assert captured["env"]["GEMINI_THINKING_LEVEL"] == "high"
    assert captured["env"]["FLOW_FROM_STEP_ID"] == "s9"
    assert captured["env"]["FLOW_STEP_ID"] == "s2"
    assert captured["env"]["FLOW_OTP_CODE"] == "123456"
    assert captured["env"]["SUCCESS_SELECTOR"] == "#done"
    assert "LEGACY_PROVIDER" not in captured["env"]
    assert "AUTOMATION_API_TOKEN" not in captured["env"]
    assert "NOT_ALLOWED" not in captured["env"]
    assert response.headers.get("deprecation") is None
    assert response.headers.get("sunset") is None
    assert response.headers.get("link") is None


def test_run_command_accepts_params_only(monkeypatch: MonkeyPatch) -> None:
    captured: dict[str, dict[str, str]] = {}
    spawn_called = Event()

    def fake_spawn(argv: list[str], env: dict[str, str]):
        captured["env"] = env
        spawn_called.set()

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = iter(["ok\n"])
                self._finished = False

            def wait(self, timeout: float | None = None) -> int:
                self._finished = True
                return 0

            def terminate(self) -> None:
                return None

            def poll(self) -> int | None:
                return 0 if self._finished else None

        return FakeProcess()

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)

    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "BASE_URL": "https://example.com",
                "FLOW_STEP_ID": "s3",
            },
        },
    )

    assert response.status_code == 200
    assert spawn_called.wait(timeout=2), "timed out waiting for fake_spawn to be called"
    assert captured["env"]["BASE_URL"] == "https://example.com"
    assert captured["env"]["FLOW_STEP_ID"] == "s3"


def test_run_command_params_take_precedence_over_env(monkeypatch: MonkeyPatch) -> None:
    captured: dict[str, dict[str, str]] = {}
    spawn_called = Event()

    def fake_spawn(argv: list[str], env: dict[str, str]):
        captured["env"] = env
        spawn_called.set()

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = iter(["ok\n"])
                self._finished = False

            def wait(self, timeout: float | None = None) -> int:
                self._finished = True
                return 0

            def terminate(self) -> None:
                return None

            def poll(self) -> int | None:
                return 0 if self._finished else None

        return FakeProcess()

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)

    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {"BASE_URL": "https://params.example.com"},
        },
    )
    assert response.status_code == 200
    assert spawn_called.wait(timeout=2), "timed out waiting for fake_spawn to be called"
    assert captured["env"]["BASE_URL"] == "https://params.example.com"


def test_run_command_rejects_unknown_params_field() -> None:
    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {"UNKNOWN_FIELD": "x"},
        },
    )
    assert response.status_code == 422


def test_run_command_strict_mode_rejects_env(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_api, "is_automation_run_payload_strict", lambda: True)
    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "env": {"BASE_URL": "https://example.com"},
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "env is deprecated, use params"


def test_spawn_failure_marks_task_failed(monkeypatch: MonkeyPatch) -> None:
    def fake_spawn(argv: list[str], env: dict[str, str]):
        raise RuntimeError("boom")

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)

    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "AUTOMATION_IDEMPOTENCY_KEY": "test-spawn-failure-marks-task-failed",
            },
        },
    )
    assert response.status_code == 200
    task_id = response.json()["task"]["task_id"]

    # Thread should flip this task to failed quickly.
    for _ in range(50):
        task_response = client.get(f"/api/automation/tasks/{task_id}")
        task = task_response.json()
        if task["status"] == "failed":
            break
        time.sleep(0.01)

    assert task["status"] == "failed"
    assert "spawn failed" in (task["message"] or "")


def test_run_command_retry_path_uses_backoff_scheduler(monkeypatch: MonkeyPatch) -> None:
    call_count = {"value": 0}
    observed_retry_attempts: list[int] = []

    class FakeProcess:
        def __init__(self, exit_code: int) -> None:
            self.stdout = iter(["retry\n"])
            self._exit_code = exit_code
            self._finished = False

        def wait(self, timeout: float | None = None) -> int:
            self._finished = True
            return self._exit_code

        def terminate(self) -> None:
            return None

        def poll(self) -> int | None:
            return self._exit_code if self._finished else None

    def fake_spawn(argv: list[str], env: dict[str, str]):
        call_count["value"] += 1
        return FakeProcess(1 if call_count["value"] == 1 else 0)

    def fake_retry_delay(attempt: int) -> float:
        observed_retry_attempts.append(attempt)
        return 0.0

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)
    monkeypatch.setattr(automation_service, "_compute_retry_delay_seconds", fake_retry_delay)
    monkeypatch.setattr(automation_service, "_default_retries", 1)
    monkeypatch.setattr(automation_service, "_slot_limiter", nullcontext())
    monkeypatch.setattr(automation_service, "_long_slot_limiter", nullcontext())
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 10_000)

    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "BASE_URL": "https://example.com",
                "AUTOMATION_IDEMPOTENCY_KEY": "test-run-command-retry-path-uses-backoff-scheduler",
            },
        },
    )
    assert response.status_code == 200
    task_id = response.json()["task"]["task_id"]

    # Wait for both attempts to be observed before asserting terminal status.
    deadline = time.time() + 90.0
    while time.time() < deadline and call_count["value"] < 2:
        time.sleep(0.05)

    assert call_count["value"] == 2, "retry attempt did not execute before timeout"

    # Poll until terminal state to avoid asserting on transient queued/running.
    last_status: str | None = None
    last_payload: dict[str, object] = {}
    terminal_task: dict[str, object] | None = None
    poll_sleep_seconds = 0.15
    while time.time() < deadline:
        task_response = client.get(f"/api/automation/tasks/{task_id}")
        if task_response.status_code == 429:
            time.sleep(0.35)
            continue
        if task_response.status_code != 200:
            time.sleep(poll_sleep_seconds)
            continue
        payload = task_response.json()
        if not isinstance(payload, dict):
            time.sleep(poll_sleep_seconds)
            continue
        status_value = payload.get("status")
        if not isinstance(status_value, str):
            time.sleep(poll_sleep_seconds)
            continue
        last_status = status_value
        last_payload = payload
        if status_value == "success":
            terminal_task = payload
            break
        if status_value in {"failed", "cancelled"}:
            pytest.fail(
                f"task reached terminal non-success state: {status_value}, payload={payload}"
            )
        time.sleep(poll_sleep_seconds)

    assert terminal_task is not None, (
        f"task did not reach success before timeout (last_status={last_status}, "
        f"last_payload={last_payload})"
    )
    assert terminal_task["status"] == "success"
    assert terminal_task["attempt"] == 2
    assert call_count["value"] == 2
    assert observed_retry_attempts == [2]


def test_run_command_coalesces_duplicate_inflight_by_idempotency(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)
    payload = {
        "command": "script-pipeline-capture",
        "params": {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-inflight",
        },
    }

    first = client.post("/api/automation/run", json=payload)
    second = client.post("/api/automation/run", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["task"]["task_id"] == second.json()["task"]["task_id"]

    with automation_service._lock:
        assert len(automation_service._tasks) == 1


def test_run_command_idempotency_replay_creates_new_task(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)
    seed_payload = {
        "command": "script-pipeline-capture",
        "params": {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-replay",
        },
    }
    first = client.post("/api/automation/run", json=seed_payload)
    assert first.status_code == 200
    original_task_id = first.json()["task"]["task_id"]

    with automation_service._lock:
        task = automation_service._tasks[original_task_id]
        task.status = "success"
        task.finished_at = datetime.now(timezone.utc)
        task.message = "completed"
        automation_service._save_task_locked(task)

    duplicate = client.post("/api/automation/run", json=seed_payload)
    assert duplicate.status_code == 200
    assert duplicate.json()["task"]["task_id"] == original_task_id

    replay = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "BASE_URL": "https://example.com",
                "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-replay",
                "AUTOMATION_IDEMPOTENCY_REPLAY": "true",
            },
        },
    )
    assert replay.status_code == 200
    replay_task_id = replay.json()["task"]["task_id"]
    assert replay_task_id != original_task_id

    with automation_service._lock:
        replay_task = automation_service._tasks[replay_task_id]
        assert replay_task.replay_of_task_id == original_task_id
        assert replay_task.message == f"idempotent replay of {original_task_id}"


def test_run_command_explicit_idempotency_key_is_scoped_by_requester(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)
    payload = {
        "command": "script-pipeline-capture",
        "params": {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "shared-explicit-key",
        },
    }

    owner = client.post(
        "/api/automation/run",
        headers={"x-automation-token": ALT_AUTOMATION_TOKEN, "x-automation-client-id": "owner-a"},
        json=payload,
    )
    attacker = client.post(
        "/api/automation/run",
        headers={"x-automation-token": ALT_AUTOMATION_TOKEN, "x-automation-client-id": "owner-b"},
        json=payload,
    )

    assert owner.status_code == 200
    assert attacker.status_code == 200
    assert owner.json()["task"]["task_id"] != attacker.json()["task"]["task_id"]


def test_automation_token_protects_routes(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    no_token_client = TestClient(app)
    no_token = no_token_client.get("/api/automation/commands")
    assert no_token.status_code == 401

    bad_token = client.get("/api/automation/commands", headers={"x-automation-token": "wrong"})
    assert bad_token.status_code == 401

    ok = client.get(
        "/api/automation/commands",
        headers={
            "x-automation-token": ALT_AUTOMATION_TOKEN,
            "x-automation-client-id": "token-protect",
        },
    )
    assert ok.status_code == 200


def test_automation_require_token_false_allows_no_token(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_REQUIRE_TOKEN", "false")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 200


def test_automation_require_token_false_still_rejects_invalid_token(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_REQUIRE_TOKEN", "false")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    response = TestClient(app).get(
        "/api/automation/commands", headers={"x-automation-token": "wrong"}
    )
    assert response.status_code == 401


def test_emergency_kill_switch_blocks_mutating_automation_routes(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_EMERGENCY_KILL_SWITCH", "true")
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)
    response = client.post(
        "/api/automation/run",
        json={
            "command": "script-pipeline-capture",
            "params": {
                "AUTOMATION_IDEMPOTENCY_KEY": "test-task-output-is-redacted",
            },
        },
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "automation emergency kill switch is enabled"


def test_emergency_kill_switch_keeps_read_only_routes_available(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_EMERGENCY_KILL_SWITCH", "true")
    response = client.get("/api/automation/commands")
    assert response.status_code == 200


def test_local_client_without_configured_token_is_rejected(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 401


def test_allow_local_no_token_with_loopback_only(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "test")
    loopback_client = TestClient(app)
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: True)
    allowed = loopback_client.get("/api/automation/commands")
    assert allowed.status_code == 200
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: False)
    rejected = loopback_client.get("/api/automation/commands")
    assert rejected.status_code == 401


def test_allow_local_no_token_rejects_non_loopback_when_token_configured(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: False)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 401


def test_allow_local_no_token_rejects_loopback_in_production(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: True)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 503
    assert "must be false in production" in response.json()["detail"]


def test_allow_local_no_token_is_blocked_in_production_even_with_valid_token(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "production")
    response = TestClient(app).get(
        "/api/automation/commands",
        headers={
            "x-automation-token": ALT_AUTOMATION_TOKEN,
            "x-automation-client-id": "prod-client",
        },
    )
    assert response.status_code == 503
    assert "must be false in production" in response.json()["detail"]


def test_allow_local_no_token_rejects_loopback_in_staging(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: True)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 503
    assert "production-like environments" in response.json()["detail"]


def test_allow_local_no_token_is_blocked_in_staging(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(access_control, "_is_loopback_client", lambda request: True)
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 503
    assert "production-like environments" in response.json()["detail"]


def test_automation_token_rejects_placeholder_value(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "replace-with-strong-token")
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 503
    assert "automation token is weak" in response.json()["detail"]


def test_automation_token_rejects_short_value(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "short-token")
    response = TestClient(app).get("/api/automation/commands")
    assert response.status_code == 503
    assert "automation token is weak" in response.json()["detail"]


def test_redis_rate_limit_error_falls_back_to_memory(monkeypatch: MonkeyPatch) -> None:
    class BrokenRedis:
        def eval(self, *args, **kwargs):
            raise RuntimeError("redis down")

    before = cast(int, runtime_metrics.snapshot()["rate_limit_redis_errors"])
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setattr(access_control, "_REDIS_CLIENT", BrokenRedis())
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "redis://127.0.0.1:6379/0")

    response = client.get("/api/automation/commands")
    assert response.status_code == 200
    after = cast(int, runtime_metrics.snapshot()["rate_limit_redis_errors"])
    assert after == before + 1


def test_task_pruning_keeps_running() -> None:
    original_max_tasks = automation_service._max_tasks
    try:
        automation_service._max_tasks = 2
        automation_service._tasks.clear()

        now = datetime.now(timezone.utc)
        automation_service._tasks["done-1"] = RunningTask(
            task_id="done-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(seconds=3),
        )
        automation_service._tasks["done-2"] = RunningTask(
            task_id="done-2",
            command_id="script-pipeline-capture",
            status="failed",
            created_at=now - timedelta(seconds=2),
        )
        automation_service._tasks["running-1"] = RunningTask(
            task_id="running-1",
            command_id="script-pipeline-capture",
            status="running",
            created_at=now - timedelta(seconds=1),
        )

        automation_service._prune_tasks_locked()

        assert "done-1" not in automation_service._tasks
        assert "done-2" in automation_service._tasks
        assert "running-1" in automation_service._tasks
    finally:
        automation_service._max_tasks = original_max_tasks


def test_task_pruning_recycles_expired_completed_and_idempotency_record() -> None:
    original_ttl = automation_service._completed_task_ttl_seconds
    try:
        automation_service._completed_task_ttl_seconds = 60
        now = datetime.now(timezone.utc)
        expired = RunningTask(
            task_id="expired-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(minutes=10),
            finished_at=now - timedelta(minutes=10),
            idempotency_key="user:expired-key",
        )
        recent = RunningTask(
            task_id="recent-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(seconds=5),
            finished_at=now - timedelta(seconds=5),
            idempotency_key="user:recent-key",
        )
        with automation_service._lock:
            automation_service._tasks[expired.task_id] = expired
            automation_service._tasks[recent.task_id] = recent
            automation_service._idempotency_records["user:expired-key"] = (
                expired.task_id,
                now - timedelta(minutes=10),
            )
            automation_service._idempotency_records["user:recent-key"] = (
                recent.task_id,
                now - timedelta(seconds=5),
            )
            automation_service._save_task_locked(expired)
            automation_service._save_task_locked(recent)
            automation_service._prune_tasks_locked()

            assert "expired-1" not in automation_service._tasks
            assert "recent-1" in automation_service._tasks
            assert "user:expired-key" not in automation_service._idempotency_records
            assert "user:recent-key" in automation_service._idempotency_records
    finally:
        automation_service._completed_task_ttl_seconds = original_ttl


def test_run_command_prunes_completed_when_capacity_is_full(monkeypatch: MonkeyPatch) -> None:
    original_max_tasks = automation_service._max_tasks
    try:
        automation_service._max_tasks = 2
        automation_service._tasks.clear()
        now = datetime.now(timezone.utc)
        task1 = RunningTask(
            task_id="done-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(seconds=2),
        )
        task2 = RunningTask(
            task_id="done-2",
            command_id="script-pipeline-capture",
            status="failed",
            created_at=now - timedelta(seconds=1),
        )
        with automation_service._lock:
            automation_service._tasks[task1.task_id] = task1
            automation_service._tasks[task2.task_id] = task2
            automation_service._save_task_locked(task1)
            automation_service._save_task_locked(task2)
        monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)

        response = client.post("/api/automation/run", json={"command": "script-pipeline-capture", "params": {}})
        assert response.status_code == 200

        with automation_service._lock:
            assert len(automation_service._tasks) == 2
            assert "done-1" not in automation_service._tasks
    finally:
        automation_service._max_tasks = original_max_tasks


def test_cancel_queued_task_sets_cancelled() -> None:
    now = datetime.now(timezone.utc)
    task = RunningTask(
        task_id="queued-x",
        command_id="script-pipeline-capture",
        status="queued",
        created_at=now,
    )
    automation_service._tasks[task.task_id] = task
    with automation_service._lock:
        automation_service._save_task_locked(task)
    cancelled = automation_service.cancel_task(task.task_id)
    assert cancelled.status == "cancelled"
    assert cancelled.message == "task cancelled before start"
    automation_service._tasks.pop(task.task_id, None)


def test_cancel_running_without_process_is_sticky() -> None:
    now = datetime.now(timezone.utc)
    task = RunningTask(
        task_id="running-no-process",
        command_id="script-pipeline-capture",
        status="running",
        created_at=now,
    )
    automation_service._tasks[task.task_id] = task
    with automation_service._lock:
        automation_service._save_task_locked(task)
    cancelled = automation_service.cancel_task(task.task_id)
    assert cancelled.status == "cancelled"
    assert cancelled.message == "task cancellation requested by user"
    automation_service._tasks.pop(task.task_id, None)


def test_cancel_running_process_tolerates_process_lookup_race(monkeypatch: MonkeyPatch) -> None:
    now = datetime.now(timezone.utc)
    task = RunningTask(
        task_id="running-process-lookup-race",
        command_id="script-pipeline-capture",
        status="running",
        created_at=now,
    )

    terminate_calls: list[int] = []

    class FakeProcess:
        pid = 424242

        def wait(self, timeout: float | None = None) -> int:
            return 0

        def terminate(self) -> None:
            terminate_calls.append(self.pid)
            raise ProcessLookupError("already exited")

        def poll(self) -> int | None:
            return None

    task.process = cast(Any, FakeProcess())
    automation_service._tasks[task.task_id] = task
    with automation_service._lock:
        automation_service._save_task_locked(task)

    cancelled = automation_service.cancel_task(task.task_id)
    assert cancelled.status == "cancelled"
    assert cancelled.message == "task cancellation requested by user"
    assert terminate_calls == [424242]
    automation_service._tasks.pop(task.task_id, None)


def test_list_tasks_supports_filters() -> None:
    now = datetime.now(timezone.utc)
    owner = f"token:{hashlib.sha256(f'{TEST_AUTOMATION_TOKEN}::pytest-client'.encode('utf-8')).hexdigest()[:16]}"
    task1 = RunningTask(
        task_id="a1", command_id="script-pipeline-capture", status="success", created_at=now, requested_by=owner
    )
    task2 = RunningTask(
        task_id="a2", command_id="script-pipeline-full", status="failed", created_at=now, requested_by=owner
    )
    automation_service._tasks["a1"] = task1
    automation_service._tasks["a2"] = task2
    with automation_service._lock:
        automation_service._save_task_locked(task1)
        automation_service._save_task_locked(task2)

    response = client.get(
        "/api/automation/tasks?status=failed&command_id=script-pipeline-full"
    )
    assert response.status_code == 200
    tasks = response.json()["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["task_id"] == "a2"


def test_automation_client_id_header_cannot_spoof_requester(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    owner_id = (
        f"token:{hashlib.sha256(f'{ALT_AUTOMATION_TOKEN}::owner'.encode('utf-8')).hexdigest()[:16]}"
    )
    with automation_service._lock:
        task = RunningTask(
            task_id="idem-11111111111111111111111111111111",
            command_id="script-pipeline-capture",
            status="success",
            created_at=datetime.now(timezone.utc),
            requested_by=owner_id,
        )
        automation_service._tasks[task.task_id] = task
        automation_service._save_task_locked(task)

    owner_headers = {"x-automation-token": ALT_AUTOMATION_TOKEN, "x-automation-client-id": "owner"}
    attacker_headers = {
        "x-automation-token": ALT_AUTOMATION_TOKEN,
        "x-automation-client-id": "attacker",
    }

    owner_task_id = "idem-11111111111111111111111111111111"
    owner = client.get(f"/api/automation/tasks/{owner_task_id}", headers=owner_headers)
    attacker = client.get(f"/api/automation/tasks/{owner_task_id}", headers=attacker_headers)
    assert owner.status_code == 200
    assert attacker.status_code == 403


def test_task_output_is_redacted(monkeypatch: MonkeyPatch) -> None:
    def fake_spawn(argv: list[str], env: dict[str, str]):
        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = iter(
                    [
                        "password=MySecret1!\n",
                        "x-automation-token=abc123\n",
                    ]
                )
                self._finished = False

            def wait(self, timeout: float | None = None) -> int:
                self._finished = True
                return 0

            def terminate(self) -> None:
                return None

            def poll(self) -> int | None:
                return 0 if self._finished else None

        return FakeProcess()

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)
    response = client.post("/api/automation/run", json={"command": "script-pipeline-capture", "params": {}})
    assert response.status_code == 200
    task_id = response.json()["task"]["task_id"]

    deadline = time.time() + 5.0
    task: dict[str, object] = {}
    while time.time() < deadline:
        task_response = client.get(f"/api/automation/tasks/{task_id}")
        if task_response.status_code != 200:
            time.sleep(0.01)
            continue
        payload = task_response.json()
        if not isinstance(payload, dict):
            time.sleep(0.01)
            continue
        task = payload
        if task.get("status") == "success":
            break
        time.sleep(0.01)

    assert task.get("status") == "success"
    output_tail = cast(str, task["output_tail"])
    assert "***REDACTED***" in output_tail
    assert "MySecret1!" not in output_tail
    assert "abc123" not in output_tail


def test_redaction_covers_gemini_and_google_keys() -> None:
    redacted_gemini = automation_service._redact_sensitive("gemini_api_key=abc123\n")
    redacted_google = automation_service._redact_sensitive("google_api_key=xyz789\n")

    assert "gemini_api_key=***REDACTED***" in redacted_gemini
    assert "google_api_key=***REDACTED***" in redacted_google
    assert "abc123" not in redacted_gemini
    assert "xyz789" not in redacted_google


def test_rate_limit_returns_429(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 2)
    first = client.get("/api/automation/commands")
    second = client.get("/api/automation/commands")
    third = client.get("/api/automation/commands")
    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429


def test_rate_limit_key_isolated_by_client_id(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)
    headers_a = {"x-automation-token": TEST_AUTOMATION_TOKEN, "x-automation-client-id": "tenant-a"}
    headers_b = {"x-automation-token": TEST_AUTOMATION_TOKEN, "x-automation-client-id": "tenant-b"}

    first_a = client.get("/api/automation/commands", headers=headers_a)
    second_a = client.get("/api/automation/commands", headers=headers_a)
    first_b = client.get("/api/automation/commands", headers=headers_b)

    assert first_a.status_code == 200
    assert second_a.status_code == 429
    assert first_b.status_code == 200


def test_rate_limit_increments_runtime_metric(monkeypatch: MonkeyPatch) -> None:
    baseline = cast(int, runtime_metrics.snapshot()["rate_limited"])
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    first = client.get("/api/automation/commands")
    second = client.get("/api/automation/commands")
    assert first.status_code == 200
    assert second.status_code == 429
    assert cast(int, runtime_metrics.snapshot()["rate_limited"]) == baseline + 1


def test_rate_bucket_compaction_trims_active_buckets(monkeypatch: MonkeyPatch) -> None:
    now = time.time()
    monkeypatch.setattr(access_control, "_client_ip", lambda request: "127.0.0.1")
    target_identity = f"token:{hashlib.sha256(f'{TEST_AUTOMATION_TOKEN}::pytest-client'.encode('utf-8')).hexdigest()[:16]}"
    target_key = f"{target_identity}:/api/automation/commands"
    with access_control._RATE_LOCK:
        access_control._RATE_BUCKETS.clear()
        access_control._RATE_BUCKETS[target_key] = access_control.deque([now - 1])
        access_control._RATE_BUCKETS["10.0.0.2:/api/automation/commands"] = access_control.deque(
            [now - 2]
        )
        access_control._RATE_BUCKETS["10.0.0.3:/api/automation/tasks"] = access_control.deque(
            [now - 3]
        )

    monkeypatch.setattr(access_control, "_MAX_RATE_BUCKETS", 2)
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 120)

    response = client.get("/api/automation/commands")
    assert response.status_code == 200
    with access_control._RATE_LOCK:
        assert len(access_control._RATE_BUCKETS) <= 2
        assert target_key in access_control._RATE_BUCKETS


def test_authenticated_rate_limit_ignores_legacy_ip_bucket(monkeypatch: MonkeyPatch) -> None:
    now = time.time()
    legacy_identity = "127.0.0.1:pytest-client"
    legacy_key = f"{legacy_identity}:/api/automation/commands"
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)
    with access_control._RATE_LOCK:
        access_control._RATE_BUCKETS.clear()
        access_control._RATE_BUCKETS[legacy_key] = access_control.deque([now - 1])

    response = client.get("/api/automation/commands")
    assert response.status_code == 200


def test_redis_rate_limit_falls_back_to_memory(monkeypatch: MonkeyPatch) -> None:
    class BrokenRedis:
        def eval(self, *args, **kwargs):
            raise RuntimeError("redis down")

    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setattr(access_control, "_REDIS_CLIENT", BrokenRedis())
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "redis://127.0.0.1:6379/0")
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    first = client.get("/api/automation/commands")
    second = client.get("/api/automation/commands")
    assert first.status_code == 200
    assert second.status_code == 429


def test_run_command_accepts_deprecated_command_id() -> None:
    # Compatibility guardrail only: keep a single explicit legacy assertion while
    # all production-path tests use `command`.
    response = client.post("/api/automation/run", json={"command_id": "script-pipeline-capture", "params": {}})
    assert response.status_code == 200
