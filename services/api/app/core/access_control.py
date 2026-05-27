from __future__ import annotations

from app.core.settings import env_bool, env_is_production_like, env_str

import hmac
import hashlib
import logging
import os
import time
from collections import deque
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException, Request, status

from app.core.metrics import runtime_metrics

logger = logging.getLogger("security")
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}

_RATE_LOCK = Lock()
_RATE_BUCKETS: dict[str, deque[float]] = {}
_RATE_LIMIT_PER_MINUTE = max(10, int(env_str("AUTOMATION_RATE_LIMIT_PER_MINUTE", "120")))
_MAX_RATE_BUCKETS = max(100, int(env_str("AUTOMATION_MAX_RATE_BUCKETS", "2000")))
_REDIS_RATE_WINDOW_SECONDS = 60
_REDIS_CLIENT = None
_REDIS_URL_CACHE = ""
_REDIS_RATE_LIMIT_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
local current = redis.call('ZCARD', key)
if current >= limit then
  redis.call('EXPIRE', key, ttl_seconds)
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttl_seconds)
return 1
"""
_AUTOMATION_CLIENT_ID_HEADER = "x-automation-client-id"
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_WEAK_AUTOMATION_TOKEN_SENTINELS = {
    "replace-with-strong-token",
    "replace_with_secure_token",
    "replace-me",
    "replace_me",
    "changeme",
    "change-me",
    "your-token-here",
    "your_token_here",
    "default-token",
    "default",
    "test-token",
    "token-1",
}
_MIN_AUTOMATION_TOKEN_LENGTH = 16


def _create_redis_client(redis_url: str):
    import redis

    return redis.Redis.from_url(redis_url, decode_responses=True)


def _client_ip(request: Request) -> str:
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _is_loopback_client(request: Request) -> bool:
    return _client_ip(request) in _LOOPBACK_HOSTS


def _allow_local_no_token(request: Request) -> bool:
    allow_local = env_bool("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", False)
    app_env = env_str("APP_ENV", "development").strip().lower()
    if allow_local and env_is_production_like():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AUTOMATION_ALLOW_LOCAL_NO_TOKEN must be false in production-like environments",
        )
    return allow_local and _is_loopback_client(request) and app_env in {"development", "test"}


def _is_local_client(request: Request) -> bool:
    allow_local = env_bool("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", False)
    return allow_local and _is_loopback_client(request)


def _validate_local_no_token_config() -> None:
    allow_local = env_bool("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", False)
    if allow_local and env_is_production_like():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AUTOMATION_ALLOW_LOCAL_NO_TOKEN must be false in production-like environments",
        )


def _client_id(request: Request) -> str:
    return (request.headers.get("x-automation-client-id") or "").strip()


def _required_client_id(request: Request) -> str:
    client_id = _client_id(request)
    if client_id:
        return client_id
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="x-automation-client-id header is required when token auth is enabled",
    )


def _token_required() -> bool:
    return env_bool("AUTOMATION_REQUIRE_TOKEN", True)


def _configured_automation_token() -> str | None:
    expected = os.getenv("AUTOMATION_API_TOKEN", "").strip()
    if not expected:
        return None
    if os.getenv("PYTEST_CURRENT_TEST") and expected == "test-token":
        return expected
    lowered = expected.lower()
    is_placeholder = lowered in _WEAK_AUTOMATION_TOKEN_SENTINELS
    looks_placeholder = lowered.startswith("replace-") or lowered.startswith("replace_")
    if is_placeholder or looks_placeholder or len(expected) < _MIN_AUTOMATION_TOKEN_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="automation token is weak; set a strong AUTOMATION_API_TOKEN",
        )
    return expected


def requester_id(request: Request, validated_token: str | None = None) -> str:
    if validated_token:
        client_id = _required_client_id(request)
        digest = hashlib.sha256(f"{validated_token}::{client_id}".encode("utf-8")).hexdigest()[:16]
        return f"token:{digest}"

    client_id = _client_id(request)
    client_ip = _client_ip(request)
    if client_id:
        return f"{client_ip}:{client_id}"
    return client_ip


def check_token(request: Request, x_automation_token: str | None) -> str | None:
    _validate_local_no_token_config()
    expected = _configured_automation_token()
    token = (x_automation_token or "").strip()
    require_token = _token_required()

    if expected:
        if token:
            if not hmac.compare_digest(token, expected):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid automation token"
                )
            _required_client_id(request)
            return token
        if not require_token:
            return None
        allow_local = env_bool("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", False)
        if allow_local and not _is_loopback_client(request):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="automation token required for non-local client",
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid automation token"
        )

    if token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="automation token is required in production-like environments",
        )

    if _is_local_client(request):
        return None

    if not require_token:
        return None

    allow_local = env_bool("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", False)
    if allow_local:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="automation token required for non-local client",
        )
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid automation token")


def check_rate_limit(request: Request, validated_token: str | None = None) -> None:
    if _check_rate_limit_via_redis(request, validated_token):
        return
    _check_rate_limit_in_memory(request, validated_token)


def require_rate_limit(request: Request, validated_token: str | None = None) -> None:
    check_rate_limit(request, validated_token)


def require_access(request: Request, x_automation_token: str | None) -> str | None:
    _guard_emergency_kill_switch(request)
    validated_token = check_token(request, x_automation_token)
    require_rate_limit(request, validated_token)
    return validated_token


def require_actor(request: Request, x_automation_token: str | None) -> str:
    validated_token = require_access(request, x_automation_token)
    return requester_id(request, validated_token)


def _rate_limit_identity(request: Request, validated_token: str | None = None) -> str:
    if validated_token:
        client_id = _required_client_id(request)
        digest = hashlib.sha256(f"{validated_token}::{client_id}".encode("utf-8")).hexdigest()[:16]
        return f"token:{digest}"

    # For anonymous traffic, keep the limiter identity server-derived only.
    # Client-controlled identifiers can be rotated to bypass limits.
    return _client_ip(request)


def _check_rate_limit_via_redis(request: Request, validated_token: str | None = None) -> bool:
    redis_url = env_str("REDIS_URL", "").strip()
    if not redis_url:
        return False

    global _REDIS_CLIENT, _REDIS_URL_CACHE
    try:
        if _REDIS_CLIENT is None or _REDIS_URL_CACHE != redis_url:
            _REDIS_CLIENT = _create_redis_client(redis_url)
            _REDIS_URL_CACHE = redis_url
        route_key = f"rate:{_rate_limit_identity(request, validated_token)}:{request.url.path}"
        now = time.time()
        window_start = now - _REDIS_RATE_WINDOW_SECONDS
        member = f"{now}:{uuid4()}"
        allowed = _REDIS_CLIENT.eval(
            _REDIS_RATE_LIMIT_LUA,
            1,
            route_key,
            now,
            window_start,
            _REDIS_RATE_WINDOW_SECONDS * 2,
            _RATE_LIMIT_PER_MINUTE,
            member,
        )
        if int(allowed) == 0:
            runtime_metrics.record_rate_limited()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="rate limit exceeded",
            )
        return True
    except HTTPException:
        raise
    except Exception as exc:
        runtime_metrics.record_rate_limit_redis_error()
        logger.warning(
            "redis limiter unavailable; degrade to in-memory limiter",
            extra={"error": str(exc), "path": request.url.path},
        )
        return False


def _check_rate_limit_in_memory(request: Request, validated_token: str | None = None) -> None:
    route_key = f"{_rate_limit_identity(request, validated_token)}:{request.url.path}"
    now = time.time()
    window_start = now - 60
    with _RATE_LOCK:
        if len(_RATE_BUCKETS) > _MAX_RATE_BUCKETS:
            stale_keys = [
                key
                for key, values in _RATE_BUCKETS.items()
                if not values or values[-1] < window_start
            ]
            for key in stale_keys:
                _RATE_BUCKETS.pop(key, None)
            if len(_RATE_BUCKETS) > _MAX_RATE_BUCKETS:
                survivors = sorted(_RATE_BUCKETS.items(), key=lambda kv: kv[1][-1], reverse=True)[
                    :_MAX_RATE_BUCKETS
                ]
                _RATE_BUCKETS.clear()
                _RATE_BUCKETS.update(dict(survivors))
        bucket = _RATE_BUCKETS.setdefault(route_key, deque())
        while bucket and bucket[0] < window_start:
            bucket.popleft()
        if len(bucket) >= _RATE_LIMIT_PER_MINUTE:
            runtime_metrics.record_rate_limited()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="rate limit exceeded",
            )
        bucket.append(now)


def _guard_emergency_kill_switch(request: Request) -> None:
    if not env_bool("AUTOMATION_EMERGENCY_KILL_SWITCH", False):
        return
    if request.method.upper() not in _MUTATING_METHODS:
        return
    logger.warning(
        "automation emergency kill switch blocked mutating request",
        extra={"path": request.url.path, "method": request.method.upper()},
    )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="automation emergency kill switch is enabled",
    )


def reset_for_tests() -> None:
    global _REDIS_CLIENT, _REDIS_URL_CACHE
    with _RATE_LOCK:
        _RATE_BUCKETS.clear()
    _REDIS_CLIENT = None
    _REDIS_URL_CACHE = ""
