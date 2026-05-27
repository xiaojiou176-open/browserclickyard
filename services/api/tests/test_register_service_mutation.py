from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
from uuid import UUID

import pytest
from fastapi import HTTPException

import app.core.settings as core_settings
from app.models.register import RegisterRequest
from app.services.register_service import RegisterService, RegisteredUser

register_service_module = importlib.import_module("backend.app.services.register_service")


def test_register_service_csrf_ttl_has_minimum_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "1")
    service = RegisterService()
    assert service.csrf_ttl_seconds == 60


def test_register_service_csrf_ttl_uses_env_when_above_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "1200")
    service = RegisterService()
    assert service.csrf_ttl_seconds == 1200


def test_register_service_csrf_ttl_uses_default_when_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CSRF_TTL_SECONDS", raising=False)
    service = RegisterService()
    assert service.csrf_ttl_seconds == 900


def test_register_service_default_ttl_when_settings_loader_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CSRF_TTL_SECONDS", raising=False)

    def _raise_runtime_error() -> None:
        raise RuntimeError("forced settings loader failure")

    monkeypatch.setattr(core_settings, "_settings_without_env_file", _raise_runtime_error)
    service = RegisterService()
    assert service.csrf_ttl_seconds == 900


def test_issue_csrf_token_prunes_expired_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    now = datetime.now(timezone.utc)
    with service._lock:
        service._csrf_tokens["expired"] = now - timedelta(seconds=1)
        service._csrf_tokens["alive"] = now + timedelta(seconds=60)

    new_token = service.issue_csrf_token()

    with service._lock:
        assert "expired" not in service._csrf_tokens
        assert "alive" in service._csrf_tokens
        assert new_token in service._csrf_tokens


def test_issue_csrf_token_length_is_stable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = service.issue_csrf_token()
    assert len(token) == 32


def test_validate_csrf_consumes_token_and_rejects_reuse(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = service.issue_csrf_token()
    service.validate_csrf(header_token=token, cookie_token=token)

    with pytest.raises(HTTPException) as exc:
        service.validate_csrf(header_token=token, cookie_token=token)

    assert exc.value.status_code == 403
    assert exc.value.detail == "invalid CSRF token"


def test_validate_csrf_rejects_single_side_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()

    with pytest.raises(HTTPException) as header_missing:
        service.validate_csrf(header_token=None, cookie_token="cookie")
    assert header_missing.value.status_code == 403
    assert header_missing.value.detail == "missing CSRF token"

    with pytest.raises(HTTPException) as cookie_missing:
        service.validate_csrf(header_token="header", cookie_token=None)
    assert cookie_missing.value.status_code == 403
    assert cookie_missing.value.detail == "missing CSRF token"


def test_validate_csrf_rejects_mismatch_with_strict_error_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    with pytest.raises(HTTPException) as exc:
        service.validate_csrf(header_token="header", cookie_token="cookie")
    assert exc.value.status_code == 403
    assert exc.value.detail == "CSRF token mismatch"


def test_validate_csrf_rejects_expired_token_and_removes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = service.issue_csrf_token()
    with service._lock:
        service._csrf_tokens[token] = datetime.now(timezone.utc) - timedelta(seconds=1)

    with pytest.raises(HTTPException) as exc:
        service.validate_csrf(header_token=token, cookie_token=token)

    assert exc.value.status_code == 403
    assert exc.value.detail == "expired CSRF token"
    with service._lock:
        assert token not in service._csrf_tokens


def test_validate_csrf_accepts_token_expiring_exactly_now(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = "boundary-token"
    boundary_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    class _FixedDateTime:
        @staticmethod
        def now(_tz: timezone) -> datetime:
            return boundary_now

    monkeypatch.setattr(register_service_module, "datetime", _FixedDateTime)
    with service._lock:
        service._csrf_tokens[token] = boundary_now

    service.validate_csrf(header_token=token, cookie_token=token)
    with service._lock:
        assert token not in service._csrf_tokens


def test_prune_does_not_remove_token_expiring_exactly_now(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    boundary_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    token = "boundary-token"

    class _FixedDateTime:
        @staticmethod
        def now(_tz: timezone) -> datetime:
            return boundary_now

    monkeypatch.setattr(register_service_module, "datetime", _FixedDateTime)
    with service._lock:
        service._csrf_tokens[token] = boundary_now
        service._prune_expired_tokens_locked()
        assert token in service._csrf_tokens


def test_validate_csrf_tolerates_token_removed_mid_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = "reentrant-token"
    boundary_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    with service._lock:
        service._csrf_tokens[token] = boundary_now + timedelta(seconds=1)

    class _DateTimeWithSideEffect:
        @staticmethod
        def now(_tz: timezone) -> datetime:
            # Simulate re-entrant state change between expiry read and final pop().
            service._csrf_tokens.pop(token, None)
            return boundary_now

    monkeypatch.setattr(register_service_module, "datetime", _DateTimeWithSideEffect)
    service.validate_csrf(header_token=token, cookie_token=token)
    with service._lock:
        assert token not in service._csrf_tokens


def test_validate_csrf_tolerates_token_removed_mid_expiry_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    token = "expired-reentrant-token"
    boundary_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    with service._lock:
        service._csrf_tokens[token] = boundary_now - timedelta(seconds=1)

    class _DateTimeWithSideEffect:
        @staticmethod
        def now(_tz: timezone) -> datetime:
            # Simulate re-entrant state change before the expired-token pop().
            service._csrf_tokens.pop(token, None)
            return boundary_now

    monkeypatch.setattr(register_service_module, "datetime", _DateTimeWithSideEffect)
    with pytest.raises(HTTPException) as exc:
        service.validate_csrf(header_token=token, cookie_token=token)

    assert exc.value.status_code == 403
    assert exc.value.detail == "expired CSRF token"


def test_prune_tolerates_token_removed_during_expired_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    boundary_now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    token = "prune-reentrant-token"

    class _ReentrantDict(dict[str, datetime]):
        def items(self):  # type: ignore[override]
            for key, value in list(super().items()):
                super().pop(key, None)
                yield key, value

    service._csrf_tokens = _ReentrantDict(
        {
            token: boundary_now - timedelta(seconds=1),
        }
    )

    class _FixedDateTime:
        @staticmethod
        def now(_tz: timezone) -> datetime:
            return boundary_now

    monkeypatch.setattr(register_service_module, "datetime", _FixedDateTime)
    with service._lock:
        service._prune_expired_tokens_locked()
        assert token not in service._csrf_tokens


def test_register_user_duplicate_email_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    payload = RegisterRequest(email="dup@example.com", password="StrongPass1!")

    first = service.register_user(payload)
    assert first.email == "dup@example.com"

    with pytest.raises(HTTPException) as exc:
        service.register_user(payload)

    assert exc.value.status_code == 409
    assert exc.value.detail == "email already registered"
    assert isinstance(service._users_by_email[payload.email], RegisteredUser)


def test_register_user_returns_uuid_and_internal_mapping(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CSRF_TTL_SECONDS", "600")
    service = RegisterService()
    payload = RegisterRequest(email="shape@example.com", password="StrongPass1!")
    registered = service.register_user(payload)

    parsed = UUID(registered.user_id)
    assert str(parsed) == registered.user_id
    assert service._users_by_email[payload.email].user_id == registered.user_id
