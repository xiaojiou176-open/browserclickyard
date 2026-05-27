from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator


class RegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128, pattern=r"^[!-~]{8,128}$")

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email_input(cls, value: str) -> str:
        return str(value).strip().lower()

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value
        if "@" not in normalized:
            raise ValueError("email must contain @")
        if not re.fullmatch(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", normalized):
            raise ValueError("value does not match email format")
        return normalized

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if not value.isascii():
            raise ValueError("password must be ASCII")
        if not any(char.isupper() for char in value):
            raise ValueError("password must contain an uppercase letter")
        if not any(char.islower() for char in value):
            raise ValueError("password must contain a lowercase letter")
        if not any(char.isdigit() for char in value):
            raise ValueError("password must contain a digit")
        if not any(not char.isalnum() for char in value):
            raise ValueError("password must contain a special character")
        return value


class RegisterResponse(BaseModel):
    user_id: str
    email: str


class CsrfResponse(BaseModel):
    csrf_token: str
