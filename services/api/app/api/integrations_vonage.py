from __future__ import annotations

from app.core.settings import env_bool, env_str

import hashlib
import hmac
import time
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, status

from app.core.access_control import require_rate_limit
from app.services.vonage_inbox import vonage_inbox_service

router = APIRouter(prefix="/api/integrations/vonage", tags=["integrations"])


class InboundAuthError(HTTPException):
    def __init__(
        self, *, detail: str, audit_reason: str, status_code: int = status.HTTP_401_UNAUTHORIZED
    ) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.audit_reason = audit_reason


def _resolve_inbound_token(request: Request, query_token: str | None) -> str | None:
    primary_header_token = (
        request.headers.get("x-vonage-inbound-token") or ""
    ).strip()  # pragma: no mutate
    if primary_header_token:
        return primary_header_token

    if env_bool("VONAGE_INBOUND_TOKEN_HEADER_ENABLED", False):
        fallback_header_token = (request.headers.get("x-vonage-token") or "").strip()
        if not fallback_header_token:
            # ASGI normalizes header names to lowercase bytes, so this exact
            # lookup keeps behavior deterministic for mutation testing.
            raw_headers = getattr(request.headers, "raw", None)
            if raw_headers is not None:
                for raw_name, raw_value in raw_headers:
                    if raw_name == b"x-inbound-token":
                        fallback_header_token = raw_value.decode(
                            "latin-1"  # pragma: no mutate - codec alias case changes are behaviorally equivalent
                        ).strip()  # pragma: no mutate
                        break
        if fallback_header_token:
            return fallback_header_token

    fallback = (query_token or "").strip()
    if not fallback:
        return None
    raise InboundAuthError(
        detail="query token is no longer supported; use x-vonage-inbound-token header",
        audit_reason="auth_query_token_disabled",
    )


def _check_inbound_token(token: str | None) -> None:
    expected_token = env_str("VONAGE_INBOUND_TOKEN").strip()
    if not expected_token:
        raise InboundAuthError(
            detail="vonage inbound token is not configured",
            audit_reason="auth_token_not_configured",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    provided = (token or "").strip()
    if not hmac.compare_digest(provided, expected_token):
        raise InboundAuthError(
            detail="invalid inbound token",
            audit_reason="auth_token_invalid",
        )


def _load_signature_secret() -> str:
    signature_secret = env_str("VONAGE_SIGNATURE_SECRET").strip()
    if not signature_secret:
        raise InboundAuthError(
            detail="vonage signature secret is not configured",
            audit_reason="auth_signature_secret_missing",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return signature_secret


def _build_signature_payload(payload: dict[str, Any]) -> str:
    sanitized: dict[str, str] = {}
    for key, value in payload.items():
        if key == "sig" or value is None:
            continue
        sanitized[str(key)] = str(value).replace("&", "_").replace("=", "_")
    return "&".join(f"{key}={sanitized[key]}" for key in sorted(sanitized))


def _verify_signature(payload: dict[str, Any], secret: str) -> bool:
    provided = str(payload.get("sig") or "").strip().lower()
    if not provided:
        return False

    ts_raw = str(payload.get("timestamp") or "").strip()
    if not ts_raw:
        return False
    try:
        ts = int(ts_raw)
        skew = int(env_str("VONAGE_SIGNATURE_MAX_SKEW_SECONDS", "600"))
        if abs(int(time.time()) - ts) > max(60, skew):
            return False
    except ValueError:
        return False

    data = _build_signature_payload(payload)
    algo = env_str("VONAGE_SIGNATURE_ALGO", "sha256").strip().lower()
    if algo != "sha256":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported Vonage signature algorithm: {algo}; expected sha256",
        )
    expected = hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected.lower())


def _normalize_payload(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in request.query_params.items():
        payload[key] = value
    payload.update(body)
    return payload


@router.get("/inbound-sms")
async def inbound_sms_get(
    request: Request,
    token: str | None = Query(default=None),
) -> dict[str, Any]:
    require_rate_limit(request)
    payload = _normalize_payload(request, {})
    try:
        resolved_token = _resolve_inbound_token(request, token)
        _check_inbound_token(resolved_token)
        signature_secret = _load_signature_secret()
    except InboundAuthError as exc:
        vonage_inbox_service.append_audit(
            status="rejected", reason=exc.audit_reason, payload=payload
        )
        raise
    if not _verify_signature(payload, signature_secret):
        vonage_inbox_service.append_audit(
            status="rejected", reason="signature_invalid", payload=payload
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid Vonage signature"
        )
    message = vonage_inbox_service.from_payload(payload)
    if not message.text:
        vonage_inbox_service.append_audit(status="rejected", reason="empty_text", payload=payload)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="empty text payload"
        )
    if message.message_id:
        ttl = int(env_str("VONAGE_MESSAGE_ID_TTL_SECONDS", "86400"))
        try:
            is_new = vonage_inbox_service.register_message_id(message.message_id, ttl_seconds=ttl)
        except RuntimeError:
            vonage_inbox_service.append_audit(
                status="rejected", reason="dedupe_backend_unavailable_strict", payload=payload
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OTP dedupe backend unavailable while OTP_DEDUPE_STRICT=true",
            ) from None
        if not is_new:
            reason = (
                "message_id_seen_degraded"
                if vonage_inbox_service.last_dedupe_mode == "degraded"
                else "message_id_seen"
            )
            vonage_inbox_service.append_audit(status="duplicate", reason=reason, payload=payload)
            return {
                "ok": True,
                "provider": "vonage",
                "duplicate": True,
                "message_id": message.message_id,
            }
    vonage_inbox_service.append_message(message)
    reason = (
        "stored_degraded"
        if message.message_id and vonage_inbox_service.last_dedupe_mode == "degraded"
        else "stored"
    )
    vonage_inbox_service.append_audit(status="accepted", reason=reason, payload=payload)
    return {"ok": True, "provider": "vonage", "message_id": message.message_id}


@router.post("/inbound-sms")
async def inbound_sms_post(
    request: Request,
    token: str | None = Query(default=None),
    body: dict[str, Any] = Body(default_factory=dict),
) -> dict[str, Any]:
    require_rate_limit(request)
    payload = _normalize_payload(request, body)
    try:
        resolved_token = _resolve_inbound_token(request, token)
        _check_inbound_token(resolved_token)
        signature_secret = _load_signature_secret()
    except InboundAuthError as exc:
        vonage_inbox_service.append_audit(
            status="rejected", reason=exc.audit_reason, payload=payload
        )
        raise
    if not _verify_signature(payload, signature_secret):
        vonage_inbox_service.append_audit(
            status="rejected", reason="signature_invalid", payload=payload
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid Vonage signature"
        )
    message = vonage_inbox_service.from_payload(payload)
    if not message.text:
        vonage_inbox_service.append_audit(status="rejected", reason="empty_text", payload=payload)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="empty text payload"
        )
    if message.message_id:
        ttl = int(env_str("VONAGE_MESSAGE_ID_TTL_SECONDS", "86400"))
        try:
            is_new = vonage_inbox_service.register_message_id(message.message_id, ttl_seconds=ttl)
        except RuntimeError:
            vonage_inbox_service.append_audit(
                status="rejected", reason="dedupe_backend_unavailable_strict", payload=payload
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OTP dedupe backend unavailable while OTP_DEDUPE_STRICT=true",
            ) from None
        if not is_new:
            reason = (
                "message_id_seen_degraded"
                if vonage_inbox_service.last_dedupe_mode == "degraded"
                else "message_id_seen"
            )
            vonage_inbox_service.append_audit(status="duplicate", reason=reason, payload=payload)
            return {
                "ok": True,
                "provider": "vonage",
                "duplicate": True,
                "message_id": message.message_id,
            }
    vonage_inbox_service.append_message(message)
    reason = (
        "stored_degraded"
        if message.message_id and vonage_inbox_service.last_dedupe_mode == "degraded"
        else "stored"
    )
    vonage_inbox_service.append_audit(status="accepted", reason=reason, payload=payload)
    return {"ok": True, "provider": "vonage", "message_id": message.message_id}
