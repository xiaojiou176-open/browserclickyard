from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.api.command_tower as command_tower
from app.api.dependencies.security import AutomationSecurityContext
from app.models.automation import (
    FlowDraftDocumentUpdateRequest,
    ReplayFromStepRequest,
    ReplayLatestStepRequest,
    StepEvidenceResponse,
    TaskSnapshot,
)


def _security(actor: str = "qa-owner") -> AutomationSecurityContext:
    return AutomationSecurityContext(
        actor=actor,
        verified_actor=actor,
        client_host="testclient",
        path="/api/command-tower",
        x_automation_token=None,
        verified_token=None,
        client_id="pytest-client",
    )


def _snapshot(task_id: str = "task-1") -> TaskSnapshot:
    now = datetime.now(timezone.utc)
    return TaskSnapshot(
        task_id=task_id,
        command="script-pipeline-capture",
        command_id="script-pipeline-capture",
        status="queued",
        created_at=now,
        updated_at=now,
    )


def test_latest_flow_draft_returns_empty_when_no_draft(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: None,
    )
    response = command_tower.latest_flow_draft(_security())
    assert response.session_id is None
    assert response.flow is None


def test_update_and_replay_latest_flow_raise_404_when_draft_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: None,
    )
    with pytest.raises(HTTPException) as update_exc:
        command_tower.update_latest_flow_draft(
            FlowDraftDocumentUpdateRequest(flow={"start_url": "https://example.com", "steps": []}),
            _security(),
        )
    assert update_exc.value.status_code == 404

    with pytest.raises(HTTPException) as replay_exc:
        command_tower.replay_latest_flow(_security())
    assert replay_exc.value.status_code == 404


def test_replay_latest_from_step_covers_blank_not_found_and_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flow = {
        "start_url": "https://example.com",
        "steps": [{"step_id": "s1", "action": "click"}],
    }
    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: ("session-1", Path("/tmp"), flow),
    )

    with pytest.raises(HTTPException) as blank_exc:
        command_tower.replay_latest_flow_from_step(
            ReplayFromStepRequest(step_id="  "),
            _security(),
        )
    assert blank_exc.value.status_code == 422

    with pytest.raises(HTTPException) as missing_exc:
        command_tower.replay_latest_flow_from_step(
            ReplayFromStepRequest(step_id="not-exists"),
            _security(),
        )
    assert missing_exc.value.status_code == 404

    captured: dict[str, object] = {}

    def _fake_run_command(command_id: str, env: dict[str, str], *, requested_by: str | None = None):
        captured["command_id"] = command_id
        captured["env"] = dict(env)
        captured["requested_by"] = requested_by
        return _snapshot("replay-from-step")

    monkeypatch.setattr(command_tower.automation_service, "run_command", _fake_run_command)
    response = command_tower.replay_latest_flow_from_step(
        ReplayFromStepRequest(step_id="s1", replay_preconditions=True),
        _security("owner-a"),
    )
    assert response.task.task_id == "replay-from-step"
    assert captured["command_id"] == "automation-replay-flow"
    assert captured["requested_by"] == "owner-a"
    assert captured["env"] == {
        "FLOW_FROM_STEP_ID": "s1",
        "FLOW_REPLAY_PRECONDITIONS": "true",
        "START_URL": "https://example.com",
    }


def test_replay_latest_step_covers_errors_and_selector_index_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flow = {
        "start_url": "https://example.com/start",
        "steps": [{"step_id": "s1", "action": "fill", "selected_selector_index": -3}],
    }

    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: None,
    )
    with pytest.raises(HTTPException) as no_draft_exc:
        command_tower.replay_latest_flow_step(ReplayLatestStepRequest(step_id="s1"), _security())
    assert no_draft_exc.value.status_code == 404

    monkeypatch.setattr(
        command_tower,
        "load_latest_flow_draft",
        lambda requester, session_id=None: ("session-1", Path("/tmp"), flow),
    )
    with pytest.raises(HTTPException) as blank_exc:
        command_tower.replay_latest_flow_step(ReplayLatestStepRequest(step_id=" "), _security())
    assert blank_exc.value.status_code == 422

    with pytest.raises(HTTPException) as missing_step_exc:
        command_tower.replay_latest_flow_step(
            ReplayLatestStepRequest(step_id="s-missing"),
            _security(),
        )
    assert missing_step_exc.value.status_code == 404

    captured: dict[str, object] = {}

    def _fake_run_command(command_id: str, env: dict[str, str], *, requested_by: str | None = None):
        captured["command_id"] = command_id
        captured["env"] = dict(env)
        captured["requested_by"] = requested_by
        return _snapshot("replay-step")

    monkeypatch.setattr(command_tower.automation_service, "run_command", _fake_run_command)
    response = command_tower.replay_latest_flow_step(
        ReplayLatestStepRequest(step_id="s1"),
        _security("owner-b"),
    )
    assert response.task.task_id == "replay-step"
    assert captured["command_id"] == "automation-replay-flow-step"
    assert captured["requested_by"] == "owner-b"
    assert captured["env"] == {
        "FLOW_STEP_ID": "s1",
        "START_URL": "https://example.com/start",
        "FLOW_SELECTOR_INDEX": "0",
    }


def test_step_evidence_and_timeline_cover_error_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(HTTPException) as blank_exc:
        command_tower.step_evidence(" ", _security())
    assert blank_exc.value.status_code == 422

    monkeypatch.setattr(
        command_tower,
        "resolve_session_for_requester",
        lambda requester, session_id=None: None,
    )
    with pytest.raises(HTTPException) as no_session_exc:
        command_tower.step_evidence("s1", _security())
    assert no_session_exc.value.status_code == 404

    monkeypatch.setattr(
        command_tower,
        "resolve_session_for_requester",
        lambda requester, session_id=None: ("session-1", Path("/tmp/session")),
    )
    monkeypatch.setattr(command_tower, "merge_step_evidence", lambda session_dir, step_id: None)
    with pytest.raises(HTTPException) as no_evidence_exc:
        command_tower.step_evidence("s1", _security())
    assert no_evidence_exc.value.status_code == 404

    monkeypatch.setattr(
        command_tower,
        "merge_step_evidence",
        lambda session_dir, step_id: StepEvidenceResponse(step_id=step_id, action="click"),
    )
    success = command_tower.step_evidence("s1", _security())
    assert success.step_id == "s1"

    monkeypatch.setattr(
        command_tower,
        "resolve_session_for_requester",
        lambda requester, session_id=None: None,
    )
    timeline = command_tower.evidence_timeline(_security(), limit="3")
    assert timeline.items == []


def test_resolve_session_for_requester_raises_when_explicit_session_dir_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        command_tower.universal_platform_service,
        "get_session",
        lambda session_id, requester: SimpleNamespace(session_id=session_id),
    )
    monkeypatch.setattr(command_tower, "_validated_session_dir", lambda runtime_root, raw: None)

    with pytest.raises(HTTPException) as exc:
        command_tower.resolve_session_for_requester("actor-a", session_id="explicit-session")
    assert exc.value.status_code == 404
