from __future__ import annotations

import copy
import json
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    from google import genai as _genai
    from google.genai import types as _genai_types
except Exception:  # pragma: no cover - optional dependency in some runtime environments.
    _genai = None  # type: ignore[assignment]
    _genai_types = None  # type: ignore[assignment]


@dataclass
class GeminiExtractionInput:
    start_url: str
    har_entries: list[dict[str, Any]]
    html_content: str
    extractor_strategy: str
    event_summary_text: str = ""


class GeminiAdapter:
    engine_name = "gemini"
    _DEFAULT_MODEL = "models/gemini-3.1-pro-preview"
    _DEFAULT_THINKING_LEVEL = "high"
    _DEFAULT_INCLUDE_THOUGHTS = True
    _RESPONSE_SCHEMA: dict[str, Any] = {
        "type": "object",
        "required": ["steps"],
        "properties": {
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["action", "confidence", "evidence_ref"],
                    "properties": {
                        "action": {"type": "string"},
                        "url": {"type": "string"},
                        "value_ref": {"type": "string"},
                        "target": {"type": "object"},
                        "selected_selector_index": {"type": "number"},
                        "preconditions": {"type": "array"},
                        "evidence_ref": {"type": "string"},
                        "confidence": {"type": "number"},
                        "manual_handoff_required": {"type": "boolean"},
                        "unsupported_reason": {"type": "string"},
                    },
                    "additionalProperties": True,
                },
            }
        },
        "additionalProperties": True,
    }
    _MANUAL_GATE_CONFIDENCE = 0.8
    _FAILURE_MISSING_KEY = "ai.gemini.missing_api_key"
    _FAILURE_SDK_UNAVAILABLE = "ai.gemini.sdk_unavailable"
    _FAILURE_REQUEST_FAILED = "ai.gemini.request_failed"
    _FAILURE_INVALID_RESPONSE = "ai.gemini.invalid_response"
    _FAILURE_INVALID_ACTION_SCHEMA = "ai.gemini.invalid_action_schema"
    _FAILURE_MISSING_REGISTER = "ai.gemini.missing_register_entry"
    _FAILURE_MODEL_MANUAL_GATE = "ai.gemini.model_manual_gate"
    _ACTION_SCHEMA_PATH = (
        Path(__file__).resolve().parents[5]
        / "packages"
        / "core"
        / "src"
        / "ai"
        / "action-schema.json"
    )
    _allowed_actions_cache: frozenset[str] | None = None

    def __init__(self) -> None:
        self._client: Any | None = None
        self._context_cache: dict[str, dict[str, Any]] = {}

    def extract_steps(self, payload: GeminiExtractionInput) -> list[dict[str, Any]]:
        steps, _meta = self._extract_steps_main(payload)
        return steps

    def _try_extract_steps_strong(
        self,
        payload: GeminiExtractionInput,
    ) -> tuple[list[dict[str, Any]] | None, str | None]:
        return self._extract_steps_with_sdk(payload)

    def _parse_strong_response(self, response: Any, start_url: str) -> dict[str, Any]:
        function_calls = getattr(response, "function_calls", None)
        if isinstance(function_calls, list):
            for call in function_calls:
                name = str(getattr(call, "name", "") or "").strip()
                if name != "emit_reconstruction_steps":
                    continue
                parsed_args = getattr(call, "args", None)
                if isinstance(parsed_args, str):
                    parsed_args = self._try_parse_json(parsed_args)
                if isinstance(parsed_args, dict):
                    raw_steps = parsed_args.get("steps")
                    if isinstance(raw_steps, list):
                        normalized: list[dict[str, Any]] = []
                        for raw_step in raw_steps:
                            parsed_step = self._normalize_model_step(raw_step)
                            if isinstance(parsed_step, dict):
                                normalized.append(parsed_step)
                        if normalized:
                            return {
                                "path": "function_call",
                                "parser": "function_args",
                                "steps": self._ensure_navigate_step(normalized, start_url),
                            }
        parsed_from_text, invalid_schema = self._parse_response_steps(response, start_url)
        if parsed_from_text and not invalid_schema:
            return {
                "path": "text_json_fallback",
                "parser": "response_text",
                "steps": parsed_from_text,
            }
        return {"path": "none", "parser": "none", "steps": []}

    def _extract_steps_main(
        self,
        payload: GeminiExtractionInput,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        strong_steps, failure_code = self._try_extract_steps_strong(payload)
        if strong_steps:
            return (
                strong_steps,
                {
                    "strategy": "strong",
                    "strong_mode": {"path": "sdk", "outcome": "success"},
                },
            )
        fallback_steps = self._extract_steps_heuristic(payload)
        if failure_code:
            fallback_steps = self._attach_failure_reason(fallback_steps, failure_code)
        return (
            fallback_steps,
            {
                "strategy": "heuristic",
                "fallback": {
                    "from": "strong",
                    "to": "heuristic",
                    "reason": failure_code or "strong_unavailable",
                },
                "strong_mode": {"path": "none", "outcome": "fallback", "reason": failure_code},
            },
        )

    def extract_steps_with_context_cache(
        self,
        payload: GeminiExtractionInput,
        *,
        cache_key: str,
        ttl_seconds: int,
        media_resolution_by_input: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        _ = media_resolution_by_input
        now = datetime.now(UTC)
        cached = self._context_cache.get(cache_key)
        if isinstance(cached, dict):
            expires_at = cached.get("expires_at")
            if isinstance(expires_at, datetime) and expires_at > now:
                return {
                    "steps": copy.deepcopy(cached.get("steps", [])),
                    "status": "api_hit",
                    "hit": True,
                    "fallback": None,
                    "meta": copy.deepcopy(cached.get("meta", {})),
                    "reason": None,
                }
        steps, meta = self._extract_steps_main(payload)
        expires_at = now + timedelta(seconds=max(1, int(ttl_seconds)))
        self._context_cache[cache_key] = {
            "steps": copy.deepcopy(steps),
            "meta": copy.deepcopy(meta),
            "expires_at": expires_at,
        }
        return {
            "steps": copy.deepcopy(steps),
            "status": "api_miss",
            "hit": False,
            "fallback": meta.get("fallback"),
            "meta": meta,
            "reason": meta.get("strong_mode", {}).get("reason"),
        }

    def _extract_steps_with_sdk(
        self,
        payload: GeminiExtractionInput,
    ) -> tuple[list[dict[str, Any]] | None, str | None]:
        api_key = self._resolve_api_key()
        if not api_key:
            return None, self._FAILURE_MISSING_KEY
        if _genai is None:
            return None, self._FAILURE_SDK_UNAVAILABLE
        model = self._resolve_model()
        prompt = self._build_prompt(payload)
        config = self._build_generate_config()
        if self._client is None:
            self._client = _genai.Client(api_key=api_key)
        try:
            response = self._client.models.generate_content(
                model=model,
                contents=[prompt],
                config=config,
            )
        except Exception:
            return None, self._FAILURE_REQUEST_FAILED
        parsed_steps, invalid_action_schema = self._parse_response_steps(
            response, payload.start_url
        )
        if invalid_action_schema:
            return None, self._FAILURE_INVALID_ACTION_SCHEMA
        if not parsed_steps:
            return None, self._FAILURE_INVALID_RESPONSE
        return parsed_steps, None

    def _extract_steps_heuristic(self, payload: GeminiExtractionInput) -> list[dict[str, Any]]:
        steps: list[dict[str, Any]] = [
            {
                "action": "navigate",
                "url": payload.start_url,
                "confidence": 0.95,
                "source_engine": self.engine_name,
                "evidence_ref": "video:entry",
            }
        ]
        register_entry = self._find_register_entry(payload.har_entries)
        if register_entry is None:
            steps.append(
                {
                    "action": "manual_gate",
                    "confidence": self._MANUAL_GATE_CONFIDENCE,
                    "source_engine": self.engine_name,
                    "evidence_ref": "har:missing-register",
                    "manual_handoff_required": True,
                    "unsupported_reason": self._FAILURE_MISSING_REGISTER,
                    "reason_code": self._FAILURE_MISSING_REGISTER,
                }
            )
            return steps

        register_path = urlparse(str(register_entry.get("url") or "")).path
        steps.extend(
            [
                {
                    "action": "type",
                    "value_ref": "${params.email}",
                    "confidence": 0.9,
                    "source_engine": self.engine_name,
                    "evidence_ref": f"har:{register_path}:email",
                },
                {
                    "action": "type",
                    "value_ref": "${secrets.password}",
                    "confidence": 0.9,
                    "source_engine": self.engine_name,
                    "evidence_ref": f"har:{register_path}:password",
                },
                {
                    "action": "click",
                    "confidence": 0.85,
                    "source_engine": self.engine_name,
                    "evidence_ref": f"har:{register_path}:submit",
                },
                {
                    "action": "assert",
                    "value_ref": "${assert.register_success}",
                    "confidence": 0.82,
                    "source_engine": self.engine_name,
                    "evidence_ref": f"har:{register_path}:response",
                },
            ]
        )
        if payload.extractor_strategy == "aggressive":
            steps.append(
                {
                    "action": "extract",
                    "value_ref": "${extract.user_id}",
                    "confidence": 0.79,
                    "source_engine": self.engine_name,
                    "evidence_ref": f"har:{register_path}:extract-user-id",
                }
            )
        return steps

    def _resolve_api_key(self) -> str:
        return (os.getenv("RECON_GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip()

    def _resolve_model(self) -> str:
        return (
            os.getenv("RECON_GEMINI_MODEL") or self._DEFAULT_MODEL
        ).strip() or self._DEFAULT_MODEL

    def _resolve_thinking_level(self) -> str:
        value = (
            (
                os.getenv("RECON_GEMINI_THINKING_LEVEL")
                or os.getenv("GEMINI_THINKING_LEVEL")
                or self._DEFAULT_THINKING_LEVEL
            )
            .strip()
            .lower()
        )
        if value not in {"minimal", "low", "medium", "high"}:
            return self._DEFAULT_THINKING_LEVEL
        return value

    def _resolve_include_thoughts(self) -> bool:
        raw = (
            (
                os.getenv("RECON_GEMINI_INCLUDE_THOUGHTS")
                or os.getenv("GEMINI_INCLUDE_THOUGHTS")
                or str(self._DEFAULT_INCLUDE_THOUGHTS)
            )
            .strip()
            .lower()
        )
        if raw in {"0", "false", "no", "off"}:
            return False
        return True

    def _build_generate_config(self) -> Any:
        system_instruction = (
            "You extract replayable browser-automation steps. "
            "Output valid JSON only and never include markdown."
        )
        thinking_level = self._resolve_thinking_level()
        include_thoughts = self._resolve_include_thoughts()
        if _genai_types is None:
            return {
                "system_instruction": system_instruction,
                "response_mime_type": "application/json",
                "response_schema": self._RESPONSE_SCHEMA,
                "temperature": 0.1,
                "thinking_config": {
                    "thinking_level": thinking_level,
                    "include_thoughts": include_thoughts,
                },
            }
        sdk_thinking_level = thinking_level
        thinking_level_type = getattr(_genai_types, "ThinkingLevel", None)
        if thinking_level_type is not None:
            sdk_thinking_level = getattr(
                thinking_level_type,
                thinking_level.upper(),
                getattr(thinking_level_type, "HIGH", thinking_level),
            )
        thinking_config_kwargs: dict[str, Any] = {}
        thinking_config_fields = getattr(_genai_types.ThinkingConfig, "model_fields", None)
        if not thinking_config_fields or "thinking_level" in thinking_config_fields:
            thinking_config_kwargs["thinking_level"] = sdk_thinking_level
        elif "thinking_budget" in thinking_config_fields:
            budget_by_level = {
                "minimal": 128,
                "low": 1024,
                "medium": 8192,
                "high": 24576,
            }
            thinking_config_kwargs["thinking_budget"] = budget_by_level.get(
                thinking_level, budget_by_level["high"]
            )
        return _genai_types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=self._RESPONSE_SCHEMA,
            temperature=0.1,
            thinking_config=_genai_types.ThinkingConfig(  # type: ignore[call-arg]
                include_thoughts=include_thoughts,
                **thinking_config_kwargs,
            ),
        )

    def _build_prompt(self, payload: GeminiExtractionInput) -> str:
        event_summary = payload.event_summary_text.strip() or self._summarize_events(
            payload.har_entries
        )
        har_summary = self._summarize_har(payload.har_entries)
        html_excerpt = payload.html_content[:8000]
        return (
            "Return a JSON object with key `steps`, where `steps` is an array of automation steps.\n"
            "Each step should keep compatibility with this shape:\n"
            "{action, url?, value_ref?, target?, selected_selector_index?, preconditions?, "
            "evidence_ref?, confidence, manual_handoff_required?, unsupported_reason?}.\n"
            "Use actions from [navigate, type, click, assert, wait_for, extract, manual_gate].\n"
            "If extraction cannot continue, add one `manual_gate` step and set `unsupported_reason` "
            "to an `ai.gemini.*` reason code.\n\n"
            f"Start URL:\n{payload.start_url}\n\n"
            f"Extractor strategy:\n{payload.extractor_strategy}\n\n"
            f"Event summary:\n{event_summary}\n\n"
            f"HAR summary:\n{har_summary}\n\n"
            f"HTML snapshot excerpt:\n{html_excerpt}\n"
        )

    def _summarize_events(self, entries: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        for entry in entries[:20]:
            method, path, status = self._entry_method_path_status(entry)
            if not path:
                continue
            reason = "mutation"
            if re.search(r"register|signup|auth|account|user|create", path, flags=re.IGNORECASE):
                reason = "account-flow"
            elif re.search(r"captcha|challenge|otp|mfa|verify", path, flags=re.IGNORECASE):
                reason = "protection-checkpoint"
            lines.append(f"- [{reason}] {method or 'GET'} {path} (status={status or 0})")
        if not lines:
            return "No event summary provided."
        return "\n".join(lines)

    def _summarize_har(self, entries: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        for index, entry in enumerate(entries[:25], start=1):
            method, path, status = self._entry_method_path_status(entry)
            if not path:
                continue
            lines.append(f"{index}. {method or 'GET'} {path} status={status or 0}")
        if not lines:
            return "No HAR entries provided."
        if len(entries) > 25:
            lines.append(f"... truncated {len(entries) - 25} additional entries")
        return "\n".join(lines)

    def _entry_method_path_status(self, entry: dict[str, Any]) -> tuple[str, str, int]:
        request_raw = entry.get("request")
        request: dict[str, Any] = request_raw if isinstance(request_raw, dict) else {}
        response_raw = entry.get("response")
        response: dict[str, Any] = response_raw if isinstance(response_raw, dict) else {}
        method = str(entry.get("method") or request.get("method") or "").upper()
        raw_url = str(entry.get("url") or request.get("url") or "")
        status = int(entry.get("status") or response.get("status") or 0)
        path = urlparse(raw_url).path if raw_url else ""
        if raw_url and not path:
            path = raw_url
        return method, path, status

    def _parse_response_steps(
        self, response: Any, start_url: str
    ) -> tuple[list[dict[str, Any]], bool]:
        raw_payload: Any = getattr(response, "parsed", None)
        if raw_payload is None:
            response_text = self._extract_text(response)
            if not response_text:
                return [], False
            raw_payload = self._try_parse_json(response_text)
        if isinstance(raw_payload, dict):
            raw_steps = raw_payload.get("steps")
        elif isinstance(raw_payload, list):
            raw_steps = raw_payload
        else:
            return [], False
        if not isinstance(raw_steps, list):
            return [], False
        normalized: list[dict[str, Any]] = []
        for raw_step in raw_steps:
            parsed = self._normalize_model_step(raw_step)
            if parsed == "__invalid_action_schema__":
                return [], True
            if isinstance(parsed, dict):
                normalized.append(parsed)
        if not normalized:
            return [], False
        return self._ensure_navigate_step(normalized, start_url), False

    def _extract_text(self, response: Any) -> str:
        text = getattr(response, "text", "")
        if isinstance(text, str) and text.strip():
            return text.strip()
        return ""

    def _try_parse_json(self, value: str) -> Any:
        value = value.strip()
        if value.startswith("```"):
            value = re.sub(r"^```(?:json)?\s*", "", value)
            value = re.sub(r"\s*```$", "", value)
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None

    def _normalize_model_step(self, raw_step: Any) -> dict[str, Any] | str | None:
        if not isinstance(raw_step, dict):
            return None
        action = str(raw_step.get("action") or "").strip()
        if not action:
            return None
        if action not in self._allowed_actions():
            return "__invalid_action_schema__"
        step: dict[str, Any] = {
            "action": action,
            "confidence": self._clamp_confidence(raw_step.get("confidence", 0.72)),
            "source_engine": str(raw_step.get("source_engine") or self.engine_name),
        }
        for key in (
            "url",
            "value_ref",
            "target",
            "selected_selector_index",
            "preconditions",
            "evidence_ref",
        ):
            if key in raw_step:
                step[key] = raw_step.get(key)
        if action == "manual_gate" or bool(raw_step.get("manual_handoff_required")):
            reason = self._normalize_reason(raw_step.get("unsupported_reason"))
            step["manual_handoff_required"] = True
            step["unsupported_reason"] = reason
            step["reason_code"] = reason
        return step

    def _ensure_navigate_step(
        self, steps: list[dict[str, Any]], start_url: str
    ) -> list[dict[str, Any]]:
        if steps and str(steps[0].get("action") or "") == "navigate":
            return steps
        for step in steps:
            if str(step.get("action") or "") == "navigate":
                return steps
        return [
            {
                "action": "navigate",
                "url": start_url,
                "confidence": 0.95,
                "source_engine": self.engine_name,
                "evidence_ref": "gemini:model:navigate",
            },
            *steps,
        ]

    def _attach_failure_reason(
        self, steps: list[dict[str, Any]], reason_code: str
    ) -> list[dict[str, Any]]:
        for step in steps:
            if str(step.get("action") or "") != "manual_gate":
                continue
            step["manual_handoff_required"] = True
            step["unsupported_reason"] = reason_code
            step["reason_code"] = reason_code
            break
        return steps

    def _normalize_reason(self, raw_reason: Any) -> str:
        reason = str(raw_reason or "").strip()
        if reason.startswith("ai.gemini."):
            return reason
        return self._FAILURE_MODEL_MANUAL_GATE

    @classmethod
    def _allowed_actions(cls) -> frozenset[str]:
        if cls._allowed_actions_cache is not None:
            return cls._allowed_actions_cache
        raw = json.loads(cls._ACTION_SCHEMA_PATH.read_text(encoding="utf-8"))
        actions = raw.get("actions") if isinstance(raw, dict) else None
        if not isinstance(actions, list) or any(not isinstance(item, str) for item in actions):
            raise ValueError(f"invalid action schema at {cls._ACTION_SCHEMA_PATH}")
        cls._allowed_actions_cache = frozenset(actions)
        return cls._allowed_actions_cache

    @staticmethod
    def _clamp_confidence(value: Any) -> float:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            numeric = 0.0
        return max(0.0, min(1.0, numeric))

    def _find_register_entry(self, entries: list[dict[str, Any]]) -> dict[str, Any] | None:
        for entry in entries:
            request_raw = entry.get("request")
            request: dict[str, Any] = request_raw if isinstance(request_raw, dict) else {}
            method = str(entry.get("method") or request.get("method") or "").upper()
            url = str(entry.get("url") or request.get("url") or "").lower()
            if method != "POST":
                continue
            if "/register" in url or "/signup" in url:
                return entry
        return None
