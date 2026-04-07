from __future__ import annotations

from email.message import EmailMessage
from typing import Any

import pytest

import app.services.otp_providers as otp_module
from app.services.otp_providers import OtpFetchRequest, _fetch_from_imap


def _new_email_bytes(sender: str, subject: str, body: str) -> bytes:
    msg = EmailMessage()
    msg["From"] = sender
    msg["Subject"] = subject
    msg.set_content(body)
    return msg.as_bytes()


class _SequencedFakeImap:
    def __init__(
        self,
        host: str,
        *,
        search_ids: bytes,
        fetch_map: dict[bytes, tuple[str, list[Any]]],
    ) -> None:
        self.host = host
        self.search_ids = search_ids
        self.fetch_map = fetch_map
        self.fetch_calls: list[bytes] = []

    def login(self, username: str, password: str) -> tuple[str, list[Any]]:
        assert username
        assert password
        return ("OK", [])

    def select(self, mailbox: str) -> tuple[str, list[Any]]:
        assert mailbox == "INBOX"
        return ("OK", [])

    def search(self, charset: Any, criteria: str) -> tuple[str, list[bytes]]:
        assert criteria == "ALL"
        return ("OK", [self.search_ids])

    def fetch(self, message_id: bytes, query: str) -> tuple[str, list[Any]]:
        assert query == "(RFC822)"
        self.fetch_calls.append(message_id)
        status, payload = self.fetch_map[message_id]
        return (status, payload)

    def close(self) -> tuple[str, list[Any]]:
        return ("OK", [])

    def logout(self) -> tuple[str, list[Any]]:
        return ("BYE", [])


def test_fetch_from_imap_skips_invalid_raw_payload_and_falls_back_to_older_mail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _SequencedFakeImap(
        host="imap.example.com",
        search_ids=b"1 2",
        fetch_map={
            b"2": ("OK", [b"noise", (b"meta", "not-bytes-payload")]),
            b"1": (
                "OK",
                [(b"1", _new_email_bytes("noreply@example.com", "Your OTP", "code 246810"))],
            ),
        },
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)

    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )

    assert code == "246810"
    assert fake.fetch_calls == [b"2", b"1"]


def test_fetch_from_imap_subject_filter_failure_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _SequencedFakeImap(
        host="imap.example.com",
        search_ids=b"1",
        fetch_map={
            b"1": (
                "OK",
                [(b"1", _new_email_bytes("noreply@example.com", "Password Reset", "code 112233"))],
            ),
        },
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


def test_fetch_from_imap_continues_when_latest_body_has_no_regex_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _SequencedFakeImap(
        host="imap.example.com",
        search_ids=b"1 2",
        fetch_map={
            b"2": (
                "OK",
                [(b"2", _new_email_bytes("noreply@example.com", "Your OTP", "no code here"))],
            ),
            b"1": (
                "OK",
                [(b"1", _new_email_bytes("noreply@example.com", "Your OTP", "code 778899"))],
            ),
        },
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)

    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b(\d{6})\b"),
    )

    assert code == "778899"
    assert fake.fetch_calls == [b"2", b"1"]


def test_fetch_from_imap_returns_whole_match_without_capture_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _SequencedFakeImap(
        host="imap.example.com",
        search_ids=b"1",
        fetch_map={
            b"1": (
                "OK",
                [(b"1", _new_email_bytes("noreply@example.com", "Your OTP", "code 135790"))],
            ),
        },
    )
    monkeypatch.setattr(otp_module.imaplib, "IMAP4_SSL", lambda host: fake)

    code = _fetch_from_imap(
        "imap.example.com",
        "user",
        "pass",
        OtpFetchRequest(provider="imap", regex=r"\b\d{6}\b"),
    )

    assert code == "135790"
