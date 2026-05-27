from __future__ import annotations

import importlib
import os
import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

import app.api.computer_use as computer_use_api
import app.core.access_control as access_control
import app.core.observability as observability
from app.services.computer_use_service import (
    ComputerUseAction,
    ComputerUseService,
    ComputerUseServiceError,
    ComputerUseSession,
)

observability.os = os
app = importlib.import_module("backend.app.main").app
computer_use_service_module = importlib.import_module("backend.app.services.computer_use_service")
client = TestClient(
    app,
    headers={"x-automation-token": "test-token", "x-automation-client-id": "pytest-computer-use"},
)


@pytest.fixture(autouse=True)
def _setup_access(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "test-token")
    access_control.reset_for_tests()


def test_create_session_returns_session_id(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_create_session(
        *, instruction: str, actor: str, model: str | None = None, metadata: dict | None = None
    ):
        assert instruction == "open github"
        assert actor
        return ComputerUseSession(
            session_id="cus_" + "a" * 32,
            instruction=instruction,
            model=model or "gemini-3.1-pro-preview",
            created_at="2026-02-22T00:00:00+00:00",
            created_by=actor,
            metadata=metadata or {},
        )

    monkeypatch.setattr(
        computer_use_api.computer_use_service, "create_session", fake_create_session
    )

    response = client.post("/api/computer-use/sessions", json={"instruction": "open github"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "cus_" + "a" * 32
    assert payload["model"] == "gemini-3.1-pro-preview"


def test_preview_rejects_invalid_session_id_pattern() -> None:
    response = client.post(
        "/api/computer-use/sessions/not-a-valid-session/preview",
        json={"screenshot_base64": None},
    )

    assert response.status_code == 422
    assert any(item["loc"][-1] == "session_id" for item in response.json()["detail"])


def test_preview_rejects_uppercase_session_id_pattern() -> None:
    response = client.post(
        "/api/computer-use/sessions/cus_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/preview",
        json={"screenshot_base64": None},
    )

    assert response.status_code == 422
    assert any(item["loc"][-1] == "session_id" for item in response.json()["detail"])


def test_preview_rejects_non_image_mime_type() -> None:
    session_id = "cus_" + "1" * 32
    response = client.post(
        f"/api/computer-use/sessions/{session_id}/preview",
        json={"screenshot_base64": None, "screenshot_mime_type": "application/json"},
    )

    assert response.status_code == 422
    assert any(item["loc"][-1] == "screenshot_mime_type" for item in response.json()["detail"])


def test_preview_confirm_execute_closed_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    session_id = "cus_" + "b" * 32
    action_id = "act_preview001"

    def fake_preview_action(**kwargs):
        assert kwargs["session_id"] == session_id
        return ComputerUseAction(
            action_id=action_id,
            name="click",
            args={"x": 100, "y": 120},
            rationale="open menu",
            risk_level="high",
            confirmation_reason="contains sensitive action",
            action_digest="abc123digest",
            require_confirmation=True,
            safety_decision="require_confirmation",
        )

    def fake_confirm_action(**kwargs):
        assert kwargs["action_id"] == action_id
        return ComputerUseAction(
            action_id=action_id,
            name="click",
            args={"x": 100, "y": 120},
            rationale="open menu",
            risk_level="high",
            confirmation_reason="approved by operator",
            action_digest="abc123digest",
            require_confirmation=True,
            safety_decision="require_confirmation",
            status="confirmed",
            confirmed_by="pytest",
        )

    def fake_execute_action(**kwargs):
        assert kwargs["action_id"] == action_id
        return {
            "actionId": action_id,
            "status": "executed",
            "executor": "backend-playwright-adapter",
            "executedAt": "2026-02-22T00:00:10+00:00",
            "executedBy": "pytest",
            "appliedArgs": {"x": 100, "y": 120},
            "riskLevel": "high",
            "confirmationReason": "approved by operator",
            "actionDigest": "abc123digest",
            "evidence": {
                "screens": [".runtime-cache/automation/computer-use/test.png"],
                "clips": [],
                "network_summary": {"request_count": 2},
                "dom_summary": {"title": "home"},
                "replay_trace": {"steps": [{"step": "click"}]},
            },
        }

    monkeypatch.setattr(
        computer_use_api.computer_use_service, "preview_action", fake_preview_action
    )
    monkeypatch.setattr(
        computer_use_api.computer_use_service, "confirm_action", fake_confirm_action
    )
    monkeypatch.setattr(
        computer_use_api.computer_use_service, "execute_action", fake_execute_action
    )

    preview = client.post(
        f"/api/computer-use/sessions/{session_id}/preview", json={"screenshot_base64": None}
    )
    assert preview.status_code == 200
    assert preview.json()["require_confirmation"] is True
    assert preview.json()["risk_level"] == "high"

    confirm = client.post(
        f"/api/computer-use/sessions/{session_id}/confirm/{action_id}",
        json={"approved": True, "confirmation_reason": "approved by operator"},
    )
    assert confirm.status_code == 200
    assert confirm.json()["status"] == "confirmed"

    execute = client.post(f"/api/computer-use/sessions/{session_id}/execute/{action_id}")
    assert execute.status_code == 200
    assert execute.json()["status"] == "executed"
    assert execute.json()["executor"] == "backend-playwright-adapter"
    assert execute.json()["evidence"]["network_summary"]["request_count"] == 2


def test_preview_forwards_include_thoughts_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    session_id = "cus_" + "a" * 32
    captured: list[bool | None] = []

    def fake_preview_action(**kwargs):
        captured.append(kwargs.get("include_thoughts"))
        return ComputerUseAction(
            action_id="act_include_thoughts",
            name="click",
            args={"x": 1, "y": 2},
            rationale="ok",
            risk_level="low",
            confirmation_reason=None,
            action_digest="digest-include-thoughts",
            require_confirmation=False,
            safety_decision="allow_auto_execute",
        )

    monkeypatch.setattr(
        computer_use_api.computer_use_service, "preview_action", fake_preview_action
    )

    explicit_false = client.post(
        f"/api/computer-use/sessions/{session_id}/preview",
        json={"screenshot_base64": None, "include_thoughts": False},
    )
    assert explicit_false.status_code == 200

    implicit_default = client.post(
        f"/api/computer-use/sessions/{session_id}/preview",
        json={"screenshot_base64": None},
    )
    assert implicit_default.status_code == 200
    assert captured == [False, None]


def test_execute_maps_confirmation_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_execute_action(**kwargs):
        raise ComputerUseServiceError(
            "action requires confirmation before execution", status_code=409
        )

    monkeypatch.setattr(
        computer_use_api.computer_use_service, "execute_action", fake_execute_action
    )

    response = client.post(f"/api/computer-use/sessions/{'cus_' + 'c' * 32}/execute/act_missing")
    assert response.status_code == 409
    assert response.json()["detail"] == "action requires confirmation before execution"


def test_read_evidence_returns_events(monkeypatch: pytest.MonkeyPatch) -> None:
    session_id = "cus_" + "d" * 32

    def fake_read_evidence(*, session_id: str, actor: str):
        _ = actor
        return {
            "sessionId": session_id,
            "eventCount": 2,
            "events": [
                {"event": "session_created"},
                {"event": "action_executed"},
            ],
            "evidencePath": ".runtime-cache/automation/computer-use/evidence.jsonl",
        }

    monkeypatch.setattr(computer_use_api.computer_use_service, "read_evidence", fake_read_evidence)

    response = client.get(f"/api/computer-use/sessions/{session_id}/evidence")
    assert response.status_code == 200
    payload = response.json()
    assert payload["event_count"] == 2
    assert len(payload["events"]) == 2


def test_read_evidence_forbidden_for_non_owner() -> None:
    owner_client = TestClient(
        app,
        headers={
            "x-automation-token": "test-token",
            "x-automation-client-id": "owner-client",
        },
    )
    attacker_client = TestClient(
        app,
        headers={
            "x-automation-token": "test-token",
            "x-automation-client-id": "attacker-client",
        },
    )

    created = owner_client.post(
        "/api/computer-use/sessions", json={"instruction": "open secure settings"}
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]

    forbidden = attacker_client.get(f"/api/computer-use/sessions/{session_id}/evidence")
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "forbidden: session does not belong to actor"


def test_execute_action_is_mutex_and_idempotent_under_concurrency() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="actor-owner")
    expected_session_id = session.session_id
    action = ComputerUseAction(
        action_id="act_race001",
        name="click",
        args={"selector": "#submit"},
        rationale="submit action",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-race",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )
    session.actions[action.action_id] = action

    invoke_count = {"value": 0}
    count_lock = threading.Lock()

    def fake_execute_with_playwright(
        *, session: ComputerUseSession, action: ComputerUseAction, actor: str
    ):
        assert session.session_id == expected_session_id
        assert action.action_id == "act_race001"
        assert actor == "actor-owner"
        with count_lock:
            invoke_count["value"] += 1
        time.sleep(0.12)
        return {
            "executor": "backend-playwright-adapter",
            "evidence": {"network_summary": {"request_count": 1}},
        }

    service._execute_with_playwright = fake_execute_with_playwright  # type: ignore[method-assign]

    results: list[dict] = []
    errors: list[BaseException] = []
    result_lock = threading.Lock()

    def run_execute() -> None:
        try:
            result = service.execute_action(
                session_id=session.session_id, action_id=action.action_id, actor="actor-owner"
            )
            with result_lock:
                results.append(result)
        except BaseException as exc:  # pragma: no cover
            with result_lock:
                errors.append(exc)

    t1 = threading.Thread(target=run_execute)
    t2 = threading.Thread(target=run_execute)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert errors == []
    assert len(results) == 2
    assert invoke_count["value"] == 1
    assert results[0]["status"] == "executed"
    assert results[1]["status"] == "executed"
    assert results[0]["actionId"] == "act_race001"
    assert results[1]["actionId"] == "act_race001"
    assert results[0]["executedAt"] == results[1]["executedAt"]


def test_confirm_and_execute_forbidden_for_non_owner() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open profile", actor="actor-owner")
    action = ComputerUseAction(
        action_id="act_owner001",
        name="click",
        args={"selector": "#save"},
        rationale="save profile",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-owner",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )
    session.actions[action.action_id] = action

    with pytest.raises(ComputerUseServiceError) as confirm_error:
        service.confirm_action(
            session_id=session.session_id,
            action_id=action.action_id,
            actor="actor-attacker",
            approved=True,
        )
    assert confirm_error.value.status_code == 403

    with pytest.raises(ComputerUseServiceError) as execute_error:
        service.execute_action(
            session_id=session.session_id,
            action_id=action.action_id,
            actor="actor-attacker",
        )
    assert execute_error.value.status_code == 403


def test_execute_action_is_idempotent_on_repeat_calls() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open account page", actor="actor-owner")
    action = ComputerUseAction(
        action_id="act_idempotent001",
        name="click",
        args={"selector": "#confirm"},
        rationale="confirm dialog",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-idempotent",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )
    session.actions[action.action_id] = action

    invoke_count = {"value": 0}

    def fake_execute_with_playwright(
        *, session: ComputerUseSession, action: ComputerUseAction, actor: str
    ):
        _ = session
        _ = action
        _ = actor
        invoke_count["value"] += 1
        return {
            "executor": "backend-playwright-adapter",
            "evidence": {"dom_summary": {"title": "done"}},
        }

    service._execute_with_playwright = fake_execute_with_playwright  # type: ignore[method-assign]

    first = service.execute_action(
        session_id=session.session_id, action_id=action.action_id, actor="actor-owner"
    )
    second = service.execute_action(
        session_id=session.session_id, action_id=action.action_id, actor="actor-owner"
    )

    assert invoke_count["value"] == 1
    assert first["status"] == "executed"
    assert second["status"] == "executed"
    assert first["executedAt"] == second["executedAt"]
    assert first["evidence"] == second["evidence"]


def test_computer_use_requires_token() -> None:
    raw_client = TestClient(app)
    response = raw_client.post("/api/computer-use/sessions", json={"instruction": "open browser"})
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid automation token"


def test_execute_action_fails_when_node_binary_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="actor-owner")
    action = ComputerUseAction(
        action_id="act_missing_node",
        name="click",
        args={"selector": "#submit"},
        rationale="submit action",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-missing-node",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )
    session.actions[action.action_id] = action
    monkeypatch.setattr(service, "_node_binary", None)

    with pytest.raises(ComputerUseServiceError) as error:
        service.execute_action(
            session_id=session.session_id,
            action_id=action.action_id,
            actor="actor-owner",
        )
    assert error.value.status_code == 503
    assert "node executable not found" in str(error.value)


def test_resolve_node_binary_accepts_command_name_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_node = tmp_path / "node"
    fake_node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake_node.chmod(0o755)
    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", "node")
    monkeypatch.setattr(
        computer_use_service_module,
        "which",
        lambda name: str(fake_node) if name == "node" else None,
    )
    assert ComputerUseService._resolve_node_binary() == str(fake_node.resolve())


def test_resolve_include_thoughts_prefers_explicit_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ComputerUseService()
    monkeypatch.setenv("GEMINI_INCLUDE_THOUGHTS", "true")
    assert service._resolve_include_thoughts(False) is False
    assert service._resolve_include_thoughts(True) is True


def test_resolve_include_thoughts_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ComputerUseService()
    monkeypatch.setenv("GEMINI_INCLUDE_THOUGHTS", "false")
    assert service._resolve_include_thoughts(None) is False
    monkeypatch.setenv("GEMINI_INCLUDE_THOUGHTS", "invalid")
    assert service._resolve_include_thoughts(None) is True
