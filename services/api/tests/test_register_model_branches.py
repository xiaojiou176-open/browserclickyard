from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.register import RegisterRequest


def test_register_request_normalizes_email() -> None:
    payload = RegisterRequest(email="  USER@Example.COM  ", password="StrongPass1!")

    assert payload.email == "user@example.com"


@pytest.mark.parametrize(
    ("email", "message"),
    [
        ("invalid-email", "email must contain @"),
    ],
)
def test_register_request_rejects_invalid_email(email: str, message: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        RegisterRequest(email=email, password="StrongPass1!")  # pragma: allowlist secret

    assert message in str(exc_info.value)


@pytest.mark.parametrize(
    ("password", "message"),
    [
        ("lowercase1!", "password must contain an uppercase letter"),
        ("UPPERCASE1!", "password must contain a lowercase letter"),
        ("NoDigits!", "password must contain a digit"),
        ("NoSpecial1", "password must contain a special character"),
    ],
)
def test_register_request_rejects_weak_password_variants(password: str, message: str) -> None:
    with pytest.raises(ValidationError) as exc_info:
        RegisterRequest(email="user@example.com", password=password)

    assert message in str(exc_info.value)
