from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.register_service import register_service

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_register_state() -> None:
    register_service.reset()
    client.cookies.clear()


def test_register_page_redirects_to_frontend_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRONTEND_REGISTER_URL", raising=False)
    response = client.get("/register", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "http://127.0.0.1:4173/register"


def test_register_page_redirects_to_frontend_empty_env_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FRONTEND_REGISTER_URL", "   ")
    response = client.get("/register", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "http://127.0.0.1:4173/register"


def test_register_page_redirects_to_frontend_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRONTEND_REGISTER_URL", "http://127.0.0.1:5173/register")
    response = client.get("/register", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "http://127.0.0.1:5173/register"


def test_register_rejects_missing_csrf() -> None:
    response = client.post(
        "/api/register",
        json={"email": "test@example.com", "password": "S3cretPass!"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "missing CSRF token"


def test_register_rejects_csrf_mismatch() -> None:
    client.cookies.set("csrf_token", "cookie-token")
    response = client.post(
        "/api/register",
        json={"email": "test@example.com", "password": "S3cretPass!"},
        headers={"X-CSRF-Token": "header-token"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "CSRF token mismatch"


def test_register_rejects_invalid_csrf_token() -> None:
    client.cookies.set("csrf_token", "unknown-token")
    response = client.post(
        "/api/register",
        json={"email": "test@example.com", "password": "S3cretPass!"},
        headers={"X-CSRF-Token": "unknown-token"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "invalid CSRF token"


def test_register_success_and_duplicate_conflict() -> None:
    csrf_response = client.get("/api/csrf")
    assert csrf_response.status_code == 200
    token = csrf_response.json()["csrf_token"]

    created = client.post(
        "/api/register",
        json={"email": "test@example.com", "password": "S3cretPass!"},
        headers={"X-CSRF-Token": token},
    )
    assert created.status_code == 201
    assert created.json()["email"] == "test@example.com"
    assert created.json()["user_id"]

    next_csrf = client.get("/api/csrf")
    duplicate = client.post(
        "/api/register",
        json={"email": "test@example.com", "password": "S3cretPass!"},
        headers={"X-CSRF-Token": next_csrf.json()["csrf_token"]},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "email already registered"


def test_register_rejects_weak_password() -> None:
    csrf_response = client.get("/api/csrf")
    token = csrf_response.json()["csrf_token"]
    response = client.post(
        "/api/register",
        json={"email": "weak@example.com", "password": "weakpass"},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 422


def test_register_rejects_expired_csrf() -> None:
    csrf_response = client.get("/api/csrf")
    token = csrf_response.json()["csrf_token"]
    with register_service._lock:
        register_service._csrf_tokens[token] = datetime.now(timezone.utc) - timedelta(seconds=1)
    response = client.post(
        "/api/register",
        json={"email": "expired@example.com", "password": "StrongPass1!"},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "expired CSRF token"


def test_issue_csrf_sets_secure_cookie_on_https_with_secure_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COOKIE_SECURE", "true")
    https_client = TestClient(app, base_url="https://testserver")
    response = https_client.get("/api/csrf")
    assert response.status_code == 200
    set_cookie = response.headers.get("set-cookie", "")
    assert "Secure" in set_cookie
    assert "HttpOnly" in set_cookie
