from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, Request

from app.core.access_control import check_rate_limit, check_token, requester_id
from app.core.settings import env_str


@dataclass(frozen=True, slots=True)
class AutomationSecurityContext:
    actor: str
    verified_actor: str
    client_host: str
    path: str
    x_automation_token: str | None
    verified_token: str | None
    client_id: str | None


def require_automation_access(
    request: Request,
    x_automation_token: str | None = Header(default=None),
    x_automation_client_id: str | None = Header(default=None),
) -> AutomationSecurityContext:
    verified_token = check_token(request, x_automation_token)
    check_rate_limit(request, verified_token)
    token_configured = bool(env_str("AUTOMATION_API_TOKEN", "").strip())
    if (
        request.url.path == "/api/command-tower/overview"
        and token_configured
        and (x_automation_token or "").strip()
        and not (x_automation_client_id or "").strip()
    ):
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="x-automation-client-id header is required when token is configured",
        )
    return AutomationSecurityContext(
        actor=requester_id(request, verified_token),
        verified_actor=requester_id(request, verified_token),
        client_host=request.client.host if request.client else "unknown",
        path=request.url.path,
        x_automation_token=x_automation_token,
        verified_token=verified_token,
        client_id=(x_automation_client_id or "").strip() or None,
    )
