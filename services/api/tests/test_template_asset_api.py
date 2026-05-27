from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.main import app

TEST_AUTOMATION_TOKEN = "test-token-0123456789"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-template-assets",
    },
)


@pytest.fixture(autouse=True)
def reset_template_assets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    access_control.reset_for_tests()
    universal_dir = Path(os.environ.get("UNIVERSAL_PLATFORM_DATA_DIR", "")).resolve()
    if universal_dir.exists():
        shutil.rmtree(universal_dir)
    universal_dir.mkdir(parents=True, exist_ok=True)


def _create_flow() -> str:
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com", "mode": "manual"}
    ).json()["session_id"]
    return client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        },
    ).json()["flow_id"]


def test_template_promotion_history_and_recommendation_flow() -> None:
    flow_id = _create_flow()
    promoted = client.post(
        "/api/templates/promote",
        json={
            "flow_id": flow_id,
            "template_name": "promoted-template",
            "change_note": "initial promotion",
            "recommended": True,
        },
    )
    assert promoted.status_code == 200
    first = promoted.json()
    assert first["template_family_id"] == first["template_id"]
    assert first["version"] == 1
    assert first["recommended"] is True

    forked = client.post(
        f"/api/templates/{first['template_id']}/fork-version",
        json={"template_name": "promoted-template-v2", "change_note": "branch v2"},
    )
    assert forked.status_code == 200
    second = forked.json()
    assert second["template_family_id"] == first["template_family_id"]
    assert second["parent_template_id"] == first["template_id"]
    assert second["version"] == 2

    recommended = client.post(f"/api/templates/{second['template_id']}/mark-recommended")
    assert recommended.status_code == 200
    assert recommended.json()["recommended"] is True

    history = client.get(f"/api/templates/{first['template_id']}/history")
    assert history.status_code == 200
    history_payload = history.json()["templates"]
    assert len(history_payload) == 2
    assert history_payload[0]["template_id"] == second["template_id"]
    assert history_payload[0]["recommended"] is True
    assert history_payload[1]["recommended"] is False
