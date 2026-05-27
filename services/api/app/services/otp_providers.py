from __future__ import annotations

from app.core.settings import env_str

import imaplib
import re
from dataclasses import dataclass
from email import message_from_bytes

from app.services.vonage_inbox import vonage_inbox_service


@dataclass
class OtpFetchRequest:
    provider: str
    regex: str
    sender_filter: str | None = None
    subject_filter: str | None = None
    manual_code: str | None = None


def resolve_otp_code(req: OtpFetchRequest) -> str | None:
    provider = req.provider.strip().lower()
    if provider == "manual":
        code = (req.manual_code or "").strip()
        return code or None
    if provider == "gmail":
        # Gmail uses IMAP; credentials are app-specific password.
        host = "imap.gmail.com"
        username = env_str("GMAIL_IMAP_USER", "").strip()
        password = env_str("GMAIL_IMAP_PASSWORD", "").strip()
        if not username or not password:
            return None
        return _fetch_from_imap(host, username, password, req)
    if provider == "imap":
        host = env_str("IMAP_HOST", "").strip()
        username = env_str("IMAP_USER", "").strip()
        password = env_str("IMAP_PASSWORD", "").strip()
        if not host or not username or not password:
            return None
        return _fetch_from_imap(host, username, password, req)
    if provider == "vonage":
        to_number = env_str("VONAGE_OTP_TO_NUMBER", "").strip() or None
        return vonage_inbox_service.latest_otp(
            regex=req.regex,
            to_number=to_number,
            sender_filter=req.sender_filter,
        )
    return None


def _fetch_from_imap(host: str, username: str, password: str, req: OtpFetchRequest) -> str | None:
    mail = imaplib.IMAP4_SSL(host)
    try:
        mail.login(username, password)
        mail.select("INBOX")
        status, data = mail.search(None, "ALL")
        if status != "OK":
            return None
        message_ids = data[0].split()
        # Always scan from newest to oldest so we prefer the latest OTP email.
        for message_id in reversed(message_ids[-80:]):
            status, msg_data = mail.fetch(message_id, "(RFC822)")
            if status != "OK" or not msg_data:
                continue
            raw = None
            for part in msg_data:
                if isinstance(part, tuple) and len(part) > 1 and isinstance(part[1], bytes):
                    raw = part[1]
                    break
            if not isinstance(raw, bytes):
                continue
            msg = message_from_bytes(raw)
            sender = (msg.get("From") or "").strip()
            subject = (msg.get("Subject") or "").strip()
            if req.sender_filter and req.sender_filter not in sender:
                continue
            if req.subject_filter and req.subject_filter not in subject:
                continue
            body = _extract_body_text(msg)
            match = re.search(req.regex, body)
            if match:
                return match.group(1) if match.groups() else match.group(0)
        return None
    finally:
        try:
            mail.close()
        except Exception:
            pass
        mail.logout()


def _extract_body_text(msg) -> str:
    if msg.is_multipart():
        chunks: list[str] = []
        for part in msg.walk():
            content_type = part.get_content_type()
            if content_type != "text/plain":
                continue
            payload = part.get_payload(decode=True)
            if isinstance(payload, bytes):
                chunks.append(payload.decode(errors="ignore"))
        return "\n".join(chunks)
    payload = msg.get_payload(decode=True)
    if isinstance(payload, bytes):
        return payload.decode(errors="ignore")
    return str(payload or "")
