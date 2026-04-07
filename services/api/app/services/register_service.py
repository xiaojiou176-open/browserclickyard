from __future__ import annotations

from app.core.settings import env_str

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException, status

from app.models.register import RegisterRequest, RegisterResponse


@dataclass(frozen=True)
class RegisteredUser:
    user_id: str
    email: str


class RegisterService:
    def __init__(self) -> None:
        self._csrf_tokens: dict[str, datetime] = {}
        self._csrf_ttl_seconds = max(60, int(env_str("CSRF_TTL_SECONDS", "900")))
        self._users_by_email: dict[str, RegisteredUser] = {}
        self._lock = Lock()

    def issue_csrf_token(self) -> str:
        token = token_urlsafe(24)
        with self._lock:
            self._prune_expired_tokens_locked()
            self._csrf_tokens[token] = datetime.now(timezone.utc) + timedelta(
                seconds=self._csrf_ttl_seconds
            )
        return token

    @property
    def csrf_ttl_seconds(self) -> int:
        return self._csrf_ttl_seconds

    def validate_csrf(self, header_token: str | None, cookie_token: str | None) -> None:
        if not header_token or not cookie_token:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="missing CSRF token",
            )
        if header_token != cookie_token:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CSRF token mismatch",
            )
        with self._lock:
            expiry = self._csrf_tokens.get(header_token)
            if not expiry:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="invalid CSRF token",
                )
            if expiry < datetime.now(timezone.utc):
                self._csrf_tokens.pop(header_token, None)
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="expired CSRF token",
                )
            self._csrf_tokens.pop(header_token, None)

    def register_user(self, payload: RegisterRequest) -> RegisterResponse:
        with self._lock:
            if payload.email in self._users_by_email:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="email already registered",
                )
            user = RegisteredUser(user_id=str(uuid4()), email=payload.email)
            self._users_by_email[payload.email] = user
        return RegisterResponse(user_id=user.user_id, email=user.email)

    def reset(self) -> None:
        with self._lock:
            self._csrf_tokens.clear()
            self._users_by_email.clear()

    def _prune_expired_tokens_locked(self) -> None:
        now = datetime.now(timezone.utc)
        expired = [token for token, expiry in self._csrf_tokens.items() if expiry < now]
        for token in expired:
            self._csrf_tokens.pop(token, None)


register_service = RegisterService()
