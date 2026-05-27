from __future__ import annotations

from fastapi import APIRouter, Header, Request

from app.core.access_control import require_access
from app.api.common import COMMON_ERROR_RESPONSES
from app.models.automation import ProfileResolveRequest, ProfileResolveResponse
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(prefix="/api/profiles", tags=["profiles"], responses=COMMON_ERROR_RESPONSES)


@router.post("/resolve", response_model=ProfileResolveResponse)
def resolve_profile(
    payload: ProfileResolveRequest,
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> ProfileResolveResponse:
    require_access(request, x_automation_token)
    return universal_platform_service.resolve_target_profile(payload)
