from __future__ import annotations

import re
from typing import Pattern

from fastapi import HTTPException, status

from .types import ResolvedArtifacts


def validate_preview_id(preview_id: str, pattern: Pattern[str]) -> None:
    if pattern.fullmatch(preview_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="invalid preview_id"
        )


def detect_protection_signals(artifacts: ResolvedArtifacts) -> list[str]:
    signals: list[str] = []
    combined = "\n".join(
        [
            artifacts.html_content.lower(),
            "\n".join(str(item.get("url") or "").lower() for item in artifacts.har_entries),
        ]
    )
    patterns = {
        "cloudflare": r"cloudflare|cf_clearance|__cf_bm|turnstile",
        "captcha": r"captcha|hcaptcha|recaptcha",
        "otp": r"otp|one[-_ ]time|verification code|mfa",
    }
    for name, raw_pattern in patterns.items():
        if re.search(raw_pattern, combined):
            signals.append(name)
    return signals


def unsupported_reason(signals: list[str]) -> str | None:
    if not signals:
        return None
    return f"manual gate required due to: {', '.join(signals)}"
