from __future__ import annotations

import os
from typing import Any
from email.message import EmailMessage

import pytest

import app.services.otp_providers as otp_module
from app.services.otp_providers import (
    OtpFetchRequest,
    _extract_body_text,
    _fetch_from_imap,
    resolve_otp_code,
)
from app.services.vonage_inbox import VonageInboundMessage, vonage_inbox_service


def test_resolve_otp_code_manual() -> None:
    code = resolve_otp_code(
        OtpFetchRequest(provider="manual", regex=r"\b(\d{6})\b", manual_code="654321"),
    )
    assert code == "654321"


def test_resolve_otp_code_unknown_provider() -> None:
    code = resolve_otp_code(OtpFetchRequest(provider="unknown", regex=r"\b(\d{6})\b"))
    assert code is None


def test_extract_body_text_plain() -> None:
    msg = EmailMessage()
    msg.set_content("your otp is 112233")
    body = _extract_body_text(msg)
    assert "112233" in body


def test_resolve_otp_code_vonage(monkeypatch) -> None:
    inbox_path = vonage_inbox_service._inbox_path
    if inbox_path.exists():
        inbox_path.unlink()
    monkeypatch.setenv("VONAGE_OTP_TO_NUMBER", "15550001111")
    vonage_inbox_service.append_message(
        VonageInboundMessage(
            provider="vonage",
            from_number="15556667777",
            to_number="15550001111",
            text="Your code is 778899",
            message_id="m-1",
            received_at="2026-02-19T00:00:00+00:00",
            raw={"text": "Your code is 778899"},
        )
    )
    code = resolve_otp_code(OtpFetchRequest(provider="vonage", regex=r"\b(\d{6})\b"))
    assert code == "778899"
    if inbox_path.exists():
        inbox_path.unlink()
    os.environ.pop("VONAGE_OTP_TO_NUMBER", None)


def test_resolve_otp_code_vonage_requires_to_number(monkeypatch) -> None:
    monkeypatch.delenv("VONAGE_OTP_TO_NUMBER", raising=False)
    code = resolve_otp_code(OtpFetchRequest(provider="vonage", regex=r"\b(\d{6})\b"))
    assert code is None


def test_vonage_latest_otp_strict_to_number_filter(monkeypatch) -> None:
    inbox_path = vonage_inbox_service._inbox_path
    if inbox_path.exists():
        inbox_path.unlink()
    monkeypatch.setenv("VONAGE_OTP_TO_NUMBER", "+1 (555) 000-1111")
    vonage_inbox_service.append_message(
        VonageInboundMessage(
            provider="vonage",
            from_number="15556667777",
            to_number="15559998888",
            text="Your code is 112233",
            message_id="m-2",
            received_at="2026-02-19T00:00:00+00:00",
            raw={"text": "Your code is 112233"},
        )
    )
    vonage_inbox_service.append_message(
        VonageInboundMessage(
            provider="vonage",
            from_number="15556667777",
            to_number="+1-555-000-1111",
            text="Your code is 445566",
            message_id="m-3",
            received_at="2026-02-19T00:00:01+00:00",
            raw={"text": "Your code is 445566"},
        )
    )
    code = resolve_otp_code(OtpFetchRequest(provider="vonage", regex=r"\b(\d{6})\b"))
    assert code == "445566"
    if inbox_path.exists():
        inbox_path.unlink()


class _FakeImap:
    def __init__(
        self,
        host: str,
        *,
        search_status: str = "OK",
        fetch_status: str = "OK",
        message_bytes: bytes | None = None,
        close_raises: bool = False,
    ) -> None:
        self.host = host
        self.search_status = search_status
        self.fetch_status = fetch_status
        self.message_bytes = message_bytes
        self.close_raises = close_raises
        self.closed = False
        self.logged_out = False

    def login(self, username: str, password: str) -> tuple[str, list[Any]]:
        assert username
        assert password
        return ("OK", [])

    def select(self, mailbox: str) -> tuple[str, list[Any]]:
        assert mailbox == "INBOX"
        return ("OK", [])

    def search(self, charset: Any, criteria: str) -> tuple[str, list[bytes]]:
        assert criteria == "ALL"
        return (self.search_status, [b"1"])

    def fetch(self, message_id: bytes, query: str) -> tuple[str, list[tuple[bytes, bytes]]]:
        assert query == "(RFC822)"
        payload = self.message_bytes or b""
        return (self.fetch_status, [(message_id, payload)])

    def close(self) -> tuple[str, list[Any]]:
        self.closed = True
        if self.close_raises:
            raise RuntimeError("close failed")
        return ("OK", [])

    def logout(self) -> tuple[str, list[Any]]:
        self.logged_out = True
        return ("BYE", [])


def _new_email_bytes(sender: str, subject: str, body: str) -> bytes:
    msg = EmailMessage()
    msg["From"] = sender
    msg["Subject"] = subject
    msg.set_content(body)
    return msg.as_bytes()


def test_resolve_otp_code_gmail_uses_imap_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GMAIL_IMAP_USER", "user@example.com")
    monkeypatch.setenv("GMAIL_IMAP_PASSWORD", "pwd")
    captured: dict[str, str] = {}

    def _fake_fetch(host: str, username: str, password: str, req: OtpFetchRequest) -> str | None:
        captured["host"] = host
        captured["username"] = username
        captured["password"] = password
        assert req.provider == "gmail"
        return "123456"

    monkeypatch.setattr(otp_module, "_fetch_from_imap", _fake_fetch)
    code = resolve_otp_code(OtpFetchRequest(provider="gmail", regex=r"\b(\d{6})\b"))
    assert code == "123456"
    assert captured == {
        "host": "imap.gmail.com",
        "username": "user@example.com",
        "password": "pwd",  # pragma: allowlist secret
    }


def test_resolve_otp_code_gmail_missing_credentials_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GMAIL_IMAP_USER", raising=False)
    monkeypatch.delenv("GMAIL_IMAP_PASSWORD", raising=False)
    assert resolve_otp_code(OtpFetchRequest(provider="gmail", regex=r"\b(\d{6})\b")) is None


def test_resolve_otp_code_imap_missing_credentials_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("IMAP_HOST", raising=False)
    monkeypatch.delenv("IMAP_USER", raising=False)
    monkeypatch.delenv("IMAP_PASSWORD", raising=False)
    assert resolve_otp_code(OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b")) is None


def test_resolve_otp_code_imap_uses_env_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IMAP_HOST", "imap.example.com")
    monkeypatch.setenv("IMAP_USER", "imap-user")
    monkeypatch.setenv("IMAP_PASSWORD", "imap-pass")
    monkeypatch.setattr(otp_module, "_fetch_from_imap", lambda *args, **kwargs: "778800")
    assert resolve_otp_code(OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b")) == "778800"


def test_fetch_from_imap_extracts_latest_code(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeImap(
        host="imap.example.com",
        message_bytes=_new_email_bytes("noreply@example.com", "Your OTP", "code 456789"),
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)
    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )
    assert code == "456789"
    assert fake.closed is True
    assert fake.logged_out is True


def test_fetch_from_imap_applies_sender_and_subject_filters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeImap(
        host="imap.example.com",
        message_bytes=_new_email_bytes("other@example.com", "Ignore this", "code 456789"),
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)
    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(
            provider="imap",
            regex=r"\b(\d{6})\b",
            sender_filter="noreply@example.com",
            subject_filter="Your OTP",
        ),
    )
    assert code is None


def test_fetch_from_imap_returns_none_when_search_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeImap(host="imap.example.com", search_status="NO")
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)
    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )
    assert code is None


def test_fetch_from_imap_returns_none_when_fetch_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeImap(
        host="imap.example.com",
        fetch_status="NO",
        message_bytes=_new_email_bytes("noreply@example.com", "OTP", "code 445566"),
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)
    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )
    assert code is None
    assert fake.closed is True
    assert fake.logged_out is True


def test_fetch_from_imap_tolerates_close_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeImap(
        host="imap.example.com",
        message_bytes=_new_email_bytes("noreply@example.com", "OTP", "code 112233"),
        close_raises=True,
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)
    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )
    assert code == "112233"
    assert fake.logged_out is True


def test_extract_body_text_multipart_only_reads_text_plain() -> None:
    msg = EmailMessage()
    msg.set_content("plain code 999888")
    msg.add_alternative("<p>html code 000111</p>", subtype="html")
    body = _extract_body_text(msg)
    assert "999888" in body
    assert "000111" not in body


def test_extract_body_text_multipart_skips_non_bytes_payload() -> None:
    class _FakePart:
        def __init__(self, content_type: str, payload: Any) -> None:
            self._content_type = content_type
            self._payload = payload

        def get_content_type(self) -> str:
            return self._content_type

        def get_payload(self, decode: bool = False) -> Any:
            assert decode is True
            return self._payload

    class _FakeMessage:
        def is_multipart(self) -> bool:
            return True

        def walk(self) -> list[_FakePart]:
            return [
                _FakePart("text/plain", "plain-text-not-bytes"),
                _FakePart("text/html", b"<p>x</p>"),
            ]

    assert _extract_body_text(_FakeMessage()) == ""


def test_extract_body_text_non_multipart_non_bytes_falls_back_to_str() -> None:
    class _FakeMessage:
        def is_multipart(self) -> bool:
            return False

        def get_payload(self, decode: bool = False) -> Any:
            assert decode is True
            return 123

    assert _extract_body_text(_FakeMessage()) == "123"
