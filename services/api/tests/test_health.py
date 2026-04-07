import json
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient

import app.api.command_tower as command_tower_api
import app.core.access_control as access_control
from app.main import app
from app.services.automation_service import RunningTask, automation_service
from datetime import datetime, timezone
import pytest

TEST_AUTOMATION_TOKEN = "test-token-0123456789"
ALT_AUTOMATION_TOKEN = "token-1234567890abcd"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-health",
    },
)


@pytest.fixture(autouse=True)
def reset_health_state(monkeypatch: pytest.MonkeyPatch) -> None:
    with automation_service._lock:
        automation_service._sync_from_store_locked()
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    access_control.reset_for_tests()


def _create_command_tower_session(start_url: str = "https://example.com/start") -> str:
    response = client.post("/api/sessions/start", json={"start_url": start_url, "mode": "manual"})
    assert response.status_code == 200
    return response.json()["session_id"]


def _command_tower_runtime_root() -> Path:
    return command_tower_api.runtime_root()


def _command_tower_session_dir(session_id: str) -> Path:
    return _command_tower_runtime_root() / session_id


def test_health_check() -> None:
    response = client.get("/health/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"


def test_health_diagnostics() -> None:
    response = client.get("/health/diagnostics")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert "uptime_seconds" in payload
    assert payload["storage_backend"] in {"file", "sql"}
    assert "task_counts" in payload
    assert "metrics" in payload
    assert "requests_total" in payload["metrics"]
    assert "generated_at" in payload
    assert "diagnostics_index" in payload
    assert "alerts" in payload
    assert payload["diagnostics_index"]["report"]["status"] == "success"


def test_health_alerts_degraded_on_high_failure_ratio() -> None:
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        task1 = RunningTask(task_id="h1", command_id="script-pipeline-full", status="failed", created_at=now)
        task2 = RunningTask(task_id="h2", command_id="script-pipeline-full", status="failed", created_at=now)
        task3 = RunningTask(task_id="h3", command_id="script-pipeline-full", status="success", created_at=now)
        automation_service._tasks[task1.task_id] = task1
        automation_service._tasks[task2.task_id] = task2
        automation_service._tasks[task3.task_id] = task3
        automation_service._save_task_locked(task1)
        automation_service._save_task_locked(task2)
        automation_service._save_task_locked(task3)

    response = client.get("/health/alerts")
    assert response.status_code == 200
    payload = response.json()
    assert payload["state"] == "degraded"
    assert payload["failure_rate"] > payload["threshold"]
    assert payload["total"] == len(payload["alerts"]) == 1
    assert payload["alerts"][0]["code"] == "automation_failure_rate_high"


def test_health_alerts_require_token_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)

    raw_client = TestClient(app)
    no_token = raw_client.get("/health/alerts")
    assert no_token.status_code == 401

    ok = client.get(
        "/health/alerts",
        headers={
            "x-automation-token": ALT_AUTOMATION_TOKEN,
            "x-automation-client-id": "health-alerts",
        },
    )
    assert ok.status_code == 200


def test_health_alerts_invalid_threshold_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_FAILURE_ALERT_THRESHOLD", "not-a-number")

    response = client.get("/health/alerts")
    assert response.status_code == 200
    assert response.json()["threshold"] == 0.2


def test_health_rum_allows_anonymous_ingest_even_when_token_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)

    raw_client = TestClient(app)
    no_token = raw_client.post("/health/rum", json={"metric": "lcp", "value": 123.4})
    assert no_token.status_code == 202
    assert no_token.json()["status"] == "accepted"
    assert no_token.json()["metric"] == "LCP"


def test_health_rum_anonymous_ingest_is_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    access_control.reset_for_tests()
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    raw_client = TestClient(app)
    first = raw_client.post("/health/rum", json={"metric": "lcp", "value": 123.4})
    second = raw_client.post("/health/rum", json={"metric": "lcp", "value": 223.4})
    assert first.status_code == 202
    assert second.status_code == 429


def test_health_rum_anonymous_rate_limit_ignores_client_id_header_rotation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    access_control.reset_for_tests()
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    raw_client = TestClient(app)
    first = raw_client.post(
        "/health/rum",
        headers={"x-automation-client-id": "rotating-a"},
        json={"metric": "lcp", "value": 123.4},
    )
    second = raw_client.post(
        "/health/rum",
        headers={"x-automation-client-id": "rotating-b"},
        json={"metric": "lcp", "value": 223.4},
    )
    assert first.status_code == 202
    assert second.status_code == 429


def test_health_rum_rejects_invalid_token_when_provided(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)

    raw_client = TestClient(app)
    bad_token = raw_client.post(
        "/health/rum",
        headers={"x-automation-token": "wrong-token"},
        json={"metric": "lcp", "value": 123.4},
    )
    assert bad_token.status_code == 401
    assert bad_token.json()["detail"] == "invalid automation token"


def test_health_rum_accepts_with_valid_token_and_client_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)

    ok = client.post(
        "/health/rum",
        headers={
            "x-automation-token": ALT_AUTOMATION_TOKEN,
            "x-automation-client-id": "health-rum",
        },
        json={"metric": "lcp", "value": 123.4},
    )
    assert ok.status_code == 202
    payload = ok.json()
    assert payload["status"] == "accepted"
    assert payload["metric"] == "LCP"


def test_health_rum_accepts_legacy_web_vitals_metric() -> None:
    raw_client = TestClient(app)
    response = raw_client.post("/health/rum", json={"metric": "web_vitals_lcp", "value": 321.0})
    assert response.status_code == 202
    payload = response.json()
    assert payload["status"] == "accepted"
    assert payload["metric"] == "WEB_VITALS_LCP"
    assert payload["samples_total"] >= 1


def test_health_rum_rejects_unsupported_metric() -> None:
    raw_client = TestClient(app)
    response = raw_client.post("/health/rum", json={"metric": "unknown-metric", "value": 10.0})
    assert response.status_code == 422
    assert response.json()["detail"] == "unsupported rum metric"


def test_health_rum_rejects_negative_value_at_schema_boundary() -> None:
    raw_client = TestClient(app)
    response = raw_client.post("/health/rum", json={"metric": "LCP", "value": -1})

    assert response.status_code == 422
    assert any(item["loc"][-1] == "value" for item in response.json()["detail"])


def test_health_rum_rejects_boolean_timestamp_ms() -> None:
    raw_client = TestClient(app)
    response = raw_client.post(
        "/health/rum",
        json={"metric": "CLS", "value": 0.0, "timestampMs": False},
    )

    assert response.status_code == 422
    assert any(item["loc"][-1] == "timestampMs" for item in response.json()["detail"])


def test_command_tower_overview() -> None:
    response = client.get("/api/command-tower/overview")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["diagnostics"]["status"] == "ok"
    assert "task_counts" in payload["diagnostics"]
    assert "alerts" in payload
    assert "state" in payload["alerts"]


def test_command_tower_overview_requires_token_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)

    raw_client = TestClient(app)
    no_token = raw_client.get("/api/command-tower/overview")
    assert no_token.status_code == 401

    ok = client.get(
        "/api/command-tower/overview",
        headers={
            "x-automation-token": ALT_AUTOMATION_TOKEN,
            "x-automation-client-id": "health-command-tower",
        },
    )
    assert ok.status_code == 200


def test_command_tower_requires_client_id_when_token_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", ALT_AUTOMATION_TOKEN)
    raw_client = TestClient(app)
    missing_client_id = raw_client.get(
        "/api/command-tower/overview", headers={"x-automation-token": ALT_AUTOMATION_TOKEN}
    )
    assert missing_client_id.status_code == 400
    assert "x-automation-client-id" in missing_client_id.json()["detail"]


def test_command_tower_latest_flow_empty_when_no_session() -> None:
    runtime_root = Path(__file__).resolve().parents[3] / ".runtime-cache" / "automation"
    latest_pointer = runtime_root / "latest-session.json"
    backup = latest_pointer.read_text(encoding="utf-8") if latest_pointer.exists() else None
    if latest_pointer.exists():
        latest_pointer.unlink()
    try:
        response = client.get(
            "/api/command-tower/latest-flow",
            headers={
                "x-automation-token": TEST_AUTOMATION_TOKEN,
                "x-automation-client-id": "health-empty",
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["session_id"] is None
        assert payload["step_count"] == 0
        assert payload["steps"] == []
    finally:
        if backup is not None:
            runtime_root.mkdir(parents=True, exist_ok=True)
            latest_pointer.write_text(backup, encoding="utf-8")


def test_command_tower_latest_flow_reads_flow_draft() -> None:
    session_id = _create_command_tower_session("https://example.com/register")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"
    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/register",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 12,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/register"},
                    {
                        "step_id": "s2",
                        "action": "click",
                        "target": {"selectors": [{"kind": "css", "value": "#submit", "score": 80}]},
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    response = client.get("/api/command-tower/latest-flow", params={"session_id": session_id})
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["step_count"] == 2
    assert payload["start_url"] == "https://example.com/register"
    assert payload["steps"][1]["selector"] == "#submit"


def test_command_tower_latest_flow_handles_non_list_steps() -> None:
    session_id = _create_command_tower_session("https://example.com/register")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"
    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/register",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 12,
                "steps": {"broken": True},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    response = client.get("/api/command-tower/latest-flow", params={"session_id": session_id})
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["step_count"] == 0
    assert payload["steps"] == []


def test_command_tower_runtime_root_respects_env_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime_root = tmp_path / "automation"
    session_id = "ss_command_tower_override"
    session_dir = runtime_root / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "flow-draft.json").write_text(
        json.dumps(
            {
                "flow_id": "flow-override",
                "session_id": session_id,
                "start_url": "https://override.example.com",
                "steps": [{"step_id": "s1", "action": "navigate"}],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setattr(
        command_tower_api.universal_platform_service,
        "get_session",
        lambda _session_id, requester=None: SimpleNamespace(
            session_id=_session_id, owner=requester
        ),
    )

    response = client.get("/api/command-tower/latest-flow", params={"session_id": session_id})
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["start_url"] == "https://override.example.com"


def test_command_tower_cross_client_access_semantics() -> None:
    owner_headers = {
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "tower-owner",
    }
    attacker_headers = {
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "tower-attacker",
    }

    owner_session = client.post(
        "/api/sessions/start",
        headers=owner_headers,
        json={"start_url": "https://example.com/private", "mode": "manual"},
    )
    assert owner_session.status_code == 200
    session_id = owner_session.json()["session_id"]

    forbidden = client.get(
        "/api/command-tower/latest-flow",
        headers=attacker_headers,
        params={"session_id": session_id},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "session access denied"

    missing = client.get(
        "/api/command-tower/latest-flow",
        headers=attacker_headers,
        params={"session_id": "ss_not_found_for_attacker"},
    )
    assert missing.status_code == 404
    assert missing.json()["detail"] == "session not found"


def test_command_tower_latest_flow_draft_update() -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"
    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/start",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 3,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/start"}
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    response = client.patch(
        "/api/command-tower/latest-flow-draft",
        params={"session_id": session_id},
        json={
            "flow": {
                "start_url": "https://example.com/new-start",
                "steps": [{"action": "navigate", "url": "https://example.com/new-start"}],
            }
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["flow"]["start_url"] == "https://example.com/new-start"
    assert payload["flow"]["steps"][0]["step_id"] == "s1"


def test_command_tower_replay_latest_triggers_task(monkeypatch: pytest.MonkeyPatch) -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"

    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/start",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 1,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/start"}
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured["command_id"] = command_id
        captured["env"] = env_overrides
        captured["requested_by"] = requested_by
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="replay-task-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)
    response = client.post("/api/command-tower/replay-latest", params={"session_id": session_id})
    assert response.status_code == 200
    assert captured["command_id"] == "automation-replay-flow"
    assert captured["env"] == {"START_URL": "https://example.com/start"}
    payload = response.json()
    assert payload["task"]["task_id"] == "replay-task-1"


def test_command_tower_replay_latest_step_triggers_step_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"

    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/start",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 2,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/start"},
                    {
                        "step_id": "s2",
                        "action": "click",
                        "selected_selector_index": 1,
                        "target": {"selectors": [{"kind": "css", "value": "#a", "score": 80}]},
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured["command_id"] = command_id
        captured["env"] = env_overrides
        captured["requested_by"] = requested_by
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="replay-step-task-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)
    response = client.post(
        "/api/command-tower/replay-latest-step",
        params={"session_id": session_id},
        json={"step_id": "s2"},
    )
    assert response.status_code == 200
    assert captured["command_id"] == "automation-replay-flow-step"
    assert captured["env"] == {
        "FLOW_STEP_ID": "s2",
        "START_URL": "https://example.com/start",
        "FLOW_SELECTOR_INDEX": "1",
    }
    payload = response.json()
    assert payload["task"]["task_id"] == "replay-step-task-1"


def test_command_tower_replay_latest_step_ignores_dirty_selector_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"

    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest-dirty",
                "session_id": session_id,
                "start_url": "https://example.com/start",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 2,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/start"},
                    {
                        "step_id": "s2",
                        "action": "click",
                        "selected_selector_index": {"bad": "value"},
                        "target": {"selectors": [{"kind": "css", "value": "#a", "score": 80}]},
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured["command_id"] = command_id
        captured["env"] = env_overrides
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="replay-step-task-dirty-index",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)
    response = client.post(
        "/api/command-tower/replay-latest-step",
        params={"session_id": session_id},
        json={"step_id": "s2"},
    )
    assert response.status_code == 200
    assert captured["command_id"] == "automation-replay-flow-step"
    assert captured["env"] == {
        "FLOW_STEP_ID": "s2",
        "START_URL": "https://example.com/start",
    }


def test_command_tower_replay_latest_from_step_triggers_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    flow_path = session_dir / "flow-draft.json"

    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {
                "flow_id": "flow-pytest",
                "session_id": session_id,
                "start_url": "https://example.com/start",
                "generated_at": "2026-02-18T00:00:00Z",
                "source_event_count": 2,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://example.com/start"},
                    {
                        "step_id": "s2",
                        "action": "click",
                        "target": {"selectors": [{"kind": "css", "value": "#a", "score": 80}]},
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}

    def fake_run_command(
        command_id: str, env_overrides: dict[str, str], *, requested_by: str | None
    ):
        captured["command_id"] = command_id
        captured["env"] = env_overrides
        now = datetime.now(timezone.utc)
        return RunningTask(
            task_id="resume-task-1", command_id=command_id, status="queued", created_at=now
        ).snapshot()

    monkeypatch.setattr(automation_service, "run_command", fake_run_command)
    response = client.post(
        "/api/command-tower/replay-latest-from-step",
        params={"session_id": session_id},
        json={"step_id": "s2", "replay_preconditions": True},
    )
    assert response.status_code == 200
    assert captured["command_id"] == "automation-replay-flow"
    assert captured["env"] == {
        "FLOW_FROM_STEP_ID": "s2",
        "FLOW_REPLAY_PRECONDITIONS": "true",
        "START_URL": "https://example.com/start",
    }
    assert response.json()["task"]["task_id"] == "resume-task-1"


def test_command_tower_step_evidence_reads_latest_result() -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    result_path = session_dir / "replay-flow-step-result.json"
    evidence_dir = session_dir / "evidence"
    screenshot_before_path = evidence_dir / "s2-before.png"
    screenshot_after_path = evidence_dir / "s2-after.png"

    session_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    screenshot_before_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    screenshot_after_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    result_path.write_text(
        json.dumps(
            {
                "stepId": "s2",
                "action": "click",
                "ok": True,
                "detail": "clicked #btn",
                "duration_ms": 123,
                "matched_selector": "#btn",
                "selector_index": 0,
                "screenshot_before_path": str(screenshot_before_path),
                "screenshot_after_path": str(screenshot_after_path),
                "fallback_trail": [
                    {
                        "selector_index": 0,
                        "kind": "css",
                        "value": "#btn",
                        "normalized": "#btn",
                        "success": True,
                    }
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    response = client.get(
        "/api/command-tower/evidence", params={"step_id": "s2", "session_id": session_id}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["step_id"] == "s2"
    assert payload["matched_selector"] == "#btn"
    assert payload["duration_ms"] == 123
    assert isinstance(payload["screenshot_before_data_url"], str)
    assert isinstance(payload["screenshot_after_data_url"], str)
    assert payload["screenshot_before_data_url"].startswith("data:image/png;base64,")
    assert payload["screenshot_after_data_url"].startswith("data:image/png;base64,")
    assert payload["fallback_trail"][0]["success"] is True


def test_command_tower_latest_flow_ignores_symlink_session_dir() -> None:
    session_id = _create_command_tower_session("https://example.com")
    runtime_root = _command_tower_runtime_root()
    session_dir = _command_tower_session_dir(session_id)
    source_dir = runtime_root / f"{session_id}-source"
    flow_path = source_dir / "flow-draft.json"

    runtime_root.mkdir(parents=True, exist_ok=True)
    source_dir.mkdir(parents=True, exist_ok=True)
    flow_path.write_text(
        json.dumps(
            {"start_url": "https://example.com", "steps": [{"step_id": "s1", "action": "navigate"}]}
        ),
        encoding="utf-8",
    )
    if session_dir.exists() or session_dir.is_symlink():
        session_dir.unlink()
    session_dir.symlink_to(source_dir, target_is_directory=True)
    try:
        response = client.get("/api/command-tower/latest-flow", params={"session_id": session_id})
        assert response.status_code == 404
        assert response.json()["detail"] == "session directory not found"
    finally:
        if session_dir.exists() or session_dir.is_symlink():
            session_dir.unlink(missing_ok=True)


def test_command_tower_evidence_rejects_screenshot_traversal() -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    runtime_root = _command_tower_runtime_root()
    session_dir = _command_tower_session_dir(session_id)
    result_path = session_dir / "replay-flow-step-result.json"
    outside_file = runtime_root.parent / "not-allowed-screenshot.png"
    backup_outside = outside_file.read_bytes() if outside_file.exists() else None

    runtime_root.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    outside_file.write_bytes(b"\x89PNG\r\n\x1a\n")
    result_path.write_text(
        json.dumps(
            {
                "stepId": "s2",
                "action": "click",
                "ok": True,
                "screenshot_before_path": str(outside_file),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    try:
        response = client.get(
            "/api/command-tower/evidence", params={"step_id": "s2", "session_id": session_id}
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["screenshot_before_path"] is None
        assert payload["screenshot_before_data_url"] is None
    finally:
        if backup_outside is None:
            outside_file.unlink(missing_ok=True)
        else:
            outside_file.write_bytes(backup_outside)


def test_command_tower_evidence_timeline_reads_full_replay_result() -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    result_path = session_dir / "replay-flow-result.json"
    evidence_dir = session_dir / "evidence"
    before_path = evidence_dir / "s1-before.png"
    after_path = evidence_dir / "s1-after.png"

    session_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    before_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    after_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    result_path.write_text(
        json.dumps(
            {
                "stepResults": [
                    {
                        "step_id": "s1",
                        "action": "click",
                        "ok": True,
                        "detail": "clicked",
                        "duration_ms": 77,
                        "matched_selector": "#submit",
                        "selector_index": 1,
                        "screenshot_before_path": str(before_path),
                        "screenshot_after_path": str(after_path),
                        "fallback_trail": [
                            {"selector_index": 0, "kind": "css", "value": ".btn", "success": False}
                        ],
                    }
                ]
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    response = client.get("/api/command-tower/evidence-timeline", params={"session_id": session_id})
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["items"]) == 1
    item = payload["items"][0]
    assert item["step_id"] == "s1"
    assert item["duration_ms"] == 77
    assert item["screenshot_before_data_url"].startswith("data:image/png;base64,")
    assert item["screenshot_after_data_url"].startswith("data:image/png;base64,")
    assert item["fallback_trail"][0]["success"] is False


def test_command_tower_evidence_timeline_limit_clamped_by_max(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = _create_command_tower_session("https://example.com/start")
    session_dir = _command_tower_session_dir(session_id)
    result_path = session_dir / "replay-flow-result.json"

    session_dir.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
            {
                "stepResults": [
                    {"step_id": "s1", "action": "click"},
                    {"step_id": "s2", "action": "click"},
                    {"step_id": "s3", "action": "click"},
                    {"step_id": "s4", "action": "click"},
                ]
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "3")
    monkeypatch.setenv("COMMAND_TOWER_EVIDENCE_TIMELINE_MAX_LIMIT", "2")

    response = client.get(
        "/api/command-tower/evidence-timeline",
        params={"session_id": session_id, "limit": 50},
    )
    assert response.status_code == 200
    payload = response.json()
    assert [item["step_id"] for item in payload["items"]] == ["s1", "s2"]
