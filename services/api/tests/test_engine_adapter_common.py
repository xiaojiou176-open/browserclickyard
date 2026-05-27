from __future__ import annotations

import app.services.engine_adapters.common as common
import pytest


def test_parse_remote_endpoint_rejects_non_https() -> None:
    assert common._parse_remote_endpoint("http://recon.example.com/infer") is None


def test_parse_remote_endpoint_rejects_private_and_loopback_hosts() -> None:
    blocked = [
        "https://127.0.0.1/infer",
        "https://10.0.0.8/infer",
        "https://169.254.169.254/infer",
        "https://192.168.1.10/infer",
    ]
    for endpoint in blocked:
        assert common._parse_remote_endpoint(endpoint) is None


def test_parse_remote_endpoint_accepts_public_https_host() -> None:
    parsed = common._parse_remote_endpoint("https://allowed.example.com/infer?x=1")
    assert parsed == ("https", "allowed.example.com", 443, "/infer?x=1")


def test_call_remote_engine_ssrf_block_returns_none_without_network(monkeypatch) -> None:
    monkeypatch.setenv("RECON_REMOTE_ENGINE_ENDPOINT", "https://127.0.0.1/infer")
    called = {"post": 0}

    def _should_not_post(*args, **kwargs):
        called["post"] += 1
        raise AssertionError("network call should not happen for blocked endpoint")

    monkeypatch.setattr(common, "_post_json", _should_not_post)
    result = common.call_remote_engine(
        "RECON_REMOTE_ENGINE_ENDPOINT",
        common.EngineInput(
            start_url="https://example.com",
            har_entries=[],
            html_content="<html></html>",
            extractor_strategy="balanced",
        ),
        "gemini",
    )
    assert result is None
    assert called["post"] == 0


def test_parse_remote_endpoint_blocks_dns_resolved_private_host(monkeypatch) -> None:
    monkeypatch.setattr(
        common.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (common.socket.AF_INET, common.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ],
    )
    assert common._parse_remote_endpoint("https://internal.example.com/infer") is None


def test_parse_remote_endpoint_allows_dns_resolved_public_host(monkeypatch) -> None:
    monkeypatch.setattr(
        common.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (common.socket.AF_INET, common.socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        ],
    )
    parsed = common._parse_remote_endpoint("https://public.example.com/infer")
    assert parsed == ("https", "public.example.com", 443, "/infer")


def test_score_entry_handles_missing_url_and_static_assets() -> None:
    assert common._score_entry({"method": "POST", "status": 200}, preferred_host=None) == -999
    static_score = common._score_entry(
        {"method": "GET", "url": "https://a.example.com/app.css", "status": 200},
        preferred_host="a.example.com",
    )
    action_score = common._score_entry(
        {"method": "POST", "url": "https://a.example.com/register", "status": 201},
        preferred_host="a.example.com",
    )
    assert static_score < action_score


def test_pick_primary_entry_prefers_actionable_request_on_preferred_host() -> None:
    selected = common.pick_primary_entry(
        [
            {"method": "GET", "url": "https://cdn.example.com/a.js", "status": 200},
            {"method": "POST", "url": "https://app.example.com/register", "status": 200},
            {"method": "GET", "url": "https://app.example.com/ping", "status": 204},
        ]
    )
    assert selected is not None
    assert selected["url"] == "https://app.example.com/register"


def test_selector_from_html_fallbacks_and_named_selectors() -> None:
    named = "<input name='email' /><input name='password' /><button type='submit'></button>"
    email_named = common._selector_from_html(named, "email")
    password_named = common._selector_from_html(named, "password")
    submit_named = common._selector_from_html(named, "submit")
    assert email_named["selectors"][0]["kind"] == "name"
    assert password_named["selectors"][0]["kind"] == "name"
    assert submit_named["selectors"][0]["value"] == "button[type='submit']"

    fallback = "<div>No explicit submit button here</div>"
    submit_fallback = common._selector_from_html(fallback, "submit")
    unknown = common._selector_from_html(fallback, "unknown")
    assert submit_fallback["selectors"][0]["kind"] == "role"
    assert unknown["selectors"] == []


def test_build_heuristic_steps_manual_gate_when_no_primary_entry() -> None:
    steps = common.build_heuristic_steps(
        "gemini",
        common.EngineInput(
            start_url="https://example.com/start",
            har_entries=[],
            html_content="<html></html>",
            extractor_strategy="balanced",
        ),
        confidence=0.6,
    )
    assert len(steps) == 2
    assert steps[0]["action"] == "navigate"
    assert steps[1]["action"] == "manual_gate"
    assert steps[1]["manual_handoff_required"] is True


def test_build_heuristic_steps_contains_type_click_assert_actions() -> None:
    steps = common.build_heuristic_steps(
        "gemini",
        common.EngineInput(
            start_url="https://example.com/start",
            har_entries=[{"method": "POST", "url": "https://example.com/register", "status": 200}],
            html_content="<input name='email'><input name='password'><button type='submit'>OK</button>",
            extractor_strategy="balanced",
        ),
        confidence=0.8,
    )
    assert [step["action"] for step in steps] == ["navigate", "type", "type", "click", "assert"]
    assert steps[1]["evidence_ref"].endswith(":email")
    assert steps[2]["value_ref"] == "${secrets.password}"
    assert steps[3]["confidence"] == pytest.approx(0.76)


def test_call_remote_engine_normalizes_response_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECON_REMOTE_ENGINE_ENDPOINT", "https://engine.example.com/infer")
    monkeypatch.setattr(common, "_is_forbidden_host", lambda _hostname: False)

    def fake_post(_endpoint, _payload, _timeout):
        return (
            '{"steps":[{"action":"click","confidence":2,"source_engine":"","extra":"ok"},'
            '{"action":"type","confidence":-1},'
            '{"action":"", "confidence":0.6},'
            '"invalid"]}'
        )

    monkeypatch.setattr(common, "_post_json", fake_post)
    result = common.call_remote_engine(
        "RECON_REMOTE_ENGINE_ENDPOINT",
        common.EngineInput(
            start_url="https://example.com",
            har_entries=[],
            html_content="<html></html>",
            extractor_strategy="balanced",
        ),
        "gemini",
    )
    assert result is not None
    assert len(result) == 2
    assert result[0]["action"] == "click"
    assert result[0]["confidence"] == 1.0
    assert result[0]["source_engine"] == "gemini"
    assert result[1]["confidence"] == 0.0


def test_call_remote_engine_handles_invalid_responses_and_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECON_REMOTE_ENGINE_ENDPOINT", "https://engine.example.com/infer")
    monkeypatch.setattr(common, "_is_forbidden_host", lambda _hostname: False)

    payload = common.EngineInput(
        start_url="https://example.com",
        har_entries=[],
        html_content="<html></html>",
        extractor_strategy="balanced",
    )

    monkeypatch.setattr(common, "_post_json", lambda *_args, **_kwargs: "[]")
    assert common.call_remote_engine("RECON_REMOTE_ENGINE_ENDPOINT", payload, "gemini") is None

    monkeypatch.setattr(common, "_post_json", lambda *_args, **_kwargs: '{"steps": "not-a-list"}')
    assert common.call_remote_engine("RECON_REMOTE_ENGINE_ENDPOINT", payload, "gemini") is None

    def raise_post(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(common, "_post_json", raise_post)
    assert common.call_remote_engine("RECON_REMOTE_ENGINE_ENDPOINT", payload, "gemini") is None
