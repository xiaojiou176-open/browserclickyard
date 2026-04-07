from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.dependencies.security import require_automation_access
from app.models.flow import FlowStep


def _fake_request(path: str, host: str = "127.0.0.1") -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "path": path,
        "raw_path": path.encode("latin-1"),
        "scheme": "http",
        "query_string": b"",
        "headers": [],
        "client": (host, 1234),
        "server": ("testserver", 80),
    }
    return Request(scope)


def test_require_automation_access_returns_trimmed_client_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.check_token",
        lambda request, token: "verified-token",
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.check_rate_limit",
        lambda request, verified_token: None,
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.requester_id",
        lambda request, verified_token: "actor-1",
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.env_str",
        lambda key, default="": "configured-token" if key == "AUTOMATION_API_TOKEN" else default,
    )

    context = require_automation_access(
        _fake_request("/api/automation/tasks"),
        x_automation_token=" provided-token ",
        x_automation_client_id=" client-a ",
    )

    assert context.actor == "actor-1"
    assert context.verified_actor == "actor-1"
    assert context.verified_token == "verified-token"
    assert context.client_host == "127.0.0.1"
    assert context.path == "/api/automation/tasks"
    assert context.client_id == "client-a"


def test_require_automation_access_rejects_missing_client_id_for_overview(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.check_token",
        lambda request, token: "verified-token",
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.check_rate_limit",
        lambda request, verified_token: None,
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.requester_id",
        lambda request, verified_token: "actor-1",
    )
    monkeypatch.setattr(
        "backend.app.api.dependencies.security.env_str",
        lambda key, default="": "configured-token" if key == "AUTOMATION_API_TOKEN" else default,
    )

    with pytest.raises(HTTPException) as exc_info:
        require_automation_access(
            _fake_request("/api/command-tower/overview"),
            x_automation_token="provided-token",
            x_automation_client_id="   ",
        )

    assert exc_info.value.status_code == 400
    assert "x-automation-client-id" in str(exc_info.value.detail)


def test_flow_step_confidence_is_clamped_to_zero() -> None:
    step = FlowStep(step_id="step-1", action="click", confidence=-0.4)

    assert step.confidence == 0.0


def test_flow_step_confidence_is_clamped_to_one() -> None:
    step = FlowStep(step_id="step-2", action="click", confidence=1.6)

    assert step.confidence == 1.0
