from __future__ import annotations

import logging
import time
from uuid import uuid4

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.core.metrics import runtime_metrics
from app.core.settings import env_is_production_like
from app.core.observability import (
    REQUEST_ID_CTX,
    TRACE_ID_CTX,
    USER_ID_CTX,
    build_error_context,
)

logger = logging.getLogger("http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("x-request-id", str(uuid4()))
        trace_id = request.headers.get("x-trace-id", request_id)
        user_id = _resolve_request_user_id(request)
        client_ip = request.client.host if request.client and request.client.host else "-"
        user_agent = (request.headers.get("user-agent") or "-").strip() or "-"
        token = REQUEST_ID_CTX.set(request_id)
        trace_token = TRACE_ID_CTX.set(trace_id)
        user_token = USER_ID_CTX.set(user_id)
        start = time.perf_counter()
        runtime_metrics.increment_active_requests()
        response: Response | None = None
        status_code = 500
        request_error: Exception | None = None
        try:
            response = await call_next(request)
            status_code = response.status_code
        except Exception as exc:
            request_error = exc
        finally:
            elapsed_seconds = time.perf_counter() - start
            elapsed_ms = round(elapsed_seconds * 1000, 2)
            runtime_metrics.record_request(status_code, elapsed_seconds)
            runtime_metrics.decrement_active_requests()

            if response is not None:
                response.headers["x-request-id"] = request_id
                response.headers["x-trace-id"] = trace_id
                response.headers["x-content-type-options"] = "nosniff"
                response.headers["x-frame-options"] = "DENY"
                response.headers["referrer-policy"] = "same-origin"
                response.headers["permissions-policy"] = "geolocation=(), microphone=(), camera=()"
                response.headers["cache-control"] = "no-store"
                response.headers["content-security-policy"] = (
                    "default-src 'self'; frame-ancestors 'none'; base-uri 'self'"
                )
                if env_is_production_like():
                    response.headers["strict-transport-security"] = (
                        "max-age=31536000; includeSubDomains"
                    )

            log_extra = {
                "request_id": request_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "component": "backend.http",
                "evidenceClass": "log",
                "path": request.url.path,
                "method": request.method,
                "client_ip": client_ip,
                "user_agent": user_agent,
                "status_code": status_code,
                "duration_ms": elapsed_ms,
            }
            if request_error is None:
                logger.info(
                    "http_request_completed",
                    extra={**log_extra, "event": "http.request.completed", "status": "ok"},
                )
            else:
                error_context = build_error_context(request_error)
                logger.error(
                    "http_request_failed",
                    extra={
                        **log_extra,
                        "event": "http.request.failed",
                        "status": "error",
                        "error": error_context["error_message"],
                        "error_type": error_context["error_type"],
                        "error_stack": error_context["error_stack"],
                        "error_context": error_context,
                    },
                )
            REQUEST_ID_CTX.reset(token)
            TRACE_ID_CTX.reset(trace_token)
            USER_ID_CTX.reset(user_token)

        if request_error is not None:
            raise request_error
        if response is None:  # pragma: no cover - defensive guard
            raise RuntimeError("response is unavailable after middleware dispatch")
        return response


def _resolve_request_user_id(request: Request) -> str:
    for header_name in ("x-user-id", "x-automation-client-id"):
        header_value = (request.headers.get(header_name) or "").strip()
        if header_value:
            return header_value
    return "anonymous"
