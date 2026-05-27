from __future__ import annotations

from app.core.settings import env_str


from fastapi import APIRouter, Cookie, Header, Request, Response, status
from fastapi.responses import RedirectResponse

from app.core.access_control import require_rate_limit
from app.models.register import CsrfResponse, RegisterRequest, RegisterResponse
from app.services.register_service import register_service

router = APIRouter(tags=["register"])


@router.get("/register", include_in_schema=False)
def register_page() -> RedirectResponse:
    default_register_url = "http://127.0.0.1:4173/register"
    frontend_register_url = env_str("FRONTEND_REGISTER_URL", default_register_url).strip()
    if not frontend_register_url:
        frontend_register_url = default_register_url
    return RedirectResponse(
        url=frontend_register_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT
    )


@router.get("/api/csrf", response_model=CsrfResponse)
def issue_csrf(request: Request, response: Response) -> CsrfResponse:
    require_rate_limit(request)
    token = register_service.issue_csrf_token()
    secure_cookie = (
        env_str("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
        and request.url.scheme == "https"
    )
    response.set_cookie(
        key="csrf_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure_cookie,
        max_age=register_service.csrf_ttl_seconds,
    )
    return CsrfResponse(csrf_token=token)


@router.post(
    "/api/register",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
def register_user(
    request: Request,
    payload: RegisterRequest,
    csrf_cookie: str | None = Cookie(
        default=None,
        alias="csrf_token",
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._~-]+$",
    ),
    csrf_header: str | None = Header(
        default=None,
        alias="X-CSRF-Token",
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._~-]+$",
    ),
) -> RegisterResponse:
    require_rate_limit(request)
    register_service.validate_csrf(header_token=csrf_header, cookie_token=csrf_cookie)
    return register_service.register_user(payload)
