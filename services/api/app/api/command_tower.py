from __future__ import annotations

import json
import base64
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import status

from app.core.runtime_paths import automation_runtime_root
from app.core.settings import env_str
from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import COMMON_ERROR_RESPONSES
from app.api.health import build_alerts_payload, build_diagnostics_payload
from app.models.automation import (
    EvidenceTimelineItemResponse,
    EvidenceTimelineResponse,
    FlowDraftDocumentResponse,
    FlowDraftDocumentUpdateRequest,
    FlowPreviewResponse,
    FlowPreviewStep,
    OrchestrateFromArtifactsRequest,
    OrchestrateFromArtifactsResponse,
    ReplayFromStepRequest,
    ReplayLatestStepRequest,
    StepEvidenceResponse,
    RunCommandResponse,
)
from app.services.automation_service import automation_service
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/command-tower", tags=["command-tower"], responses=COMMON_ERROR_RESPONSES
)
_RUNTIME_AUTOMATION_ROOT = automation_runtime_root(Path(__file__).resolve().parents[4]).resolve()
_SESSION_ID_QUERY_PATTERN = r"^(ss_[A-Za-z0-9_:-]{1,128}|null|None)$"
_NULLISH_QUERY_VALUES = {"null", "none"}
_SESSION_ID_RUNTIME_PATTERN = re.compile(r"^ss_[A-Za-z0-9_:-]{1,128}$")


@router.get("/overview")
def overview(
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> dict[str, object]:
    return {
        "status": "ok",
        "diagnostics": build_diagnostics_payload(),
        "alerts": build_alerts_payload(),
        "latest_flow": latest_flow_preview(security.actor),
    }


@router.get("/latest-flow", response_model=FlowPreviewResponse)
def latest_flow(
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> FlowPreviewResponse:
    return latest_flow_preview(security.actor, session_id=session_id)


@router.get("/latest-flow-draft", response_model=FlowDraftDocumentResponse)
def latest_flow_draft(
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> FlowDraftDocumentResponse:
    loaded = load_latest_flow_draft(security.actor, session_id=session_id)
    if loaded is None:
        return FlowDraftDocumentResponse()
    session_id, _, flow = loaded
    return FlowDraftDocumentResponse(session_id=session_id, flow=flow)


@router.patch("/latest-flow-draft", response_model=FlowDraftDocumentResponse)
def update_latest_flow_draft(
    payload: FlowDraftDocumentUpdateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> FlowDraftDocumentResponse:
    loaded = load_latest_flow_draft(security.actor, session_id=session_id)
    if loaded is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
        )
    session_id, session_dir, current = loaded

    updated = normalize_flow_draft_update(payload.flow, current)
    flow_draft_path = _session_file_path(session_dir, "flow-draft.json", must_exist=True)
    if flow_draft_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
        )
    _write_json_document(flow_draft_path, updated)
    return FlowDraftDocumentResponse(session_id=session_id, flow=updated)


@router.post("/replay-latest", response_model=RunCommandResponse)
def replay_latest_flow(
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> RunCommandResponse:
    loaded = load_latest_flow_draft(security.actor, session_id=session_id)
    if loaded is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
        )
    _, _, flow = loaded
    env: dict[str, str] = {}
    start_url = flow.get("start_url")
    if isinstance(start_url, str) and start_url.strip():
        env["START_URL"] = start_url.strip()
    task = automation_service.run_command(
        "automation-replay-flow",
        env,
        requested_by=security.actor,
    )
    return RunCommandResponse(task=task)


@router.post("/orchestrate-from-artifacts", response_model=OrchestrateFromArtifactsResponse)
def orchestrate_from_artifacts(
    payload: OrchestrateFromArtifactsRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> OrchestrateFromArtifactsResponse:
    return universal_platform_service.create_template_from_artifacts(
        payload,
        actor=security.actor,
    )


@router.post("/replay-latest-from-step", response_model=RunCommandResponse)
def replay_latest_flow_from_step(
    payload: ReplayFromStepRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> RunCommandResponse:
    loaded = load_latest_flow_draft(security.actor, session_id=session_id)
    if loaded is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
        )
    _, _, flow = loaded
    step_id = payload.step_id.strip()
    if not step_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="step_id is required"
        )
    exists = any(
        isinstance(item, dict) and item.get("step_id") == step_id for item in _flow_steps(flow)
    )
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="step not found in latest flow draft"
        )

    env: dict[str, str] = {"FLOW_FROM_STEP_ID": step_id}
    if payload.replay_preconditions:
        env["FLOW_REPLAY_PRECONDITIONS"] = "true"
    start_url = flow.get("start_url")
    if isinstance(start_url, str) and start_url.strip():
        env["START_URL"] = start_url.strip()
    task = automation_service.run_command(
        "automation-replay-flow",
        env,
        requested_by=security.actor,
    )
    return RunCommandResponse(task=task)


@router.post("/replay-latest-step", response_model=RunCommandResponse)
def replay_latest_flow_step(
    payload: ReplayLatestStepRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> RunCommandResponse:
    loaded = load_latest_flow_draft(security.actor, session_id=session_id)
    if loaded is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
        )
    _, _, flow = loaded
    step_id = payload.step_id.strip()
    if not step_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="step_id is required"
        )
    target_step = next(
        (
            item
            for item in _flow_steps(flow)
            if isinstance(item, dict) and item.get("step_id") == step_id
        ),
        None,
    )
    if target_step is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="step not found in latest flow draft"
        )

    env: dict[str, str] = {"FLOW_STEP_ID": step_id}
    start_url = flow.get("start_url")
    if isinstance(start_url, str) and start_url.strip():
        env["START_URL"] = start_url.strip()

    selector_index = (
        target_step.get("selected_selector_index") if isinstance(target_step, dict) else None
    )
    selector_index_value = _to_safe_int(selector_index)
    if selector_index_value is not None:
        env["FLOW_SELECTOR_INDEX"] = str(max(0, selector_index_value))

    task = automation_service.run_command(
        "automation-replay-flow-step",
        env,
        requested_by=security.actor,
    )
    return RunCommandResponse(task=task)


@router.get("/evidence", response_model=StepEvidenceResponse)
def step_evidence(
    step_id: str = Query(min_length=1, max_length=128, pattern=r"^\S(?:.*\S)?$"),
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
) -> StepEvidenceResponse:
    step_key = step_id.strip()
    if not step_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="step_id is required"
        )
    session = resolve_session_for_requester(security.actor, session_id=session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="latest session not found"
        )
    _, session_dir = session
    merged = merge_step_evidence(session_dir, step_key)
    if merged is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="step evidence not found")
    return merged


@router.get("/evidence-timeline", response_model=EvidenceTimelineResponse)
def evidence_timeline(
    security: AutomationSecurityContext = Depends(require_automation_access),
    session_id: str | None = Query(default=None, pattern=_SESSION_ID_QUERY_PATTERN),
    limit: str | None = Query(default=None, pattern=r"^(null|[1-9][0-9]{0,8})$"),
) -> EvidenceTimelineResponse:
    parsed_limit = _parse_nullable_int(limit)
    session = resolve_session_for_requester(security.actor, session_id=session_id)
    if session is None:
        return EvidenceTimelineResponse()
    _, session_dir = session
    items = read_timeline_items(session_dir, limit=resolve_timeline_limit(parsed_limit))
    return EvidenceTimelineResponse(items=items)


def resolve_session_for_requester(
    requester: str, session_id: str | None = None
) -> tuple[str, Path] | None:
    normalized_session_id = _normalize_optional_session_id(session_id)
    if normalized_session_id is not None and not normalized_session_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="session_id is required when provided",
        )
    if normalized_session_id is not None:
        session = universal_platform_service.get_session(normalized_session_id, requester=requester)
        session_dir_path = _validated_session_dir(runtime_root(), normalized_session_id)
        if session_dir_path is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="session directory not found"
            )
        return session.session_id, session_dir_path

    sessions = universal_platform_service.list_sessions(limit=1, requester=requester)
    if not sessions:
        return None
    latest_owned = sessions[0]
    session_dir_path = _validated_session_dir(runtime_root(), latest_owned.session_id)
    if session_dir_path is None:
        return None
    return latest_owned.session_id, session_dir_path


def _normalize_optional_session_id(session_id: str | None) -> str | None:
    if session_id is None:
        return None
    normalized = session_id.strip()
    if not normalized:
        return ""
    if normalized.lower() in _NULLISH_QUERY_VALUES:
        return None
    return normalized


def runtime_root() -> Path:
    override = env_str("UNIVERSAL_AUTOMATION_RUNTIME_DIR", "").strip()
    if not override:
        return _RUNTIME_AUTOMATION_ROOT
    try:
        return Path(override).expanduser().resolve()
    except OSError:
        return _RUNTIME_AUTOMATION_ROOT


def resolve_latest_session() -> tuple[str, Path] | None:
    latest_path = _runtime_metadata_path(runtime_root(), "latest-session.json")
    if latest_path is None:
        return None
    try:
        payload = _read_json_document(latest_path)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str) or not session_id.strip():
        return None
    validated = _validated_session_dir(runtime_root(), session_id.strip())
    if validated is None:
        return None
    return session_id.strip(), validated


def _to_safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_nullable_int(value: str | None) -> int | None:
    if value is None or value == "null":
        return None
    assert value is not None
    return int(value)


def _flow_steps(flow: dict[str, Any]) -> list[dict[str, Any]]:
    raw_steps = flow.get("steps")
    if not isinstance(raw_steps, list):
        return []
    return [step for step in raw_steps if isinstance(step, dict)]


def _validated_session_dir(runtime_root: Path, session_dir_raw: str) -> Path | None:
    session_id = session_dir_raw.strip()
    if not session_id:
        return None
    if not _SESSION_ID_RUNTIME_PATTERN.fullmatch(session_id):
        return None
    session_dir = runtime_root / session_id
    # Reject explicit symlink leaf dirs, but allow runtime_root itself to be under
    # a symlinked workspace path. We validate containment via resolved paths below.
    if session_dir.is_symlink():
        return None
    if not session_dir.exists() or not session_dir.is_dir():
        return None
    resolved_root = _real_resolved_path(runtime_root)
    resolved = _real_resolved_path(session_dir)
    if resolved_root is None or resolved is None:
        return None
    if not _is_within_root(resolved_root, resolved):
        return None
    return resolved


def _real_resolved_path(path: Path) -> Path | None:
    try:
        return Path(os.path.realpath(os.fspath(path)))
    except OSError:
        return None


def _is_within_root(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((os.fspath(root), os.fspath(candidate))) == os.fspath(root)
    except ValueError:
        return False


def _runtime_metadata_path(runtime_root_path: Path, file_name: str) -> Path | None:
    if "/" in file_name or "\\" in file_name or not file_name:
        return None
    resolved_root = _real_resolved_path(runtime_root_path)
    if resolved_root is None:
        return None
    candidate = resolved_root / file_name
    resolved = _real_resolved_path(candidate)
    if resolved is None or not _is_within_root(resolved_root, resolved):
        return None
    if not resolved.exists() or not resolved.is_file():
        return None
    return resolved


def _session_file_path(session_dir: Path, file_name: str, *, must_exist: bool) -> Path | None:
    if "/" in file_name or "\\" in file_name or not file_name:
        return None
    resolved_session_dir = _real_resolved_path(session_dir)
    if resolved_session_dir is None or not resolved_session_dir.exists() or not resolved_session_dir.is_dir():
        return None
    candidate = resolved_session_dir / file_name
    resolved = _real_resolved_path(candidate)
    if resolved is None or not _is_within_root(resolved_session_dir, resolved):
        return None
    if must_exist and (not resolved.exists() or not resolved.is_file()):
        return None
    return resolved


def _read_json_document(document_path: Path) -> Any:
    with open(os.fspath(document_path), encoding="utf-8") as handle:
        return json.load(handle)


def _write_json_document(document_path: Path, payload: Any) -> None:
    with open(os.fspath(document_path), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def load_latest_flow_draft(
    requester: str | None = None, session_id: str | None = None
) -> tuple[str, Path, dict[str, Any]] | None:
    if requester is None:
        latest = resolve_latest_session()
        if latest is None:
            return None
        session_id, session_dir = latest
        flow_draft_path = _session_file_path(session_dir, "flow-draft.json", must_exist=True)
        if flow_draft_path is None:
            return None
        try:
            flow = _read_json_document(flow_draft_path)
        except json.JSONDecodeError:
            return None
        if not isinstance(flow, dict):
            return None
        return session_id, session_dir, flow

    session = resolve_session_for_requester(requester, session_id=session_id)
    if session is None:
        return None
    session_id, session_dir = session
    flow_draft_path = _session_file_path(session_dir, "flow-draft.json", must_exist=True)
    if flow_draft_path is None:
        return None
    try:
        flow = _read_json_document(flow_draft_path)
    except json.JSONDecodeError:
        return None
    if not isinstance(flow, dict):
        return None
    return session_id, session_dir, flow


def normalize_flow_draft_update(updated: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    start_url = updated.get("start_url", current.get("start_url"))
    steps = updated.get("steps")
    if not isinstance(start_url, str) or not start_url.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="start_url is required"
        )
    if not isinstance(steps, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="steps must be a list"
        )
    sanitized_steps: list[dict[str, Any]] = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"step #{index} must be object",
            )
        action = step.get("action")
        if not isinstance(action, str) or not action.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"step #{index} action is required",
            )
        step_id = step.get("step_id")
        if not isinstance(step_id, str) or not step_id.strip():
            step = {**step, "step_id": f"s{index}"}
        sanitized_steps.append(step)

    return {
        **current,
        **updated,
        "start_url": start_url.strip(),
        "steps": sanitized_steps,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


def latest_flow_preview(requester: str, session_id: str | None = None) -> FlowPreviewResponse:
    loaded = load_latest_flow_draft(requester, session_id=session_id)
    if loaded is None:
        return FlowPreviewResponse()
    session_id, _, flow = loaded

    flow_steps = _flow_steps(flow)
    steps: list[FlowPreviewStep] = []
    for raw in flow_steps[:30]:
        selector = None
        target = raw.get("target")
        if isinstance(target, dict):
            selectors = target.get("selectors")
            if isinstance(selectors, list) and selectors:
                first = selectors[0]
                if isinstance(first, dict):
                    selector = str(first.get("value") or "")
        steps.append(
            FlowPreviewStep(
                step_id=str(raw.get("step_id", "")),
                action=str(raw.get("action", "")),
                url=str(raw.get("url")) if raw.get("url") else None,
                value_ref=str(raw.get("value_ref")) if raw.get("value_ref") else None,
                selector=selector,
            )
        )

    generated_at_raw = flow.get("generated_at")
    generated_at = None
    if isinstance(generated_at_raw, str):
        try:
            generated_at = datetime.fromisoformat(generated_at_raw.replace("Z", "+00:00"))
        except ValueError:
            generated_at = None

    return FlowPreviewResponse(
        session_id=session_id,
        start_url=flow.get("start_url"),
        generated_at=generated_at,
        source_event_count=_to_safe_int(flow.get("source_event_count")) or 0,
        step_count=len(flow_steps),
        steps=steps,
    )


def merge_step_evidence(session_dir: Path, step_id: str) -> StepEvidenceResponse | None:
    step_result = read_step_result(session_dir, "replay-flow-step-result.json", step_id)
    flow_result = read_step_result(session_dir, "replay-flow-result.json", step_id)
    payload = step_result or flow_result
    if payload is None:
        return None
    screenshot_before_path = payload.get("screenshot_before_path")
    screenshot_after_path = payload.get("screenshot_after_path")
    if screenshot_before_path is None and payload.get("screenshot_path") is not None:
        screenshot_before_path = payload.get("screenshot_path")
    screenshot_before_safe = (
        _safe_screenshot_path(session_dir, screenshot_before_path)
        if isinstance(screenshot_before_path, str)
        else None
    )
    screenshot_after_safe = (
        _safe_screenshot_path(session_dir, screenshot_after_path)
        if isinstance(screenshot_after_path, str)
        else None
    )
    screenshot_before_data_url = (
        to_data_url(session_dir, screenshot_before_path)
        if screenshot_before_safe and isinstance(screenshot_before_path, str)
        else None
    )
    screenshot_after_data_url = (
        to_data_url(session_dir, screenshot_after_path)
        if screenshot_after_safe and isinstance(screenshot_after_path, str)
        else None
    )
    return StepEvidenceResponse(
        step_id=step_id,
        action=str(payload.get("action")) if payload.get("action") is not None else None,
        ok=bool(payload.get("ok")) if payload.get("ok") is not None else None,
        detail=str(payload.get("detail")) if payload.get("detail") is not None else None,
        duration_ms=_to_safe_int(payload.get("duration_ms")),
        matched_selector=str(payload.get("matched_selector"))
        if payload.get("matched_selector") is not None
        else None,
        selector_index=_to_safe_int(payload.get("selector_index")),
        screenshot_before_path=str(screenshot_before_path)
        if screenshot_before_safe and isinstance(screenshot_before_path, str)
        else None,
        screenshot_after_path=str(screenshot_after_path)
        if screenshot_after_safe and isinstance(screenshot_after_path, str)
        else None,
        screenshot_before_data_url=screenshot_before_data_url,
        screenshot_after_data_url=screenshot_after_data_url,
        fallback_trail=parse_fallback_trail(payload),  # type: ignore[arg-type]
    )


def read_step_result(session_dir: Path, result_file_name: str, step_id: str) -> dict[str, Any] | None:
    result_path = _session_file_path(session_dir, result_file_name, must_exist=True)
    if result_path is None:
        return None
    try:
        raw = _read_json_document(result_path)
    except json.JSONDecodeError:
        return None
    if isinstance(raw, dict) and raw.get("stepId") == step_id:
        return raw
    if not isinstance(raw, dict):
        return None
    step_results = raw.get("stepResults")
    if not isinstance(step_results, list):
        return None
    for item in step_results:
        if isinstance(item, dict) and item.get("step_id") == step_id:
            return item
    return None


def _timeline_default_limit() -> int:
    raw = os.getenv("COMMAND_TOWER_EVIDENCE_TIMELINE_DEFAULT_LIMIT", "100").strip()
    try:
        parsed = int(raw)
    except ValueError:
        return 100
    return max(1, parsed)


def _timeline_max_limit() -> int:
    raw = os.getenv("COMMAND_TOWER_EVIDENCE_TIMELINE_MAX_LIMIT", "300").strip()
    try:
        parsed = int(raw)
    except ValueError:
        return 300
    return max(1, parsed)


def resolve_timeline_limit(limit: int | None) -> int:
    requested = _timeline_default_limit() if limit is None else max(1, limit)
    return min(requested, _timeline_max_limit())


def read_timeline_items(
    session_dir: Path, limit: int | None = None
) -> list[EvidenceTimelineItemResponse]:
    effective_limit = resolve_timeline_limit(limit)
    full = _session_file_path(session_dir, "replay-flow-result.json", must_exist=True)
    if full is None:
        return []
    try:
        raw = _read_json_document(full)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, dict):
        return []
    step_results = raw.get("stepResults")
    if not isinstance(step_results, list):
        return []
    items: list[EvidenceTimelineItemResponse] = []
    for step in step_results:
        if not isinstance(step, dict):
            continue
        if len(items) >= effective_limit:
            break
        screenshot_before_path = step.get("screenshot_before_path")
        screenshot_after_path = step.get("screenshot_after_path")
        if screenshot_before_path is None and step.get("screenshot_path") is not None:
            screenshot_before_path = step.get("screenshot_path")
        screenshot_before_safe = (
            _safe_screenshot_path(session_dir, screenshot_before_path)
            if isinstance(screenshot_before_path, str)
            else None
        )
        screenshot_after_safe = (
            _safe_screenshot_path(session_dir, screenshot_after_path)
            if isinstance(screenshot_after_path, str)
            else None
        )
        before_url = (
            to_data_url(session_dir, screenshot_before_path)
            if screenshot_before_safe and isinstance(screenshot_before_path, str)
            else None
        )
        after_url = (
            to_data_url(session_dir, screenshot_after_path)
            if screenshot_after_safe and isinstance(screenshot_after_path, str)
            else None
        )
        items.append(
            EvidenceTimelineItemResponse(
                step_id=str(step.get("step_id") or ""),
                action=str(step.get("action")) if step.get("action") is not None else None,
                ok=bool(step.get("ok")) if step.get("ok") is not None else None,
                detail=str(step.get("detail")) if step.get("detail") is not None else None,
                duration_ms=_to_safe_int(step.get("duration_ms")),
                matched_selector=str(step.get("matched_selector"))
                if step.get("matched_selector") is not None
                else None,
                selector_index=_to_safe_int(step.get("selector_index")),
                screenshot_before_path=str(screenshot_before_path)
                if screenshot_before_safe and isinstance(screenshot_before_path, str)
                else None,
                screenshot_after_path=str(screenshot_after_path)
                if screenshot_after_safe and isinstance(screenshot_after_path, str)
                else None,
                screenshot_before_data_url=before_url,
                screenshot_after_data_url=after_url,
                fallback_trail=parse_fallback_trail(step),  # type: ignore[arg-type]
            )
        )
    return items


def parse_fallback_trail(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("fallback_trail")
    if not isinstance(raw, list):
        return []
    parsed: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        parsed.append(
            {
                "selector_index": _to_safe_int(item.get("selector_index")),
                "kind": str(item.get("kind", "")),
                "value": str(item.get("value", "")),
                "normalized": str(item.get("normalized"))
                if item.get("normalized") is not None
                else None,
                "success": bool(item.get("success")),
                "error": str(item.get("error")) if item.get("error") is not None else None,
            }
        )
    return parsed


def _safe_screenshot_path(session_dir: Path, screenshot_path_raw: str) -> Path | None:
    raw_candidate = Path(screenshot_path_raw)
    if not raw_candidate.is_absolute() and ".." in raw_candidate.parts:
        return None
    session_root_text = os.path.realpath(os.fspath(session_dir))
    evidence_root_text = os.path.realpath(os.path.join(session_root_text, "evidence"))
    candidate_text = (
        os.fspath(raw_candidate)
        if raw_candidate.is_absolute()
        else os.path.join(session_root_text, os.fspath(raw_candidate))
    )
    resolved_text = os.path.realpath(candidate_text)
    if resolved_text != os.path.abspath(candidate_text):
        return None
    if not (
        os.path.commonpath((evidence_root_text, resolved_text)) == evidence_root_text
        or os.path.commonpath((session_root_text, resolved_text)) == session_root_text
    ):
        return None
    if not os.path.isfile(resolved_text):
        return None
    return Path(resolved_text)


def _max_evidence_bytes() -> int:
    raw = os.getenv("COMMAND_TOWER_EVIDENCE_MAX_BYTES", "1048576").strip()
    try:
        parsed = int(raw)
    except ValueError:
        return 1_048_576
    return max(1, parsed)


def _detect_image_mime(binary: bytes) -> str:
    if binary.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if binary.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if binary.startswith(b"GIF87a") or binary.startswith(b"GIF89a"):
        return "image/gif"
    if len(binary) > 12 and binary[:4] == b"RIFF" and binary[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def to_data_url(session_or_path: Path, screenshot_path_raw: str | None = None) -> str | None:
    screenshot_path_text = os.path.realpath(os.fspath(session_or_path))
    if screenshot_path_raw is not None:
        raw_candidate = Path(screenshot_path_raw)
        if not raw_candidate.is_absolute() and ".." in raw_candidate.parts:
            return None
        session_root_text = os.path.realpath(os.fspath(session_or_path))
        evidence_root_text = os.path.realpath(os.path.join(session_root_text, "evidence"))
        candidate_text = (
            os.fspath(raw_candidate)
            if raw_candidate.is_absolute()
            else os.path.join(session_root_text, os.fspath(raw_candidate))
        )
        resolved_text = os.path.realpath(candidate_text)
        if not (
            os.path.commonpath((evidence_root_text, resolved_text)) == evidence_root_text
            or os.path.commonpath((session_root_text, resolved_text)) == session_root_text
        ):
            return None
        screenshot_path_text = resolved_text
    if not os.path.isfile(screenshot_path_text):
        return None
    max_bytes = _max_evidence_bytes()
    try:
        file_size = os.path.getsize(screenshot_path_text)
    except OSError:
        return None
    if file_size > max_bytes:
        return None
    try:
        with open(screenshot_path_text, "rb") as handle:
            binary = handle.read(max_bytes + 1)
    except OSError:
        return None
    if len(binary) > max_bytes:
        return None
    encoded = base64.b64encode(binary).decode("ascii")
    mime = _detect_image_mime(binary)
    return f"data:{mime};base64,{encoded}"
