from __future__ import annotations

import sys
import time
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import app.core.access_control as access_control


def _request(
    *,
    host: str | None = "127.0.0.1",
    path: str = "/api/automation/commands",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": headers or [],
        "client": None if host is None else (host, 12345),
        "server": ("testserver", 80),
    }
    return Request(scope)


def test_create_redis_client_and_client_ip_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeRedis:
        @staticmethod
        def from_url(url: str, decode_responses: bool = False) -> object:
            captured["url"] = url
            captured["decode_responses"] = decode_responses
            return SimpleNamespace(url=url)

    fake_module = ModuleType("redis")
    fake_module.Redis = FakeRedis  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "redis", fake_module)

    client = access_control._create_redis_client("redis://cache/1")
    assert client.url == "redis://cache/1"
    assert captured == {"url": "redis://cache/1", "decode_responses": True}
    assert access_control._client_ip(_request(host=None)) == "unknown"


def test_allow_local_no_token_and_configured_token_branches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "true")
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(HTTPException) as prod_guard:
        access_control._allow_local_no_token(_request(host="127.0.0.1"))
    assert prod_guard.value.status_code == 503

    monkeypatch.setenv("APP_ENV", "staging")
    with pytest.raises(HTTPException) as validate_guard:
        access_control._validate_local_no_token_config()
    assert validate_guard.value.status_code == 503

    monkeypatch.setenv("PYTEST_CURRENT_TEST", "case::test")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "test-token")
    assert access_control._configured_automation_token() == "test-token"


def test_requester_id_and_check_token_cover_service_unavailable_and_optional_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _request(host="8.8.8.8")
    assert access_control.requester_id(request, None) == "8.8.8.8"

    monkeypatch.delenv("AUTOMATION_API_TOKEN", raising=False)
    with pytest.raises(HTTPException) as token_without_config:
        access_control.check_token(request, "provided-token")
    assert token_without_config.value.status_code == 503

    monkeypatch.setenv("AUTOMATION_REQUIRE_TOKEN", "false")
    monkeypatch.setenv("AUTOMATION_ALLOW_LOCAL_NO_TOKEN", "false")
    assert access_control.check_token(request, None) is None


def test_check_rate_limit_via_redis_updates_cache_and_handles_http_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    access_control.reset_for_tests()
    monkeypatch.setenv("REDIS_URL", "redis://example.local/0")

    class AllowRedis:
        def eval(self, *args, **kwargs):
            return 1

    monkeypatch.setattr(access_control, "_REDIS_CLIENT", None)
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "")
    monkeypatch.setattr(access_control, "_create_redis_client", lambda _: AllowRedis())
    assert access_control._check_rate_limit_via_redis(_request()) is True
    assert access_control._REDIS_URL_CACHE == "redis://example.local/0"

    class BlockRedis:
        def eval(self, *args, **kwargs):
            return 0

    monkeypatch.setattr(access_control, "_REDIS_CLIENT", BlockRedis())
    monkeypatch.setattr(access_control, "_REDIS_URL_CACHE", "redis://example.local/0")
    with pytest.raises(HTTPException) as limited:
        access_control._check_rate_limit_via_redis(_request())
    assert limited.value.status_code == 429


def test_in_memory_rate_limit_prunes_stale_keys_and_old_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    access_control.reset_for_tests()
    now = time.time()
    target = _request(host="7.7.7.7")
    target_key = f"{access_control._client_ip(target)}:{target.url.path}"
    stale_key = "stale:/api/automation/tasks"

    monkeypatch.setattr(access_control, "_MAX_RATE_BUCKETS", 1)
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 2)
    monkeypatch.setattr(access_control.time, "time", lambda: now)

    with access_control._RATE_LOCK:
        access_control._RATE_BUCKETS.clear()
        access_control._RATE_BUCKETS[stale_key] = access_control.deque([now - 120])
        access_control._RATE_BUCKETS[target_key] = access_control.deque([now - 61, now - 1])

    access_control._check_rate_limit_in_memory(target)

    with access_control._RATE_LOCK:
        assert stale_key not in access_control._RATE_BUCKETS
        assert list(access_control._RATE_BUCKETS[target_key]) == [now - 1, now]

    with pytest.raises(HTTPException) as limited:
        access_control._check_rate_limit_in_memory(target)
    assert limited.value.status_code == 429
