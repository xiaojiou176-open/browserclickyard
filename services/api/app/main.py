from app.core.settings import env_str


from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.responses import JSONResponse
from app.api.common import COMMON_ERROR_RESPONSES
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.health import build_prometheus_payload
from app.api import api_router
from app.core.middleware import RequestContextMiddleware
from app.core.observability import configure_logging, configure_tracing
from app.core.app_settings import load_app_settings

configure_logging()
configure_tracing()
settings = load_app_settings()
app = FastAPI(
    title=settings.app_name,
    responses=COMMON_ERROR_RESPONSES,
)
allowed_origins = [
    origin.strip()
    for origin in env_str(
        "CORS_ALLOWED_ORIGINS", "http://127.0.0.1:17373,http://localhost:17373"
    ).split(",")
    if origin.strip()
]
allowed_hosts = [
    host.strip()
    for host in env_str("TRUSTED_HOSTS", "127.0.0.1,localhost,testserver").split(",")
    if host.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
app.add_middleware(RequestContextMiddleware)
app.include_router(api_router)


def _normalize_error_detail(detail: object) -> object:
    if isinstance(detail, dict):
        if "detail" in detail:
            return detail["detail"]
        if "details" in detail:
            return detail["details"]
        return detail
    return detail


@app.exception_handler(HTTPException)
async def fastapi_http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    del request
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": _normalize_error_detail(exc.detail)},
        headers=exc.headers,
    )


@app.exception_handler(StarletteHTTPException)
async def starlette_http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    del request
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": _normalize_error_detail(exc.detail)},
        headers=exc.headers,
    )


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {"message": "service ready"}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> str:
    return build_prometheus_payload()
