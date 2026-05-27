from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

_REPLAY_SLA_WINDOW_DAYS = 7
_MANUAL_GATE_REASON_CODES = ("cloudflare", "captcha", "otp", "csrf", "token", "unknown")
_MANUAL_GATE_REASON_PATTERNS: list[tuple[str, str]] = [
    ("cloudflare", r"cloudflare|cf_clearance|__cf_bm|turnstile"),
    ("captcha", r"captcha|hcaptcha|recaptcha"),
    ("otp", r"otp|one[-_ ]?time|verification code|mfa"),
    ("csrf", r"csrf|xsrf"),
    ("token", r"token|bearer|jwt"),
]


def detect_protection_signals(html_content: str, har_entries: list[dict[str, Any]]) -> list[str]:
    signals: list[str] = []
    combined = "\n".join(
        [
            html_content.lower(),
            "\n".join(str(item.get("url") or "").lower() for item in har_entries),
        ]
    )
    patterns = {
        "cloudflare": r"cloudflare|cf_clearance|__cf_bm|turnstile",
        "captcha": r"captcha|hcaptcha|recaptcha",
        "otp": r"otp|one[-_ ]time|verification code|mfa",
    }
    for name, pattern in patterns.items():
        if re.search(pattern, combined):
            signals.append(name)
    return signals


def unsupported_reason(signals: list[str]) -> str | None:
    if not signals:
        return None
    return f"manual gate required due to: {', '.join(signals)}"


def classify_manual_gate_reason(reason: str) -> list[str]:
    matched = [
        code
        for code, pattern in _MANUAL_GATE_REASON_PATTERNS
        if re.search(pattern, reason, flags=re.IGNORECASE)
    ]
    if matched:
        return matched
    return ["unknown"]


def build_manual_gate_report(
    steps: list[dict[str, Any]],
) -> tuple[list[str], dict[str, Any], dict[str, Any]]:
    counts = {code: 0 for code in _MANUAL_GATE_REASON_CODES}
    rows: list[dict[str, Any]] = []
    manual_gate_reasons: list[str] = []
    manual_steps = [
        step
        for step in steps
        if isinstance(step, dict) and str(step.get("action") or "") == "manual_gate"
    ]
    for step in manual_steps:
        raw_reason = str(step.get("unsupported_reason") or "").strip()
        reason = raw_reason or "missing unsupported_reason"
        reason_codes = classify_manual_gate_reason(reason)
        if raw_reason:
            manual_gate_reasons.append(raw_reason)
        for code in reason_codes:
            counts[code] += 1
        rows.append(
            {
                "step_id": str(step.get("step_id") or ""),
                "reason": reason,
                "reason_codes": reason_codes,
            }
        )

    total_reason_code_hits = sum(len(item["reason_codes"]) for item in rows)
    known_reason_code_hits = total_reason_code_hits - counts["unknown"]
    dominant_reason_code = None
    for code in sorted(_MANUAL_GATE_REASON_CODES, key=lambda item: counts[item], reverse=True):
        if counts[code] > 0:
            dominant_reason_code = code
            break

    reason_matrix = {
        "reason_codes": list(_MANUAL_GATE_REASON_CODES),
        "by_step": rows,
        "counts": counts,
    }
    stats_panel = {
        "total_manual_gate_steps": len(manual_steps),
        "total_reason_code_hits": total_reason_code_hits,
        "known_reason_code_hits": known_reason_code_hits,
        "unknown_reason_code_hits": counts["unknown"],
        "dominant_reason_code": dominant_reason_code,
        "reason_code_breakdown": [
            {
                "code": code,
                "count": counts[code],
                "ratio": round(counts[code] / total_reason_code_hits, 4)
                if total_reason_code_hits > 0
                else 0,
            }
            for code in _MANUAL_GATE_REASON_CODES
        ],
    }
    return manual_gate_reasons, reason_matrix, stats_panel


def parse_replay_attempt(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    attempted = bool(payload.get("attempted", False))
    raw_success = payload.get("success")
    success = raw_success if isinstance(raw_success, bool) else None
    status_value = str(payload.get("status") or "").strip()
    if not status_value:
        if attempted:
            if success is True:
                status_value = "success"
            elif success is False:
                status_value = "failed"
            else:
                status_value = "unknown"
        else:
            status_value = "not_attempted"
    return {
        "attempted": attempted,
        "success": success,
        "status": status_value,
    }


def compute_replay_sla(
    generated_dir: Path, now: datetime, current_readiness_path: Path
) -> dict[str, Any]:
    window_start = now - timedelta(days=_REPLAY_SLA_WINDOW_DAYS)
    sample_count = 0
    success_count = 0
    for candidate in generated_dir.rglob("run-readiness-report.json"):
        if candidate.resolve() == current_readiness_path.resolve():
            continue
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        generated_at_raw = payload.get("generated_at", payload.get("generatedAt"))
        if not isinstance(generated_at_raw, str):
            continue
        try:
            generated_at = datetime.fromisoformat(generated_at_raw)
        except ValueError:
            continue
        if generated_at.tzinfo is None:
            generated_at = generated_at.replace(tzinfo=UTC)
        else:
            generated_at = generated_at.astimezone(UTC)
        if generated_at < window_start or generated_at > now:
            continue
        replay_attempt = parse_replay_attempt(
            payload.get("replay_attempt", payload.get("replayAttempt"))
        )
        if (
            not replay_attempt
            or not replay_attempt["attempted"]
            or not isinstance(replay_attempt["success"], bool)
        ):
            continue
        sample_count += 1
        if replay_attempt["success"]:
            success_count += 1

    return {
        "window_days": _REPLAY_SLA_WINDOW_DAYS,
        "replay_success_rate_7d": round(success_count / sample_count, 4)
        if sample_count > 0
        else None,
        "replay_success_samples_7d": sample_count,
        "replay_successes_7d": success_count,
        "evaluated_at": now.isoformat(),
    }
