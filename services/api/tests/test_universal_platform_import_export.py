from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.main import app
from app.services.automation_service import RunningTask, automation_service

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


def test_import_latest_flow_rejects_session_dir_outside_runtime_root(tmp_path: Path) -> None:
    runtime = Path(os.environ["UNIVERSAL_AUTOMATION_RUNTIME_DIR"])
    runtime.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside-session"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "flow-draft.json").write_text(
        json.dumps(
            {
                "start_url": "https://outside.example.com",
                "steps": [{"step_id": "s1", "action": "navigate"}],
            }
        ),
        encoding="utf-8",
    )
    (runtime / "latest-session.json").write_text(
        json.dumps({"sessionId": "ss_out", "sessionDir": str(outside)}),
        encoding="utf-8",
    )
    resp = client.post("/api/flows/import-latest")
    assert resp.status_code == 400
    assert "outside runtime root" in resp.json()["detail"]


def test_universal_import_latest_flow_and_patch() -> None:
    runtime = Path(os.environ.get("UNIVERSAL_AUTOMATION_RUNTIME_DIR", ""))
    if not runtime:
        root = Path(__file__).resolve().parents[3]
        runtime = root / ".runtime-cache" / "automation"
    session_dir = runtime / "pytest-universal-import"
    runtime.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    (runtime / "latest-session.json").write_text(
        json.dumps(
            {"sessionId": "ss_import", "sessionDir": str(session_dir)}, ensure_ascii=False, indent=2
        ),
        encoding="utf-8",
    )
    (session_dir / "flow-draft.json").write_text(
        json.dumps(
            {
                "start_url": "https://import.example.com",
                "source_event_count": 3,
                "steps": [
                    {"step_id": "s1", "action": "navigate", "url": "https://import.example.com"}
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    imported = client.post("/api/flows/import-latest")
    assert imported.status_code == 200
    flow_id = imported.json()["flow_id"]
    assert imported.json()["session_id"] == "ss_import"

    patched = client.patch(
        f"/api/flows/{flow_id}",
        json={
            "start_url": "https://import-updated.example.com",
            "steps": [
                {"step_id": "s1", "action": "navigate", "url": "https://import-updated.example.com"}
            ],
        },
    )
    assert patched.status_code == 200
    assert patched.json()["start_url"] == "https://import-updated.example.com"

    invalid_steps = client.patch(
        f"/api/flows/{flow_id}",
        json={"steps": [{}]},
    )
    assert invalid_steps.status_code == 422
    assert invalid_steps.headers["content-type"].startswith("application/json")

    flow_method_not_allowed = client.patch("/api/flows/import-latest")
    assert flow_method_not_allowed.status_code == 405
    assert flow_method_not_allowed.headers.get("allow") == "POST"

    template_method_not_allowed = client.patch("/api/templates/from-artifacts")
    assert template_method_not_allowed.status_code == 405
    assert template_method_not_allowed.headers.get("allow") == "POST"
