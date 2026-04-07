from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Path, Query, Request

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import (
    COMMON_ERROR_RESPONSES,
    accept_cookie_header,
    reject_unknown_query_params,
)
from app.models.flow import SessionRecord
from app.models.universal_api import SessionListResponse, SessionStartRequest
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/sessions",
    tags=["sessions"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)
_SESSION_ID_PATTERN = r"^ss_[0-9a-f]{32}$"


@router.get("", response_model=SessionListResponse)
def list_sessions(
    request: Request,
    limit: int = Query(default=30, ge=1, le=200),
    _x_automation_token: str | None = Header(default=None, alias="x-automation-token"),
    _x_automation_client_id: str | None = Header(default=None, alias="x-automation-client-id"),
    _accept: str | None = Header(default=None, alias="Accept"),
    _accept_encoding: str | None = Header(default=None, alias="Accept-Encoding"),
    _connection: str | None = Header(default=None, alias="Connection"),
    _host: str | None = Header(default=None, alias="Host"),
    _user_agent: str | None = Header(default=None, alias="User-Agent"),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> SessionListResponse:
    reject_unknown_query_params(request, allowed={"limit"})
    return SessionListResponse(
        sessions=universal_platform_service.list_sessions(limit=limit, requester=security.actor)
    )


@router.post("/start", response_model=SessionRecord)
def start_session(
    payload: SessionStartRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> SessionRecord:
    start_url = payload.start_url.unicode_string()
    return universal_platform_service.start_session(
        start_url,
        payload.mode,
        owner=security.actor,
    )


@router.post("/{session_id}/finish", response_model=SessionRecord)
def finish_session(
    request: Request,
    session_id: str = Path(pattern=_SESSION_ID_PATTERN),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> SessionRecord:
    reject_unknown_query_params(request, allowed=frozenset())
    return universal_platform_service.finish_session(session_id, owner=security.actor)
