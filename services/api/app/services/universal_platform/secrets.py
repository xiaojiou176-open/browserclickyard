from __future__ import annotations

import re
from typing import Any, Callable


def redact_payload(payload: dict[str, Any], redact_text_fn: Callable[[str], str]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in payload.items():
        lowered = key.lower()
        if any(
            word in lowered
            for word in ("otp", "code", "token", "key", "password", "secret", "card")
        ):
            redacted[key] = "***"
            continue
        if isinstance(value, dict):
            redacted[key] = redact_payload(value, redact_text_fn)
        elif isinstance(value, str):
            redacted[key] = redact_text_fn(value)
        else:
            redacted[key] = value
    return redacted


def redact_text(value: str, sensitive_log_patterns: tuple[re.Pattern[str], ...]) -> str:
    redacted = value
    for idx, pattern in enumerate(sensitive_log_patterns):
        if idx == 0:
            redacted = pattern.sub(r"\1***", redacted)
        else:
            redacted = pattern.sub("***", redacted)
    return redacted
