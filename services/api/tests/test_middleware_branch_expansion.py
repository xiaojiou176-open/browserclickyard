from __future__ import annotations

import asyncio
from typing import Any

import pytest
from starlette.requests import Request
from starlette.responses import Response

import app.core.middleware as middleware_module
from app.core.middleware import RequestContextMiddleware, _resolve_request_user_id
from app.core.metrics import runtime_metrics


def _coerce_int(value: object) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"unsupported numeric value: {value!r}")


def _request(
    *, headers: dict[str, str] | None = None, client: tuple[str, int] | None = ("127.0.0.1", 1234)
) -> Request:
    raw_headers = [
        (key.lower().encode("latin-1"), value.encode("latin-1"))
        for key, value in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "path": "/demo",
        "raw_path": b"/demo",
        "scheme": "http",
        "query_string": b"",
        "headers": raw_headers,
        "client": client,
        "server": ("testserver", 80),
    }
    return Request(scope)


def test_resolve_request_user_id_prefers_explicit_header_then_client_id() -> None:
    assert (
        _resolve_request_user_id(
            _request(headers={"x-user-id": " user-1 ", "x-automation-client-id": "client-1"})
        )
        == "user-1"
    )
    assert (
        _resolve_request_user_id(_request(headers={"x-automation-client-id": " client-2 "}))
        == "client-2"
    )
    assert _resolve_request_user_id(_request()) == "anonymous"


def test_dispatch_sets_security_headers_and_hsts_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def noop_app(scope, receive, send) -> None:
        return None

    middleware = RequestContextMiddleware(app=noop_app)
    request = _request(
        headers={
            "x-request-id": "req-123",
            "x-trace-id": "trace-123",
            "x-user-id": "owner-a",
            "user-agent": "pytest-agent",
        }
    )
    monkeypatch.setenv("APP_ENV", "production")

    before = runtime_metrics.snapshot()

    async def call_next(_request: Request) -> Response:
        return Response("ok", status_code=201)

    response = asyncio.run(middleware.dispatch(request, call_next))

    after = runtime_metrics.snapshot()
    assert response.status_code == 201
    assert response.headers["x-request-id"] == "req-123"
    assert response.headers["x-trace-id"] == "trace-123"
    assert response.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"
    assert (
        response.headers["content-security-policy"]
        == "default-src 'self'; frame-ancestors 'none'; base-uri 'self'"
    )
    assert response.headers["cache-control"] == "no-store"
    assert after["active_requests"] == 0
    assert _coerce_int(after["requests_total"]) == _coerce_int(before["requests_total"]) + 1


def test_dispatch_logs_and_reraises_request_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    async def noop_app(scope, receive, send) -> None:
        return None

    middleware = RequestContextMiddleware(app=noop_app)
    request = _request(headers={"x-automation-client-id": "client-a"}, client=None)
    captured: dict[str, Any] = {}

    def fake_build_error_context(exc: Exception) -> dict[str, object]:
        return {
            "error_message": str(exc),
            "error_type": type(exc).__name__,
            "error_stack": "stack-trace",
        }

    def fake_logger_error(message: str, *, extra: dict[str, object]) -> None:
        captured["message"] = message
        captured["extra"] = extra

    monkeypatch.setattr(middleware_module, "build_error_context", fake_build_error_context)
    monkeypatch.setattr(middleware_module.logger, "error", fake_logger_error)

    before = runtime_metrics.snapshot()

    async def call_next(_request: Request) -> Response:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(middleware.dispatch(request, call_next))

    after = runtime_metrics.snapshot()
    assert captured["message"] == "http_request_failed"
    extra = captured["extra"]
    assert isinstance(extra, dict)
    assert extra["user_id"] == "client-a"
    assert extra["client_ip"] == "-"
    assert extra["status_code"] == 500
    assert extra["error"] == "boom"
    assert after["active_requests"] == 0
    assert (
        _coerce_int(after["request_errors_total"])
        == _coerce_int(before["request_errors_total"]) + 1
    )
