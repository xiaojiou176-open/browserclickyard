from __future__ import annotations

import json
import hashlib
import hmac
import threading
import time
from collections.abc import Generator
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app.api.integrations_vonage import (
    InboundAuthError,
    _build_signature_payload,
    _check_inbound_token,
    _load_signature_secret,
    _resolve_inbound_token,
    _verify_signature,
)
from app.main import app
from app.services.vonage_inbox import vonage_inbox_service

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_inbox_file() -> Generator[None, None, None]:
    paths = [
        vonage_inbox_service._inbox_path,
        vonage_inbox_service._dedupe_path,
    ]
    for path in paths:
        if path.exists():
            path.unlink()
    yield
    for path in paths:
        if path.exists():
            path.unlink()


def _signed_payload(secret: str, payload: dict[str, str]) -> dict[str, str]:
    signed = dict(payload)
    signed["timestamp"] = str(int(time.time()))
    data = _build_signature_payload(signed)
    signed["sig"] = hmac.new(
        secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return signed


def _jsonl_line_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(path.read_text(encoding="utf-8").splitlines())


def _jsonl_last_record(path: Path) -> dict[str, object] | None:
    if not path.exists():
        return None
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return None
    return json.loads(lines[-1])


def test_vonage_inbound_sms_post_persists_message(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 123456",
                "messageId": "abc-1",
                "token": "token-123",
            },
        ),
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    code = vonage_inbox_service.latest_otp(regex=r"\b(\d{6})\b", to_number="15550001111")
    assert code == "123456"


def test_vonage_inbound_sms_number_normalization_keeps_strict_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "+1 (555) 666-7777",
                "to": "+1 (555) 000-1111",
                "text": "Code 111222",
                "messageId": "abc-normalized-1",
                "token": "token-123",
            },
        ),
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    code = vonage_inbox_service.latest_otp(regex=r"\b(\d{6})\b", to_number=15550001111)
    assert code == "111222"

    wrong_number_code = vonage_inbox_service.latest_otp(
        regex=r"\b(\d{6})\b", to_number="15550002222"
    )
    assert wrong_number_code is None


def test_vonage_inbound_sms_get_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-456")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 654321",
        },
    )
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        params=params,
    )
    assert response.status_code == 401


def test_vonage_inbound_sms_deduplicates_message_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    inbox_count_before = _jsonl_line_count(vonage_inbox_service._inbox_path)
    audit_count_before = _jsonl_line_count(vonage_inbox_service._audit_path)
    payload = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 123456",
            "messageId": "dup-1",
            "token": "token-123",
        },
    )
    first = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=payload,
    )
    assert first.status_code == 200
    assert first.json().get("duplicate") is not True
    inbox_count_after_first = _jsonl_line_count(vonage_inbox_service._inbox_path)
    audit_count_after_first = _jsonl_line_count(vonage_inbox_service._audit_path)
    dedupe_snapshot_after_first = vonage_inbox_service._dedupe_path.read_text(encoding="utf-8")
    assert inbox_count_after_first == inbox_count_before + 1
    assert audit_count_after_first == audit_count_before + 1

    second = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=payload,
    )
    assert second.status_code == 200
    assert second.json().get("duplicate") is True
    assert _jsonl_line_count(vonage_inbox_service._inbox_path) == inbox_count_after_first
    assert _jsonl_line_count(vonage_inbox_service._audit_path) == audit_count_after_first + 1
    assert (
        vonage_inbox_service._dedupe_path.read_text(encoding="utf-8") == dedupe_snapshot_after_first
    )


def test_vonage_inbound_sms_deduplicates_message_id_under_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    inbox_count_before = _jsonl_line_count(vonage_inbox_service._inbox_path)
    audit_count_before = _jsonl_line_count(vonage_inbox_service._audit_path)
    payload = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 121212",
            "messageId": "dup-concurrency-1",
            "token": "token-123",
        },
    )

    barrier = threading.Barrier(2)
    responses: list[tuple[int, dict[str, object]]] = []
    lock = threading.Lock()

    def _worker() -> None:
        barrier.wait()
        response = client.post(
            "/api/integrations/vonage/inbound-sms",
            headers={"x-vonage-inbound-token": "token-123"},
            json=payload,
        )
        with lock:
            responses.append((response.status_code, response.json()))

    threads = [threading.Thread(target=_worker), threading.Thread(target=_worker)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert len(responses) == 2
    assert all(status_code == 200 for status_code, _body in responses)
    duplicate_flags = [bool(body.get("duplicate")) for _status_code, body in responses]
    assert duplicate_flags.count(True) == 1
    assert duplicate_flags.count(False) == 1
    assert _jsonl_line_count(vonage_inbox_service._inbox_path) == inbox_count_before + 1
    assert _jsonl_line_count(vonage_inbox_service._audit_path) == audit_count_before + 2


def test_vonage_inbound_sms_rejects_invalid_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "secret-1")
    monkeypatch.setenv("VONAGE_SIGNATURE_ALGO", "sha256")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json={
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 123456",
            "messageId": "sig-1",
            "sig": "invalid-signature",
            "timestamp": "1893456000",
            "api_key": "dummy",
        },
    )
    assert response.status_code == 401


def test_vonage_inbound_sms_rejects_when_token_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VONAGE_INBOUND_TOKEN", raising=False)
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 123456",
                "messageId": "no-token",
            },
        ),
    )
    assert response.status_code == 503


def test_vonage_inbound_sms_rejects_when_signature_secret_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.delenv("VONAGE_SIGNATURE_SECRET", raising=False)
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json={
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 123456",
            "messageId": "no-secret",
        },
    )
    assert response.status_code == 503


def test_vonage_inbound_sms_rejects_unsupported_signature_algo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    monkeypatch.setenv("VONAGE_SIGNATURE_ALGO", "md5")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 123456",
                "messageId": "bad-algo",
                "token": "token-123",
            },
        ),
    )
    assert response.status_code == 400
    detail = response.json().get("detail", "")
    assert "unsupported Vonage signature algorithm" in detail
    assert "md5" in detail


def test_vonage_inbound_sms_header_token_takes_precedence_over_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms?token=wrong-query-token",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 999888",
                "messageId": "header-precedence",
                "token": "wrong-query-token",
            },
        ),
    )
    assert response.status_code == 200


def test_vonage_inbound_sms_fallback_header_rejected_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "false")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 101010",
                "messageId": "fallback-header-disabled",
            },
        ),
    )
    assert response.status_code == 401
    assert "invalid inbound token" in response.json()["detail"]


def test_vonage_inbound_sms_fallback_headers_allowed_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "true")
    base_payload = {
        "msisdn": "15556667777",
        "to": "15550001111",
        "text": "Code 202020",
    }
    response_x_vonage = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-token": "token-123"},
        json=_signed_payload(
            "sig-secret", {**base_payload, "messageId": "fallback-x-vonage-token"}
        ),
    )
    response_x_inbound = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret", {**base_payload, "messageId": "fallback-x-inbound-token"}
        ),
    )
    assert response_x_vonage.status_code == 200
    assert response_x_inbound.status_code == 200


def test_vonage_inbound_sms_query_token_is_always_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    audit_count_before = _jsonl_line_count(vonage_inbox_service._audit_path)
    response = client.post(
        "/api/integrations/vonage/inbound-sms?token=token-123",
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 555444",
                "messageId": "compat-window",
            },
        ),
    )
    assert response.status_code == 401
    assert (
        response.json()["detail"]
        == "query token is no longer supported; use x-vonage-inbound-token header"
    )
    assert _jsonl_line_count(vonage_inbox_service._audit_path) == audit_count_before + 1
    last_audit = _jsonl_last_record(vonage_inbox_service._audit_path)
    assert last_audit is not None
    assert last_audit.get("reason") == "auth_query_token_disabled"


def test_vonage_inbound_sms_query_token_rejection_audit_reason_is_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = client.build_request("POST", "/api/integrations/vonage/inbound-sms")
    with pytest.raises(InboundAuthError) as excinfo:
        _resolve_inbound_token(request, "token-123")  # type: ignore[arg-type]
    assert (
        excinfo.value.detail
        == "query token is no longer supported; use x-vonage-inbound-token header"
    )
    assert excinfo.value.audit_reason == "auth_query_token_disabled"
    assert excinfo.value.audit_reason != "AUTH_QUERY_TOKEN_DISABLED"


def test_resolve_inbound_token_returns_none_when_fallback_enabled_but_headers_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "true")
    request = client.build_request("POST", "/api/integrations/vonage/inbound-sms")
    assert _resolve_inbound_token(request, None) is None  # type: ignore[arg-type]


def test_resolve_inbound_token_handles_headers_without_raw_attribute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "true")

    class _HeadersWithoutRaw:
        def __init__(self) -> None:
            self._values = {"x-vonage-token": ""}

        def get(self, key: str, default: str = "") -> str:
            return self._values.get(key, default)

    class _RequestLike:
        headers = _HeadersWithoutRaw()

    assert _resolve_inbound_token(_RequestLike(), None) is None  # type: ignore[arg-type]


def test_resolve_inbound_token_uses_lowercase_fallback_header_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "true")

    class _CaseSensitiveHeaders:
        def __init__(self) -> None:
            self._values = {"x-vonage-token": "token-lowercase-only"}

        def get(self, key: str, default: str = "") -> str:
            return self._values.get(key, default)

        raw = None

    class _RequestLike:
        headers = _CaseSensitiveHeaders()

    assert _resolve_inbound_token(_RequestLike(), None) == "token-lowercase-only"  # type: ignore[arg-type]


def test_check_inbound_token_rejects_missing_expected_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VONAGE_INBOUND_TOKEN", raising=False)
    with pytest.raises(InboundAuthError) as excinfo:
        _check_inbound_token("token-123")
    assert excinfo.value.status_code == 503
    assert excinfo.value.audit_reason == "auth_token_not_configured"


def test_check_inbound_token_rejects_mismatch_with_stable_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "expected-token")
    with pytest.raises(InboundAuthError) as excinfo:
        _check_inbound_token("wrong-token")
    assert excinfo.value.status_code == 401
    assert excinfo.value.audit_reason == "auth_token_invalid"


def test_load_signature_secret_requires_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VONAGE_SIGNATURE_SECRET", raising=False)
    with pytest.raises(InboundAuthError) as excinfo:
        _load_signature_secret()
    assert excinfo.value.status_code == 503
    assert excinfo.value.audit_reason == "auth_signature_secret_missing"


def test_load_signature_secret_returns_configured_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "secret-123")
    assert _load_signature_secret() == "secret-123"


def test_build_signature_payload_serializes_original_values() -> None:
    payload = {"foo": "bar", "answer": 42, "none_field": None, "sig": "omit"}
    serialized = _build_signature_payload(payload)
    assert "foo=bar" in serialized
    assert "answer=42" in serialized
    assert "none_field=" not in serialized
    assert "sig=" not in serialized
    assert "None" not in serialized


def test_inbound_auth_error_preserves_audit_reason() -> None:
    error = InboundAuthError(detail="invalid inbound token", audit_reason="auth_token_invalid")
    assert error.status_code == 401
    assert error.detail == "invalid inbound token"
    assert error.audit_reason == "auth_token_invalid"


def test_vonage_inbound_sms_respects_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.access_control as access_control

    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    access_control.reset_for_tests()
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    payload = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 111000",
            "messageId": "rate-limit-1",
        },
    )
    first = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=payload,
    )
    second = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=payload,
    )
    assert first.status_code == 200
    assert second.status_code == 429


def test_vonage_inbound_sms_invalid_token_is_still_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.core.access_control as access_control

    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    access_control.reset_for_tests()
    monkeypatch.setattr(access_control, "_RATE_LIMIT_PER_MINUTE", 1)

    payload = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 222999",
            "messageId": "rate-limit-invalid-token",
        },
    )
    first = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "wrong-token"},
        json=payload,
    )
    second = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "wrong-token"},
        json=payload,
    )
    assert first.status_code == 401
    assert second.status_code == 429


def test_vonage_inbound_sms_get_persists_message(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-789")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 424242",
            "messageId": "get-1",
        },
    )
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-789"},
        params=params,
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "provider": "vonage", "message_id": "get-1"}


def test_vonage_inbound_sms_get_rejects_empty_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-789")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "   ",
            "messageId": "get-empty-text",
        },
    )
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-789"},
        params=params,
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "empty text payload"


def test_vonage_inbound_sms_post_accepts_payload_without_message_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 313131",
            },
        ),
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "provider": "vonage", "message_id": None}


def test_vonage_inbound_sms_post_rejects_when_dedupe_backend_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")

    def _raise_runtime_error(*_args, **_kwargs):
        raise RuntimeError("dedupe backend down")

    monkeypatch.setattr(vonage_inbox_service, "register_message_id", _raise_runtime_error)
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 909090",
                "messageId": "runtime-dedupe-error",
            },
        ),
    )
    assert response.status_code == 503
    assert (
        response.json()["detail"] == "OTP dedupe backend unavailable while OTP_DEDUPE_STRICT=true"
    )


def test_vonage_inbound_sms_when_fallback_enabled_missing_headers_still_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", "true")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "Code 777888",
                "messageId": "fallback-enabled-but-empty",
            },
        ),
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid inbound token"


def test_verify_signature_rejects_missing_or_bad_timestamp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_SIGNATURE_ALGO", "sha256")

    no_sig_payload = {"timestamp": str(int(time.time())), "text": "Code 123456"}
    assert _verify_signature(no_sig_payload, "sig-secret") is False

    payload_without_timestamp = {"text": "Code 123456"}
    unsigned = _build_signature_payload(payload_without_timestamp)
    payload_without_timestamp["sig"] = hmac.new(
        b"sig-secret", unsigned.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    assert _verify_signature(payload_without_timestamp, "sig-secret") is False

    bad_timestamp_payload = {
        "sig": "abc123",
        "timestamp": "not-an-int",
        "text": "Code 123456",
    }
    assert _verify_signature(bad_timestamp_payload, "sig-secret") is False


def test_vonage_inbound_sms_get_rejects_invalid_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        params={
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 121212",
            "messageId": "get-bad-sig",
            "timestamp": str(int(time.time())),
            "sig": "bad-signature",
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "invalid Vonage signature"


def test_vonage_inbound_sms_get_rejects_when_signature_secret_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.delenv("VONAGE_SIGNATURE_SECRET", raising=False)
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 676767",
            "messageId": "get-no-secret",
        },
    )
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        params=params,
    )
    assert response.status_code == 503
    assert response.json()["detail"] == "vonage signature secret is not configured"


def test_vonage_inbound_sms_get_deduplicates_message_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 565656",
            "messageId": "get-duplicate-1",
        },
    )
    first = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        params=params,
    )
    second = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        params=params,
    )
    assert first.status_code == 200
    assert first.json().get("duplicate") is not True
    assert second.status_code == 200
    assert second.json() == {
        "ok": True,
        "provider": "vonage",
        "duplicate": True,
        "message_id": "get-duplicate-1",
    }


def test_vonage_inbound_sms_get_rejects_when_dedupe_backend_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")

    def _raise_runtime_error(*_args, **_kwargs):
        raise RuntimeError("dedupe backend down")

    monkeypatch.setattr(vonage_inbox_service, "register_message_id", _raise_runtime_error)
    params = _signed_payload(
        "sig-secret",
        {
            "msisdn": "15556667777",
            "to": "15550001111",
            "text": "Code 898989",
            "messageId": "get-runtimeerror-1",
        },
    )
    response = client.get(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        params=params,
    )
    assert response.status_code == 503
    assert (
        response.json()["detail"] == "OTP dedupe backend unavailable while OTP_DEDUPE_STRICT=true"
    )


def test_vonage_inbound_sms_post_rejects_empty_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VONAGE_INBOUND_TOKEN", "token-123")
    monkeypatch.setenv("VONAGE_SIGNATURE_SECRET", "sig-secret")
    response = client.post(
        "/api/integrations/vonage/inbound-sms",
        headers={"x-vonage-inbound-token": "token-123"},
        json=_signed_payload(
            "sig-secret",
            {
                "msisdn": "15556667777",
                "to": "15550001111",
                "text": "   ",
                "messageId": "post-empty-text",
            },
        ),
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "empty text payload"
