from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path, Query, Request

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import (
    COMMON_ERROR_RESPONSES,
    accept_cookie_header,
    reject_unknown_query_params,
)
from app.models.manual_gate import RunResumeRequest
from app.models.universal_api import (
    RunCreateRequest,
    RunListResponse,
    RunOtpSubmitRequest,
    RunResponse,
)
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/runs",
    tags=["runs"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)
_RUN_ID_PATTERN = r"^rn_[0-9a-f]{32}$"


@router.get("", response_model=RunListResponse)
def list_runs(
    limit: int = Query(default=100, ge=1, le=500),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunListResponse:
    return RunListResponse(
        runs=universal_platform_service.list_runs(limit=limit, requester=security.verified_actor)
    )


@router.post("", response_model=RunResponse)
def create_run(
    payload: RunCreateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunResponse:
    run_params = _normalize_run_params(payload.params)
    run = universal_platform_service.create_run(
        payload.template_id,
        run_params,
        actor=security.verified_actor,
        otp_code=payload.otp_code,
    )
    return RunResponse(run=run)


@router.get("/{run_id}", response_model=RunResponse)
def get_run(
    request: Request,
    run_id: str = Path(pattern=_RUN_ID_PATTERN),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunResponse:
    reject_unknown_query_params(request, allowed=frozenset())
    run = universal_platform_service.get_run(run_id, requester=security.verified_actor)
    return RunResponse(run=run)


@router.post("/{run_id}/otp", response_model=RunResponse)
def submit_run_otp(
    payload: RunOtpSubmitRequest,
    run_id: str = Path(pattern=_RUN_ID_PATTERN),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunResponse:
    run = universal_platform_service.submit_otp_and_resume(
        run_id,
        payload.otp_code,
        expected_version=payload.expected_version,
        actor=security.verified_actor,
    )
    return RunResponse(run=run)


@router.post("/{run_id}/resume", response_model=RunResponse)
def resume_run(
    payload: RunResumeRequest,
    run_id: str = Path(pattern=_RUN_ID_PATTERN),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunResponse:
    run = universal_platform_service.submit_resume(
        run_id,
        payload,
        actor=security.verified_actor,
    )
    return RunResponse(run=run)


@router.post("/{run_id}/cancel", response_model=RunResponse)
def cancel_run(
    request: Request,
    run_id: str = Path(pattern=_RUN_ID_PATTERN),
    expected_version: str | None = Query(default=None, pattern=r"^(null|[1-9][0-9]{0,9})$"),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunResponse:
    reject_unknown_query_params(request, allowed={"expected_version"})
    parsed_expected_version = _parse_nullable_int(expected_version)
    run = universal_platform_service.cancel_run(
        run_id, actor=security.verified_actor, expected_version=parsed_expected_version
    )
    return RunResponse(run=run)


def _normalize_run_params(raw_params: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in raw_params.items():
        normalized[str(key)] = "" if value is None else str(value)
    return normalized


def _parse_nullable_int(value: str | None) -> int | None:
    if value is None or value == "null":
        return None
    assert value is not None
    return int(value)
