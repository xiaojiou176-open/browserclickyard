from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import (
    COMMON_ERROR_RESPONSES,
    accept_cookie_header,
    reject_unknown_query_params,
)
from app.models.flow import FlowRecord
from app.models.universal_api import FlowCreateRequest, FlowListResponse, FlowUpdateRequest
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/flows",
    tags=["flows"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)


@router.get("", response_model=FlowListResponse)
def list_flows(
    security: AutomationSecurityContext = Depends(require_automation_access),
    limit: int = Query(default=50, ge=1, le=200),
) -> FlowListResponse:
    return FlowListResponse(
        flows=universal_platform_service.list_flows(limit=limit, requester=security.actor)
    )


@router.post("/import-latest", response_model=FlowRecord)
def import_latest_flow(
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> FlowRecord:
    return universal_platform_service.import_latest_flow_draft(owner=security.actor)


@router.patch("/import-latest", include_in_schema=False)
def import_latest_flow_method_not_allowed() -> None:
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="Method Not Allowed",
        headers={"Allow": "POST"},
    )


@router.get("/import-latest", include_in_schema=False)
def import_latest_flow_get_not_allowed() -> None:
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="Method Not Allowed",
        headers={"Allow": "POST"},
    )


@router.post("", response_model=FlowRecord)
def create_flow(
    payload: FlowCreateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> FlowRecord:
    steps = [step.model_dump(mode="python", exclude_none=True) for step in payload.steps]
    return universal_platform_service.create_flow(
        session_id=payload.session_id,
        start_url=payload.start_url,
        source_event_count=payload.source_event_count,
        steps=steps,
        requester=security.actor,
    )


@router.get("/{flow_id}", response_model=FlowRecord)
def get_flow(
    request: Request,
    flow_id: str = Path(pattern=r"^fl_[A-Za-z0-9_:-]{1,128}$"),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> FlowRecord:
    reject_unknown_query_params(request, allowed=frozenset())
    return universal_platform_service.get_flow(flow_id, requester=security.actor)


@router.patch("/{flow_id}", response_model=FlowRecord)
def update_flow(
    payload: FlowUpdateRequest,
    flow_id: str = Path(pattern=r"^fl_[A-Za-z0-9_:-]{1,128}$"),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> FlowRecord:
    steps = None
    if payload.steps is not None:
        steps = [step.model_dump(mode="python", exclude_none=True) for step in payload.steps]
    return universal_platform_service.update_flow(
        flow_id,
        steps=steps,
        start_url=payload.start_url,
        expected_version=payload.expected_version,
        requester=security.actor,
    )
