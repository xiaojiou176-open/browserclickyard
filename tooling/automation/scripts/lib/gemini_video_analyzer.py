#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import random
import sys
import time
from datetime import timedelta
from typing import Any

try:
    from google import genai
    from google.genai import types
except (
    ModuleNotFoundError
):  # pragma: no cover - optional runtime dependency for local validation paths
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]

DEFAULT_MODEL = "gemini-3.1-pro-preview"
FAST_MODEL = "gemini-3.0-flash"
ALLOWED_ACTIONS = {"navigate", "click", "type", "manual_gate"}
DEFAULT_THINKING_LEVEL = "high"
DEFAULT_TOOL_MODE = "auto"
DEFAULT_INCLUDE_THOUGHTS = True
DEFAULT_MEDIA_RESOLUTION = "high"
DEFAULT_CONTEXT_CACHE_MODE = "memory"
DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 3600
OUTPUT_FUNCTION_NAME = "emit_video_analysis"
DEFAULT_MODEL_RETRY_ATTEMPTS = 3
DEFAULT_MODEL_RETRY_BASE_DELAY_SECONDS = 0.6

if types is not None:
    THINKING_LEVEL_MAP: dict[str, Any] = {
        "minimal": types.ThinkingLevel.MINIMAL,
        "low": types.ThinkingLevel.LOW,
        "medium": types.ThinkingLevel.MEDIUM,
        "high": types.ThinkingLevel.HIGH,
    }
    FUNCTION_MODE_MAP: dict[str, Any] = {
        "none": types.FunctionCallingConfigMode.NONE,
        "auto": types.FunctionCallingConfigMode.AUTO,
        "any": types.FunctionCallingConfigMode.ANY,
        "validated": getattr(
            types.FunctionCallingConfigMode, "VALIDATED", types.FunctionCallingConfigMode.ANY
        ),
    }
else:
    THINKING_LEVEL_MAP = {}
    FUNCTION_MODE_MAP = {"none": "none", "auto": "auto", "any": "any", "validated": "any"}
CONTEXT_CACHE_MODE_SET = {"memory", "api"}

RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["detectedSignals", "candidateSteps"],
    "properties": {
        "detectedSignals": {
            "type": "array",
            "items": {"type": "string"},
            "default": [],
        },
        "candidateSteps": {
            "type": "array",
            "default": [],
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["step_id", "action", "confidence", "evidence_ref"],
                "properties": {
                    "step_id": {"type": "string", "minLength": 1},
                    "action": {"type": "string", "enum": sorted(ALLOWED_ACTIONS)},
                    "url": {"type": "string"},
                    "value_ref": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_ref": {"type": "string", "minLength": 1},
                    "unsupported_reason": {"type": "string"},
                    "target": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["selectors"],
                        "properties": {
                            "selectors": {
                                "type": "array",
                                "default": [],
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["kind", "value", "score"],
                                    "properties": {
                                        "kind": {"type": "string", "minLength": 1},
                                        "value": {"type": "string", "minLength": 1},
                                        "score": {"type": "number", "minimum": 0},
                                    },
                                },
                            }
                        },
                    },
                },
            },
        },
    },
}


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        raise ValueError("stdin payload is empty")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("stdin payload must be a JSON object")
    return parsed


def _parse_json_loose(text: str) -> dict[str, Any] | None:
    body = text.strip()
    if not body:
        return None
    try:
        parsed = json.loads(body)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    start = body.find("{")
    end = body.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(body[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def _parse_bool_flag(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return fallback


def _parse_thinking_level(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in THINKING_LEVEL_MAP else DEFAULT_THINKING_LEVEL


def _parse_tool_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in FUNCTION_MODE_MAP else DEFAULT_TOOL_MODE


def _parse_media_resolution(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in {"low", "medium", "high"} else DEFAULT_MEDIA_RESOLUTION


def _parse_context_cache_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in CONTEXT_CACHE_MODE_SET else DEFAULT_CONTEXT_CACHE_MODE


def _parse_context_cache_ttl_seconds(value: Any, fallback: int) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return max(0, fallback)
    return max(0, parsed)


def _parse_positive_int(value: Any, fallback: int, *, minimum: int = 1, maximum: int = 10) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def _resolve_model_name(payload: dict[str, Any]) -> str:
    explicit_model = str(payload.get("modelName") or os.getenv("GEMINI_MODEL") or "").strip()
    if explicit_model:
        return explicit_model
    quality_profile = str(payload.get("qualityProfile") or "").strip().lower()
    if quality_profile == "fast":
        return FAST_MODEL
    return DEFAULT_MODEL


def _extract_response_text(response: Any) -> str:
    direct_text = getattr(response, "text", None)
    if isinstance(direct_text, str) and direct_text.strip():
        return direct_text

    chunks: list[str] = []
    candidates = getattr(response, "candidates", None)
    if not isinstance(candidates, list):
        return ""
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text:
                chunks.append(text)
    return "\n".join(chunks)


def _extract_function_call_payload(response: Any, function_name: str) -> dict[str, Any] | None:
    candidates = getattr(response, "candidates", None)
    if not isinstance(candidates, list):
        return None

    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            function_call = getattr(part, "function_call", None)
            if not function_call:
                continue
            if str(getattr(function_call, "name", "")).strip() != function_name:
                continue
            args = getattr(function_call, "args", None)
            if isinstance(args, dict):
                return args
            if isinstance(args, str):
                parsed = _parse_json_loose(args)
                if parsed:
                    return parsed
    return None


def _normalize_selectors(raw_selectors: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_selectors, list):
        return []
    selectors: list[dict[str, Any]] = []
    for item in raw_selectors:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if not isinstance(value, str) or not value.strip():
            continue
        normalized: dict[str, Any] = {
            "kind": str(item.get("kind") or "css"),
            "value": value.strip(),
            "score": float(item.get("score") or 70),
        }
        selectors.append(normalized)
    return selectors


def _normalize_confidence(value: Any, fallback: float = 0.75) -> float:
    try:
        fallback_value = float(fallback)
    except (TypeError, ValueError):
        fallback_value = 0.75
    if not math.isfinite(fallback_value):
        fallback_value = 0.75
    fallback_normalized = max(0.0, min(1.0, fallback_value))

    if value is None:
        return fallback_normalized
    raw_value: Any = value
    if isinstance(raw_value, str):
        normalized_text = raw_value.strip().lower()
        if not normalized_text or normalized_text in {"null", "none", "nan", "n/a"}:
            return fallback_normalized
        raw_value = raw_value.strip()

    try:
        parsed = float(raw_value)
    except (TypeError, ValueError):
        return fallback_normalized
    if not math.isfinite(parsed):
        return fallback_normalized
    return max(0.0, min(1.0, parsed))


def _normalize_candidate_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list):
        return []
    normalized_steps: list[dict[str, Any]] = []
    for index, item in enumerate(raw_steps, start=1):
        if not isinstance(item, dict):
            continue
        action = str(item.get("action") or "").strip().lower()
        if action not in ALLOWED_ACTIONS:
            continue

        normalized: dict[str, Any] = {
            "step_id": str(item.get("step_id") or f"s{index}"),
            "action": action,
            "confidence": _normalize_confidence(item.get("confidence"), 0.75),
            "evidence_ref": str(item.get("evidence_ref") or "llm:gemini-video"),
        }

        url = item.get("url")
        if isinstance(url, str) and url:
            normalized["url"] = url
        value_ref = item.get("value_ref")
        if isinstance(value_ref, str) and value_ref:
            normalized["value_ref"] = value_ref
        unsupported_reason = item.get("unsupported_reason")
        if isinstance(unsupported_reason, str) and unsupported_reason:
            normalized["unsupported_reason"] = unsupported_reason

        target = item.get("target")
        selectors = _normalize_selectors(
            target.get("selectors") if isinstance(target, dict) else None
        )
        if selectors:
            normalized["target"] = {"selectors": selectors}
        normalized_steps.append(normalized)
    return normalized_steps


def _build_prompt(context_payload: dict[str, Any]) -> str:
    prompt_payload = dict(context_payload)
    prompt_payload.pop("parts", None)
    return "\n".join(
        [
            "You are an automation reconstruction engine.",
            "Return strict JSON only. No markdown.",
            'Schema: {"detectedSignals": string[], "candidateSteps": CandidateStep[]}',
            "CandidateStep.action must be one of navigate|click|type|manual_gate.",
            "CandidateStep.target.selectors uses [{kind,value,score}] when present.",
            "Prefer stable selectors and keep likely user action order.",
            json.dumps(prompt_payload, ensure_ascii=False),
        ]
    )


def _build_context_cache_key(
    *,
    context_payload: dict[str, Any],
    model_name: str,
    thinking_level: str,
    tool_mode: str,
    media_resolution: str,
) -> str:
    fingerprint = {
        "context_payload": context_payload,
        "model_name": model_name,
        "thinking_level": thinking_level,
        "tool_mode": tool_mode,
        "media_resolution": media_resolution,
    }
    serialized = json.dumps(fingerprint, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _supports_config_field(field_name: str) -> bool:
    model_fields = getattr(types.GenerateContentConfig, "model_fields", None)
    if isinstance(model_fields, dict):
        return field_name in model_fields
    legacy_fields = getattr(types.GenerateContentConfig, "__fields__", None)
    return isinstance(legacy_fields, dict) and field_name in legacy_fields


def _build_context_cache_meta(
    *,
    mode: str,
    hit: bool,
    key: str,
    ttl_seconds: int,
    fallback: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "mode": mode,
        "hit": hit,
        "key": key,
        "ttl_seconds": ttl_seconds,
        "fallback": fallback,
    }


def _try_attach_api_context_cache(
    *,
    client: genai.Client,
    model_name: str,
    contents: Any,
    config_kwargs: dict[str, Any],
    cache_ttl_seconds: int,
) -> str | None:
    caches = getattr(client, "caches", None)
    create_cached_config = getattr(types, "CreateCachedContentConfig", None)
    if not caches or not callable(getattr(caches, "create", None)) or create_cached_config is None:
        return "gemini cache API unavailable in installed SDK"
    if not _supports_config_field("cached_content"):
        return "GenerateContentConfig.cached_content unsupported by installed SDK"
    if cache_ttl_seconds <= 0:
        return "cache TTL disabled (<=0)"
    try:
        cache = caches.create(
            model=model_name,
            config=create_cached_config(
                contents=contents,
                ttl=timedelta(seconds=cache_ttl_seconds),
                display_name="uiq-video-analysis",
            ),
        )
    except Exception as exc:  # pragma: no cover - SDK/network dependent
        return f"cache create failed: {exc}"
    cache_name = getattr(cache, "name", None)
    if not isinstance(cache_name, str) or not cache_name.strip():
        return "cache create returned empty cache name"
    config_kwargs["cached_content"] = cache_name
    return None


def _coerce_media_resolution(value: str) -> Any:
    enum_cls = getattr(types, "MediaResolution", None)
    if not enum_cls:
        return value
    member = getattr(enum_cls, str(value or "").upper(), None)
    return member if member is not None else value


def _extract_part_field(part: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in part:
            return part[key]
    return None


def _safe_part_from_text(text: str) -> Any:
    part_from_text = getattr(types.Part, "from_text", None)
    if callable(part_from_text):
        return part_from_text(text=text)
    return {"text": text}


def _safe_part_with_media_resolution(part: Any, media_resolution: str | None) -> Any:
    if not media_resolution:
        return part
    coerced = _coerce_media_resolution(media_resolution)
    if isinstance(coerced, str):
        return part
    if isinstance(part, dict):
        part["media_resolution"] = coerced
        return part
    if hasattr(part, "media_resolution"):
        try:
            setattr(part, "media_resolution", coerced)
            return part
        except Exception:
            return part
    return part


def _normalize_multimodal_part(
    raw_part: Any,
    index: int,
    default_media_resolution: str,
) -> tuple[Any, str | None]:
    if not isinstance(raw_part, dict):
        return (_safe_part_from_text(f"[unsupported part #{index}]"), None)

    part_type = (
        str(_extract_part_field(raw_part, "type", "kind", "partType") or "text").strip().lower()
    )
    media_resolution = _parse_media_resolution(
        _extract_part_field(raw_part, "media_resolution", "mediaResolution", "resolution")
        or default_media_resolution
    )

    if part_type == "text":
        text = _extract_part_field(raw_part, "text", "value")
        if isinstance(text, str) and text.strip():
            return (_safe_part_from_text(text), media_resolution)
        return (_safe_part_from_text(f"[empty text part #{index}]"), media_resolution)

    if part_type in {"image", "video", "pdf", "file", "file_uri", "uri"}:
        file_uri = _extract_part_field(raw_part, "file_uri", "fileUri", "uri", "url")
        mime_type = _extract_part_field(raw_part, "mime_type", "mimeType", "contentType")
        part_from_uri = getattr(types.Part, "from_uri", None)
        if callable(part_from_uri) and isinstance(file_uri, str) and file_uri.strip():
            try:
                built = part_from_uri(
                    file_uri=file_uri, mime_type=str(mime_type or "application/octet-stream")
                )
                return (_safe_part_with_media_resolution(built, media_resolution), media_resolution)
            except Exception:
                pass
        summary = f"[{part_type} part #{index}] uri={file_uri or ''} mime={mime_type or ''}".strip()
        return (_safe_part_from_text(summary), media_resolution)

    if part_type in {"inline_data", "inline", "bytes"}:
        data_base64 = _extract_part_field(raw_part, "data_base64", "dataBase64", "base64")
        mime_type = str(
            _extract_part_field(raw_part, "mime_type", "mimeType", "contentType")
            or "application/octet-stream"
        )
        part_from_bytes = getattr(types.Part, "from_bytes", None)
        if callable(part_from_bytes) and isinstance(data_base64, str) and data_base64.strip():
            try:
                decoded = base64.b64decode(data_base64.encode("utf-8"))
                built = part_from_bytes(data=decoded, mime_type=mime_type)
                return (_safe_part_with_media_resolution(built, media_resolution), media_resolution)
            except Exception:
                pass
        return (
            _safe_part_from_text(f"[inline_data part #{index}] mime={mime_type}"),
            media_resolution,
        )

    return (_safe_part_from_text(f"[unsupported part type {part_type} #{index}]"), media_resolution)


def _build_contents(
    context_payload: dict[str, Any],
    default_media_resolution: str,
) -> tuple[Any, dict[str, Any]]:
    prompt = _build_prompt(context_payload)
    raw_parts = context_payload.get("parts")
    if not isinstance(raw_parts, list) or not raw_parts:
        return (
            prompt,
            {
                "default": default_media_resolution,
                "perPart": {},
            },
        )

    parts: list[Any] = [_safe_part_from_text(prompt)]
    per_part: dict[str, str] = {}
    for index, raw_part in enumerate(raw_parts, start=1):
        normalized_part, media_resolution = _normalize_multimodal_part(
            raw_part, index, default_media_resolution
        )
        parts.append(normalized_part)
        part_key = f"part_{index}"
        per_part[part_key] = media_resolution or default_media_resolution
    return (
        parts,
        {
            "default": default_media_resolution,
            "perPart": per_part,
        },
    )


def _extract_thought_summary(response: Any) -> str:
    candidates = getattr(response, "candidates", None)
    if not isinstance(candidates, list):
        return ""
    thought_chunks: list[str] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            is_thought = bool(getattr(part, "thought", False)) or bool(
                getattr(part, "thought_signature", None)
            )
            if not is_thought:
                continue
            text = getattr(part, "text", None)
            if isinstance(text, str) and text.strip():
                thought_chunks.append(text.strip())
    return " ".join(thought_chunks).strip()


def _extract_thought_signatures(response: Any) -> list[str]:
    candidates = getattr(response, "candidates", None)
    if not isinstance(candidates, list):
        return []
    signatures: list[str] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            raw_signature = getattr(part, "thought_signature", None)
            if isinstance(raw_signature, str) and raw_signature.strip():
                signatures.append(raw_signature.strip())
    # Preserve order while deduplicating.
    deduped = list(dict.fromkeys(signatures))
    return deduped


def _build_tooling_config(tool_mode: str) -> dict[str, Any]:
    if tool_mode == "none":
        return {}

    declaration = types.FunctionDeclaration(
        name=OUTPUT_FUNCTION_NAME,
        description="Emit extracted UI automation signals and candidate interaction steps as JSON.",
        parameters_json_schema=RESPONSE_JSON_SCHEMA,
    )
    config = types.FunctionCallingConfig(
        mode=FUNCTION_MODE_MAP[tool_mode],
        allowed_function_names=[OUTPUT_FUNCTION_NAME],
    )
    return {
        "tools": [types.Tool(function_declarations=[declaration])],
        "tool_config": types.ToolConfig(function_calling_config=config),
    }


def _ensure_google_genai_available() -> None:
    if genai is None or types is None:
        raise RuntimeError("google-genai SDK is required for Gemini analysis execution")


def _analyze(
    context_payload: dict[str, Any],
    model_name: str,
    api_key: str,
    thinking_level: str,
    include_thoughts: bool,
    tool_mode: str,
    media_resolution: str,
    context_cache_mode: str,
    context_cache_ttl_seconds: int,
    model_retry_attempts: int,
) -> dict[str, Any]:
    _ensure_google_genai_available()
    client = genai.Client(api_key=api_key)
    cache_key = _build_context_cache_key(
        context_payload=context_payload,
        model_name=model_name,
        thinking_level=thinking_level,
        tool_mode=tool_mode,
        media_resolution=media_resolution,
    )
    config_kwargs: dict[str, Any] = {
        "response_mime_type": "application/json",
        "response_json_schema": RESPONSE_JSON_SCHEMA,
        "temperature": 0.1,
        "thinking_config": types.ThinkingConfig(
            thinking_level=THINKING_LEVEL_MAP[thinking_level],
            include_thoughts=include_thoughts,
        ),
    }
    config_kwargs.update(_build_tooling_config(tool_mode))

    contents, media_resolution_applied = _build_contents(context_payload, media_resolution)
    context_cache_meta = _build_context_cache_meta(
        mode="memory",
        hit=False,
        key=cache_key,
        ttl_seconds=context_cache_ttl_seconds,
        fallback=None,
    )
    if context_cache_mode == "api":
        fallback_reason = _try_attach_api_context_cache(
            client=client,
            model_name=model_name,
            contents=contents,
            config_kwargs=config_kwargs,
            cache_ttl_seconds=context_cache_ttl_seconds,
        )
        if fallback_reason is None:
            context_cache_meta = _build_context_cache_meta(
                mode="api",
                hit=False,
                key=cache_key,
                ttl_seconds=context_cache_ttl_seconds,
                fallback=None,
            )
        else:
            context_cache_meta = _build_context_cache_meta(
                mode="memory",
                hit=False,
                key=cache_key,
                ttl_seconds=context_cache_ttl_seconds,
                fallback={"from": "api", "to": "memory", "reason": fallback_reason},
            )
    response: Any | None = None
    last_error: Exception | None = None
    for attempt in range(1, model_retry_attempts + 1):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=types.GenerateContentConfig(**config_kwargs),
            )
            break
        except Exception as exc:  # pragma: no cover - SDK/network dependent
            last_error = exc
            if attempt >= model_retry_attempts:
                raise
            base_delay = DEFAULT_MODEL_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
            jitter = random.uniform(0.0, base_delay / 3)
            time.sleep(base_delay + jitter)
    if response is None and last_error is not None:
        raise RuntimeError(f"gemini generate_content failed after retries: {last_error}")

    response_json = (
        _extract_function_call_payload(response, OUTPUT_FUNCTION_NAME)
        or _parse_json_loose(_extract_response_text(response))
        or {}
    )
    detected_signals_raw = response_json.get("detectedSignals")
    detected_signals = (
        [str(item) for item in detected_signals_raw if isinstance(item, (str, int, float))]
        if isinstance(detected_signals_raw, list)
        else []
    )
    candidate_steps = _normalize_candidate_steps(response_json.get("candidateSteps"))
    thought_summary = _extract_thought_summary(response)
    thought_signatures = _extract_thought_signatures(response)
    thought_signature_status = "disabled"
    if include_thoughts:
        thought_signature_status = "present" if thought_signatures else "missing"
    return {
        "detectedSignals": detected_signals,
        "candidateSteps": candidate_steps,
        "modelName": model_name,
        "thinkingLevel": thinking_level,
        "includeThoughts": include_thoughts,
        "toolMode": tool_mode,
        "analysis_meta": {
            "modelName": model_name,
            "thinking": thinking_level,
            "toolMode": tool_mode,
            "mediaResolutionApplied": media_resolution_applied,
            "thoughtSummaryPresent": bool(thought_summary),
            "thoughtSummary": thought_summary or None,
            "thoughtSignatureStatus": thought_signature_status,
            "thoughtSignatureCount": len(thought_signatures),
            "thoughtSignatures": thought_signatures,
            "contextCache": context_cache_meta,
            "retryAttempts": model_retry_attempts,
        },
    }


def _run_confidence_self_check() -> int:
    cases: list[tuple[Any, float]] = [
        ("x", 0.75),
        (None, 0.75),
        ("null", 0.75),
        (2, 1.0),
        (-1, 0.0),
    ]
    results: list[dict[str, Any]] = []
    failed = False
    for raw, expected in cases:
        actual = _normalize_confidence(raw, 0.75)
        ok = abs(actual - expected) < 1e-9
        failed = failed or (not ok)
        results.append(
            {
                "input": raw,
                "expected": expected,
                "actual": actual,
                "ok": ok,
            }
        )
    sys.stdout.write(f"{json.dumps({'cases': results}, ensure_ascii=False)}\n")
    return 1 if failed else 0


def main() -> int:
    payload = _read_payload()
    context_payload = payload.get("contextPayload")
    if not isinstance(context_payload, dict):
        raise ValueError("contextPayload must be a JSON object")

    model_name = _resolve_model_name(payload)
    thinking_level = _parse_thinking_level(
        payload.get("thinkingLevel") or os.getenv("GEMINI_THINKING_LEVEL")
    )
    include_thoughts = _parse_bool_flag(
        payload.get("includeThoughts"),
        _parse_bool_flag(os.getenv("GEMINI_INCLUDE_THOUGHTS"), DEFAULT_INCLUDE_THOUGHTS),
    )
    tool_mode = _parse_tool_mode(payload.get("toolMode") or os.getenv("GEMINI_TOOL_MODE"))
    media_resolution = _parse_media_resolution(
        payload.get("mediaResolution")
        or os.getenv("GEMINI_MEDIA_RESOLUTION")
        or os.getenv("GEMINI_MEDIA_RESOLUTION_DEFAULT")
    )
    context_cache_mode = _parse_context_cache_mode(
        payload.get("contextCacheMode") or os.getenv("GEMINI_CONTEXT_CACHE_MODE")
    )
    context_cache_ttl_seconds = _parse_context_cache_ttl_seconds(
        payload.get("contextCacheTtlSeconds") or os.getenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS"),
        DEFAULT_CONTEXT_CACHE_TTL_SECONDS,
    )
    model_retry_attempts = _parse_positive_int(
        payload.get("modelRetryAttempts") or os.getenv("GEMINI_MODEL_RETRY_ATTEMPTS"),
        DEFAULT_MODEL_RETRY_ATTEMPTS,
    )
    api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("missing GEMINI_API_KEY")

    result = _analyze(
        context_payload,
        model_name,
        api_key,
        thinking_level,
        include_thoughts,
        tool_mode,
        media_resolution,
        context_cache_mode,
        context_cache_ttl_seconds,
        model_retry_attempts,
    )
    sys.stdout.write(f"{json.dumps(result, ensure_ascii=False)}\n")
    return 0


if __name__ == "__main__":
    try:
        if "--self-check-confidence" in sys.argv:
            raise SystemExit(_run_confidence_self_check())
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - defensive guard
        sys.stderr.write(f"gemini_video_analyzer failed: {exc}\n")
        raise SystemExit(1) from exc
