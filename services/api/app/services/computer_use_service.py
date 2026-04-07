from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from shutil import which
from typing import Any
from uuid import uuid4

from google import genai
from google.genai import types as genai_types

from app.core.runtime_paths import automation_runtime_root, repo_root
from app.core.settings import env_str

_DEFAULT_MODEL = "gemini-3.1-pro-preview"
_DEFAULT_THINKING_LEVEL = "high"
_ALLOWED_THINKING_LEVELS = {"minimal", "low", "medium", "high"}
_RISK_ACTION_NAMES = {"delete", "purchase", "send_email", "submit_payment", "transfer"}
_RISK_KEYWORDS = (
    "delete",
    "remove",
    "purchase",
    "pay",
    "checkout",
    "transfer",
    "send",
    "submit",
)


class ComputerUseServiceError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(slots=True)
class ComputerUseAction:
    action_id: str
    name: str
    args: dict[str, Any]
    rationale: str
    risk_level: str
    confirmation_reason: str | None
    action_digest: str
    require_confirmation: bool
    safety_decision: str
    status: str = "previewed"
    confirmed_by: str | None = None
    executed_at: str | None = None
    execution_in_progress: bool = False
    execution_result: dict[str, Any] | None = None


@dataclass(slots=True)
class ComputerUseSession:
    session_id: str
    instruction: str
    model: str
    created_at: str
    created_by: str
    metadata: dict[str, Any] = field(default_factory=dict)
    actions: dict[str, ComputerUseAction] = field(default_factory=dict)


class ComputerUseService:
    def __init__(self) -> None:
        root = repo_root()
        runtime_root = automation_runtime_root(root)
        self._runtime_root = runtime_root.resolve() / "computer-use"
        self._runtime_root.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, ComputerUseSession] = {}
        self._lock = threading.RLock()
        self._execution_condition = threading.Condition(self._lock)
        self._playwright_executor_script = (
            root / "automation" / "scripts" / "lib" / "computer_use_playwright_executor.mjs"
        )
        self._node_binary = self._resolve_node_binary()

    @staticmethod
    def _resolve_node_binary() -> str | None:
        configured = env_str("COMPUTER_USE_NODE_BINARY", "").strip()
        if configured:
            if os.sep in configured or (os.altsep and os.altsep in configured):
                candidate = Path(configured).expanduser()
                resolved = candidate.resolve()
                if resolved.is_file() and os.access(resolved, os.X_OK):
                    return str(resolved)
                return None

            discovered_override = which(configured)
            if discovered_override:
                override_resolved = Path(discovered_override).resolve()
                if override_resolved.is_file() and os.access(override_resolved, os.X_OK):
                    return str(override_resolved)
            return None
        discovered = which("node")
        if not discovered:
            return None
        resolved = Path(discovered).resolve()
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return str(resolved)
        return None

    def create_session(
        self,
        *,
        instruction: str,
        actor: str,
        model: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ComputerUseSession:
        prompt = instruction.strip()
        if not prompt:
            raise ComputerUseServiceError("instruction is required", status_code=422)
        raw_model = (model or env_str("GEMINI_MODEL", _DEFAULT_MODEL)).strip() or _DEFAULT_MODEL
        resolved_model = raw_model.removeprefix("models/").strip()
        if not resolved_model.startswith("gemini-"):
            raise ComputerUseServiceError(
                "computer use supports Gemini models only", status_code=422
            )

        session_id = f"cus_{uuid4().hex}"
        now = datetime.now(UTC).isoformat()
        session = ComputerUseSession(
            session_id=session_id,
            instruction=prompt,
            model=resolved_model,
            created_at=now,
            created_by=actor,
            metadata=metadata or {},
        )
        with self._lock:
            self._sessions[session_id] = session
        self._write_evidence(
            session_id,
            "session_created",
            {"instruction": prompt, "model": resolved_model, "actor": actor},
        )
        return session

    def preview_action(
        self,
        *,
        session_id: str,
        actor: str,
        screenshot_base64: str | None,
        screenshot_mime_type: str,
        instruction: str | None = None,
        include_thoughts: bool | None = None,
    ) -> ComputerUseAction:
        session = self._require_owned_session(session_id=session_id, actor=actor)
        effective_instruction = (instruction or session.instruction).strip()
        if not effective_instruction:
            raise ComputerUseServiceError("effective instruction is empty", status_code=422)

        api_key = (env_str("GEMINI_API_KEY", "")).strip()
        if not api_key:
            raise ComputerUseServiceError("missing GEMINI_API_KEY", status_code=503)

        response = self._generate_plan(
            api_key=api_key,
            model=session.model,
            instruction=effective_instruction,
            screenshot_base64=screenshot_base64,
            screenshot_mime_type=screenshot_mime_type,
            include_thoughts=self._resolve_include_thoughts(include_thoughts),
        )

        action_name, action_args, rationale = self._extract_action_from_response(response)
        risk_level, confirmation_reason = self._classify_risk(
            action_name, action_args, effective_instruction
        )
        require_confirmation = risk_level in {"high", "critical"}
        safety_decision = "require_confirmation" if require_confirmation else "allow_auto_execute"
        action_digest = self._build_action_digest(action_name, action_args, effective_instruction)

        action = ComputerUseAction(
            action_id=f"act_{uuid4().hex[:12]}",
            name=action_name,
            args=action_args,
            rationale=rationale,
            risk_level=risk_level,
            confirmation_reason=confirmation_reason,
            action_digest=action_digest,
            require_confirmation=require_confirmation,
            safety_decision=safety_decision,
        )
        with self._lock:
            session.actions[action.action_id] = action
        self._write_evidence(
            session_id,
            "action_previewed",
            {
                "actionId": action.action_id,
                "name": action.name,
                "args": action.args,
                "rationale": action.rationale,
                "riskLevel": action.risk_level,
                "confirmationReason": action.confirmation_reason,
                "actionDigest": action.action_digest,
                "safetyDecision": action.safety_decision,
                "requireConfirmation": action.require_confirmation,
                "previewedBy": actor,
            },
        )
        return action

    def confirm_action(
        self,
        *,
        session_id: str,
        action_id: str,
        actor: str,
        approved: bool,
        confirmation_reason: str | None = None,
    ) -> ComputerUseAction:
        action = self._require_owned_action(session_id=session_id, action_id=action_id, actor=actor)
        if action.status == "executed":
            return action
        action.status = "confirmed" if approved else "rejected"
        action.confirmed_by = actor
        if confirmation_reason and confirmation_reason.strip():
            action.confirmation_reason = confirmation_reason.strip()
        self._write_evidence(
            session_id,
            "action_confirmation",
            {
                "actionId": action_id,
                "approved": approved,
                "confirmedBy": actor,
                "confirmationReason": action.confirmation_reason,
            },
        )
        return action

    def execute_action(self, *, session_id: str, action_id: str, actor: str) -> dict[str, Any]:
        session = self._require_owned_session(session_id=session_id, actor=actor)
        action = self._require_owned_action(session_id=session_id, action_id=action_id, actor=actor)

        with self._execution_condition:
            self._validate_action_can_execute(action)
            if action.status == "executed" and isinstance(action.execution_result, dict):
                return dict(action.execution_result)
            while action.execution_in_progress:
                self._execution_condition.wait(timeout=5)
                if action.status == "executed" and isinstance(action.execution_result, dict):
                    return dict(action.execution_result)
                self._validate_action_can_execute(action)
            action.execution_in_progress = True

        try:
            execution = self._execute_with_playwright(session=session, action=action, actor=actor)
            executed_at = datetime.now(UTC).isoformat()
            result = {
                "actionId": action_id,
                "status": "executed",
                "executor": execution["executor"],
                "executedAt": executed_at,
                "executedBy": actor,
                "appliedArgs": action.args,
                "riskLevel": action.risk_level,
                "confirmationReason": action.confirmation_reason,
                "actionDigest": action.action_digest,
                "evidence": execution["evidence"],
            }
            with self._execution_condition:
                action.status = "executed"
                action.executed_at = executed_at
                action.execution_result = result
                action.execution_in_progress = False
                self._execution_condition.notify_all()
            self._write_evidence(session_id, "action_executed", result)
            return result
        except Exception:
            with self._execution_condition:
                action.execution_in_progress = False
                self._execution_condition.notify_all()
            raise

    def read_evidence(self, *, session_id: str, actor: str) -> dict[str, Any]:
        _ = self._require_owned_session(session_id=session_id, actor=actor)
        evidence_file = self._evidence_file(session_id)
        events: list[dict[str, Any]] = []
        if evidence_file.exists():
            for line in evidence_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    events.append(parsed)
        return {
            "sessionId": session_id,
            "eventCount": len(events),
            "events": events,
            "evidencePath": str(evidence_file),
        }

    def _generate_plan(
        self,
        *,
        api_key: str,
        model: str,
        instruction: str,
        screenshot_base64: str | None,
        screenshot_mime_type: str,
        include_thoughts: bool,
    ) -> Any:
        client = genai.Client(api_key=api_key)
        contents: list[Any] = [instruction]
        if screenshot_base64:
            try:
                binary = base64.b64decode(screenshot_base64.encode("utf-8"), validate=True)
                contents.append(
                    genai_types.Part.from_bytes(
                        data=binary, mime_type=screenshot_mime_type or "image/png"
                    )
                )
            except Exception:
                contents.append("[invalid screenshot payload]")

        tools: list[Any] = []
        tool_type = getattr(genai_types, "Tool", None)
        computer_use_type = getattr(genai_types, "ComputerUse", None)
        if callable(tool_type) and callable(computer_use_type):
            try:
                tools.append(tool_type(computer_use=computer_use_type()))
            except Exception:
                tools = []

        config_kwargs: dict[str, Any] = {
            "temperature": 1.0,
            "thinking_config": genai_types.ThinkingConfig(  # type: ignore[call-arg]
                thinking_level=self._resolve_thinking_level(),
                include_thoughts=include_thoughts,
            ),
        }
        if tools:
            config_kwargs["tools"] = tools

        return client.models.generate_content(
            model=model,
            contents=contents,
            config=genai_types.GenerateContentConfig(**config_kwargs),
        )

    @staticmethod
    def _parse_bool(raw: str, fallback: bool) -> bool:
        value = raw.strip().lower()
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False
        return fallback

    def _resolve_include_thoughts(self, requested_value: bool | None) -> bool:
        if requested_value is not None:
            return requested_value
        raw = env_str("GEMINI_INCLUDE_THOUGHTS", "true")
        return self._parse_bool(raw, True)

    def _resolve_thinking_level(self) -> Any:
        raw = env_str("GEMINI_THINKING_LEVEL", _DEFAULT_THINKING_LEVEL).strip().lower()
        normalized = raw if raw in _ALLOWED_THINKING_LEVELS else _DEFAULT_THINKING_LEVEL
        thinking_level_enum = getattr(genai_types, "ThinkingLevel", None)
        if thinking_level_enum is None:
            return "HIGH"
        return getattr(
            thinking_level_enum, normalized.upper(), getattr(thinking_level_enum, "HIGH", "HIGH")
        )

    def _extract_action_from_response(self, response: Any) -> tuple[str, dict[str, Any], str]:
        default_rationale = "generated by gemini computer-use planner"
        candidates = getattr(response, "candidates", None)
        if isinstance(candidates, list):
            for candidate in candidates:
                content = getattr(candidate, "content", None)
                parts = getattr(content, "parts", None)
                if not isinstance(parts, list):
                    continue
                for part in parts:
                    function_call = getattr(part, "function_call", None)
                    if function_call is None:
                        continue
                    name = str(getattr(function_call, "name", "manual_review") or "manual_review")
                    args = getattr(function_call, "args", {})
                    if not isinstance(args, dict):
                        args = {"raw": str(args)}
                    return name, args, default_rationale

        text = getattr(response, "text", None)
        normalized = text.strip() if isinstance(text, str) else ""
        if normalized:
            return "manual_review", {"summary": normalized[:500]}, "text-only fallback"
        return "manual_review", {}, "empty model response"

    def _classify_risk(
        self, action_name: str, action_args: dict[str, Any], instruction: str
    ) -> tuple[str, str | None]:
        name = action_name.strip().lower()
        payload = json.dumps(action_args, ensure_ascii=False).lower()
        haystack = f"{name} {instruction.lower()} {payload}"
        if name in _RISK_ACTION_NAMES:
            return "critical", f"action '{name}' is high impact"
        if any(keyword in haystack for keyword in _RISK_KEYWORDS):
            return "high", "instruction/args contain high-risk keywords"
        if name in {"click", "type", "key", "scroll", "move", "wait", "navigate", "manual_review"}:
            return "medium", None
        return "low", None

    def _build_action_digest(
        self, action_name: str, action_args: dict[str, Any], instruction: str
    ) -> str:
        canonical = json.dumps(
            {"name": action_name, "args": action_args, "instruction": instruction},
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]

    def _execute_with_playwright(
        self, *, session: ComputerUseSession, action: ComputerUseAction, actor: str
    ) -> dict[str, Any]:
        if not self._node_binary:
            raise ComputerUseServiceError("node executable not found", status_code=503)
        if not self._playwright_executor_script.exists():
            raise ComputerUseServiceError("playwright executor script not found", status_code=503)
        payload = {
            "sessionId": session.session_id,
            "actionId": action.action_id,
            "actor": actor,
            "action": {"name": action.name, "args": action.args},
            "metadata": session.metadata,
            "runtimeRoot": str(self._session_root(session.session_id)),
        }
        try:
            proc = subprocess.run(
                [self._node_binary, str(self._playwright_executor_script)],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                check=False,
                timeout=45,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ComputerUseServiceError(
                f"playwright executor failed: {exc}", status_code=503
            ) from exc

        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise ComputerUseServiceError(
                f"playwright executor returned non-zero status ({proc.returncode}): {err[:500]}",
                status_code=502,
            )
        try:
            parsed = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise ComputerUseServiceError(
                "playwright executor returned invalid json", status_code=502
            ) from exc
        if not isinstance(parsed, dict):
            raise ComputerUseServiceError(
                "playwright executor returned invalid payload", status_code=502
            )
        evidence = parsed.get("evidence")
        if not isinstance(evidence, dict):
            evidence = {}
        return {
            "executor": str(parsed.get("executor") or "backend-playwright-adapter"),
            "evidence": {
                "screens": evidence.get("screens")
                if isinstance(evidence.get("screens"), list)
                else [],
                "clips": evidence.get("clips") if isinstance(evidence.get("clips"), list) else [],
                "network_summary": evidence.get("network_summary")
                if isinstance(evidence.get("network_summary"), dict)
                else {},
                "dom_summary": evidence.get("dom_summary")
                if isinstance(evidence.get("dom_summary"), dict)
                else {},
                "replay_trace": evidence.get("replay_trace")
                if isinstance(evidence.get("replay_trace"), dict)
                else {},
            },
        }

    def _require_session(self, session_id: str) -> ComputerUseSession:
        candidate = session_id.strip()
        if not re.fullmatch(r"cus_[0-9a-f]{32}", candidate):
            raise ComputerUseServiceError("invalid session id", status_code=422)
        with self._lock:
            session = self._sessions.get(candidate)
        if session is None:
            raise ComputerUseServiceError("session not found", status_code=404)
        return session

    def _require_owned_session(self, *, session_id: str, actor: str) -> ComputerUseSession:
        session = self._require_session(session_id)
        if session.created_by != actor:
            raise ComputerUseServiceError(
                "forbidden: session does not belong to actor", status_code=403
            )
        return session

    def _require_action(self, session_id: str, action_id: str) -> ComputerUseAction:
        session = self._require_session(session_id)
        action = session.actions.get(action_id)
        if action is None:
            raise ComputerUseServiceError("action not found", status_code=404)
        return action

    def _require_owned_action(
        self, *, session_id: str, action_id: str, actor: str
    ) -> ComputerUseAction:
        _ = self._require_owned_session(session_id=session_id, actor=actor)
        action = self._require_action(session_id, action_id)
        return action

    @staticmethod
    def _validate_action_can_execute(action: ComputerUseAction) -> None:
        if action.status == "rejected":
            raise ComputerUseServiceError(
                "action was rejected and cannot be executed", status_code=409
            )
        if action.status == "previewed" and action.require_confirmation:
            raise ComputerUseServiceError(
                "action requires confirmation before execution", status_code=409
            )
        if action.require_confirmation and action.status not in {"confirmed", "executed"}:
            raise ComputerUseServiceError(
                "action requires confirmation before execution", status_code=409
            )

    def _session_root(self, session_id: str) -> Path:
        root = self._runtime_root / session_id
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _evidence_file(self, session_id: str) -> Path:
        return self._session_root(session_id) / "evidence.jsonl"

    def _write_evidence(self, session_id: str, event: str, payload: dict[str, Any]) -> None:
        record = {
            "ts": datetime.now(UTC).isoformat(),
            "event": event,
            "payload": payload,
        }
        with self._lock:
            target = self._evidence_file(session_id)
            with target.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")


computer_use_service = ComputerUseService()

__all__ = [
    "ComputerUseAction",
    "ComputerUseService",
    "ComputerUseServiceError",
    "ComputerUseSession",
    "computer_use_service",
]
