from __future__ import annotations

import app.services.engine_adapters.common as common
import pytest
from typing import Any


def _payload(html_content: str = "<html></html>") -> common.EngineInput:
    return common.EngineInput(
        start_url="https://example.com/start",
        har_entries=[],
        html_content=html_content,
        extractor_strategy="balanced",
    )


def test_score_entry_get_without_preferred_host_and_non_success_status() -> None:
    score = common._score_entry(
        {"method": "GET", "url": "https://example.com/ping", "status": 500},
        preferred_host=None,
    )
    assert score == 5


def test_pick_primary_entry_handles_entries_with_missing_urls() -> None:
    entries = [
        {"method": "POST", "status": 200},
        {"method": "GET", "url": "", "status": 200},
    ]
    selected = common.pick_primary_entry(entries)
    assert selected == entries[0]


def test_selector_from_html_uses_css_fallback_for_email_and_password() -> None:
    html = "<input type='email' /><input type='password' />"
    email_selector = common._selector_from_html(html, "email")
    password_selector = common._selector_from_html(html, "password")
    assert email_selector["selectors"][0]["value"] == "input[type='email']"
    assert password_selector["selectors"][0]["value"] == "input[type='password']"


def test_call_remote_engine_returns_none_when_endpoint_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RECON_REMOTE_ENGINE_ENDPOINT", raising=False)
    assert common.call_remote_engine("RECON_REMOTE_ENGINE_ENDPOINT", _payload(), "gemini") is None


def test_parse_remote_endpoint_rejects_missing_hostname() -> None:
    assert common._parse_remote_endpoint("https:///infer") is None


def test_parse_remote_endpoint_applies_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(common, "_is_forbidden_host", lambda _hostname: False)
    monkeypatch.setattr(common, "_REMOTE_ENGINE_ALLOWED_HOSTS", frozenset({"allowed.example.com"}))

    assert common._parse_remote_endpoint("https://other.example.com/infer") is None
    assert common._parse_remote_endpoint("https://allowed.example.com:9443") == (
        "https",
        "allowed.example.com",
        9443,
        "/",
    )


def test_is_forbidden_host_returns_false_on_dns_lookup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raise_gaierror(*_args, **_kwargs):
        raise common.socket.gaierror("dns error")

    monkeypatch.setattr(common.socket, "getaddrinfo", raise_gaierror)
    assert common._is_forbidden_host("not-resolvable.example") is False


def test_is_forbidden_host_ignores_empty_and_invalid_sockaddr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        common.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (common.socket.AF_INET, common.socket.SOCK_STREAM, 6, "", ()),
            (common.socket.AF_INET, common.socket.SOCK_STREAM, 6, "", ("not-an-ip", 443)),
        ],
    )
    assert common._is_forbidden_host("unusual.example") is False


def test_post_json_rejects_non_https_scheme() -> None:
    with pytest.raises(ValueError, match="unsupported scheme"):
        common._post_json(("http", "engine.example.com", 443, "/infer"), {}, 3)


def test_post_json_success_sends_request_and_closes_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class FakeResponse:
        status = 200

        def read(self) -> bytes:
            return b'{"ok":true}'

    class FakeConnection:
        def __init__(self, **kwargs):
            captured["connection_kwargs"] = kwargs
            captured["closed"] = False

        def request(self, method, request_path, body, headers):
            captured["request"] = {
                "method": method,
                "request_path": request_path,
                "body": body,
                "headers": headers,
            }

        def getresponse(self):
            return FakeResponse()

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(common.ssl, "create_default_context", lambda: "ctx")
    monkeypatch.setattr(common.http.client, "HTTPSConnection", FakeConnection)

    raw = common._post_json(("https", "engine.example.com", 8443, "/infer"), {"a": 1}, 9)
    assert raw == '{"ok":true}'
    assert captured["closed"] is True
    assert captured["connection_kwargs"] == {
        "host": "engine.example.com",
        "port": 8443,
        "timeout": 9,
        "context": "ctx",
    }
    assert captured["request"] == {
        "method": "POST",
        "request_path": "/infer",
        "body": b'{"a": 1}',
        "headers": {"Content-Type": "application/json", "Accept": "application/json"},
    }


def test_post_json_raises_on_non_2xx_and_still_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {"closed": False}

    class FakeResponse:
        status = 500

        def read(self) -> bytes:
            return b"failure"

    class FakeConnection:
        def __init__(self, **_kwargs):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return FakeResponse()

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(common.ssl, "create_default_context", lambda: "ctx")
    monkeypatch.setattr(common.http.client, "HTTPSConnection", FakeConnection)

    with pytest.raises(ValueError, match="remote engine returned 500"):
        common._post_json(("https", "engine.example.com", 443, "/infer"), {}, 5)
    assert captured["closed"] is True


def test_call_remote_engine_truncates_html_and_clamps_timeout_and_defaults_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECON_REMOTE_ENGINE_ENDPOINT", "https://engine.example.com/infer")
    monkeypatch.setattr(
        common,
        "_parse_remote_endpoint",
        lambda _endpoint: ("https", "engine.example.com", 443, "/infer"),
    )
    monkeypatch.setattr(common, "_REMOTE_ENGINE_TIMEOUT_SECONDS", 1)
    captured: dict[str, object] = {}

    def fake_post(
        parsed_endpoint: tuple[str, str, int, str],
        request_payload: dict[str, Any],
        timeout_seconds: int,
    ) -> str:
        captured["parsed_endpoint"] = parsed_endpoint
        captured["request_payload"] = request_payload
        captured["timeout_seconds"] = timeout_seconds
        return '{"steps":[{"action":"click"}]}'

    monkeypatch.setattr(common, "_post_json", fake_post)

    result = common.call_remote_engine(
        "RECON_REMOTE_ENGINE_ENDPOINT",
        _payload(html_content="x" * 13050),
        "gemini",
    )
    request_payload = captured["request_payload"]
    assert isinstance(request_payload, dict)
    assert result == [{"action": "click", "source_engine": "gemini", "confidence": 0.7}]
    assert captured["parsed_endpoint"] == ("https", "engine.example.com", 443, "/infer")
    assert captured["timeout_seconds"] == 2
    assert len(str(request_payload["html_content"])) == 12000
