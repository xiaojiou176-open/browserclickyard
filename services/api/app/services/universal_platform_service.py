from __future__ import annotations

import json
import importlib
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status
from pydantic import ValidationError

from app.core.observability import REQUEST_ID_CTX, TRACE_ID_CTX
from app.core.runtime_paths import automation_runtime_root, repo_root, runtime_logs_path, runtime_path
from app.core.settings import env_str
from app.models.flow import FlowRecord, FlowStep, SessionRecord
from app.models.automation import (
    GeneratedRunParams,
    OrchestrateFromArtifactsRequest,
    OrchestrateFromArtifactsResponse,
    ProfileResolveRequest,
    ProfileResolveResponse,
    ReconstructionGenerateRequest,
    ReconstructionGenerateResponse,
    ReconstructionPreviewRequest,
    ReconstructionPreviewResponse,
)
from app.models.manual_gate import RunResumeRequest
from app.models.run import RunLogEntry, RunRecord, RunStatus, RunWaitContext
from app.models.template import OtpPolicy, TemplateParamSpec, TemplatePolicies, TemplateRecord
from app.services.universal_platform import params as params_ops
from app.services.universal_platform import resume as resume_ops
from app.services.universal_platform import run as run_ops
from app.services.universal_platform import secrets as secrets_ops
from app.services.universal_platform import template as template_ops
from app.services.video_reconstruction_service import video_reconstruction_service

fcntl: Any
try:  # pragma: no cover - non-posix platforms
    fcntl = importlib.import_module("fcntl")
except ImportError:  # pragma: no cover
    fcntl = None


class UniversalPlatformService:
    _DEFAULT_VALIDATED_CACHE_TTL_SECONDS = 900
    _DEFAULT_VALIDATED_CACHE_MAX_ENTRIES = 500
    _SESSION_MODE_ALIAS: dict[str, str] = {
        "midscene": "ai",
    }
    _STRIPE_PARAM_KEYS: tuple[str, ...] = (
        "stripeCardNumber",
        "stripeExpMonth",
        "stripeExpYear",
        "stripeCvc",
        "stripeCardholderName",
        "stripePostalCode",
        "stripeCountry",
    )
    _SENSITIVE_PARAM_KEYS: frozenset[str] = frozenset(
        {
            "stripeCardNumber",
            "stripeExpMonth",
            "stripeExpYear",
            "stripeCvc",
            "stripeCardholderName",
            "stripePostalCode",
            "stripeCountry",
        }
    )
    _SENSITIVE_LOG_PATTERNS: tuple[re.Pattern[str], ...] = (
        re.compile(
            r"((?:otp|code|token|key|password|secret|card)[^=\n\r]{0,40}[=:]\s*)([^\s,;]+)",
            re.IGNORECASE,
        ),
        re.compile(r"(\b(?:otp|code|token|key|password|secret|card)\b)", re.IGNORECASE),
    )
    _LEGACY_VALIDATED_PARAMS_KEY = "validated_params_snapshot"
    _run_owner_key = "owner"
    _run_resume_params_key = "resume_params"
    _TERMINAL_RUN_STATUSES: frozenset[str] = frozenset({"success", "failed", "cancelled"})

    def __init__(self) -> None:
        self._root = repo_root()
        self._runtime_cache_root = runtime_path(root=self._root)
        platform_data_override = env_str("UNIVERSAL_PLATFORM_DATA_DIR", "").strip()
        self._runtime_root = automation_runtime_root(self._root)
        self._base_dir = (
            Path(platform_data_override)
            if platform_data_override
            else (self._runtime_root / "universal")
        )
        self._runtime_logs_dir = runtime_logs_path("automation", root=self._root)
        self._sessions_path = self._base_dir / "sessions.json"
        self._flows_path = self._base_dir / "flows.json"
        self._templates_path = self._base_dir / "templates.json"
        self._runs_path = self._base_dir / "runs.json"
        self._audit_path = self._runtime_logs_dir / "universal.audit.jsonl"
        self._audit_max_bytes = self._read_positive_int_env(
            "UNIVERSAL_AUDIT_MAX_BYTES", default=5 * 1024 * 1024, minimum=1024
        )
        self._audit_backup_count = self._read_positive_int_env(
            "UNIVERSAL_AUDIT_BACKUP_COUNT", default=5, minimum=1
        )
        self._audit_retention_days = self._read_positive_int_env(
            "UNIVERSAL_AUDIT_RETENTION_DAYS", default=7, minimum=1
        )
        self._audit_write_failures = 0
        self._runs_file_lock_path = self._runs_path.with_suffix(".json.lock")
        self._cache_ttl_seconds = self._read_non_negative_int_env(
            "CACHE_TTL_SECONDS",
            self._DEFAULT_VALIDATED_CACHE_TTL_SECONDS,
        )
        self._cache_max_entries = self._read_non_negative_int_env(
            "CACHE_MAX_ENTRIES",
            self._DEFAULT_VALIDATED_CACHE_MAX_ENTRIES,
        )
        self._lock = Lock()
        self._audit_lock = Lock()
        self._validated_params_cache: dict[str, tuple[float, dict[str, str]]] = {}

    def list_sessions(self, limit: int = 30, requester: str | None = None) -> list[SessionRecord]:
        sessions = [
            SessionRecord.model_validate(item) for item in self._read_json(self._sessions_path)
        ]
        if requester:
            sessions = [item for item in sessions if item.owner == requester]
        sessions.sort(key=lambda item: item.started_at, reverse=True)
        return sessions[: max(1, min(limit, 200))]

    def start_session(self, start_url: str, mode: str, owner: str | None = None) -> SessionRecord:
        normalized_url = str(start_url).strip()
        if not normalized_url:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="start_url is required"
            )
        normalized_mode = self._normalize_session_mode(mode)
        if normalized_mode not in {"manual", "ai"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="mode must be manual or ai",
            )
        record = SessionRecord(
            session_id=f"ss_{uuid4().hex}",
            start_url=normalized_url,
            mode=normalized_mode,  # type: ignore[arg-type]
            owner=owner,
            started_at=datetime.now(UTC),
        )
        with self._lock:
            sessions = self._read_json(self._sessions_path)
            sessions.append(record.model_dump(mode="json"))
            self._write_json(self._sessions_path, sessions)
            self._audit(
                "session.start",
                owner,
                {
                    "session_id": record.session_id,
                    "start_url": normalized_url,
                    "mode": normalized_mode,
                },
            )
        return record

    def get_session(self, session_id: str, requester: str | None = None) -> SessionRecord:
        session = self._get_session(session_id)
        if session is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session not found")
        self._ensure_session_access(session, requester)
        return session

    def finish_session(self, session_id: str, owner: str | None = None) -> SessionRecord:
        with self._lock:
            sessions = self._read_json(self._sessions_path)
            found = None
            for idx, item in enumerate(sessions):
                if item.get("session_id") != session_id:
                    continue
                model = SessionRecord.model_validate(item)
                self._ensure_session_access(model, owner)
                model.finished_at = datetime.now(UTC)
                sessions[idx] = model.model_dump(mode="json")
                found = model
                break
            if found is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="session not found"
                )
            self._write_json(self._sessions_path, sessions)
            self._audit("session.finish", owner, {"session_id": session_id})
            return found

    def list_flows(
        self, limit: int = 50, requester: str | None = None, actor: str | None = None
    ) -> list[FlowRecord]:
        requester = requester or actor
        items = [FlowRecord.model_validate(item) for item in self._read_json(self._flows_path)]
        if requester:
            items = [item for item in items if self._flow_owner(item) == requester]
        items.sort(key=lambda item: item.updated_at, reverse=True)
        return items[: max(1, min(limit, 200))]

    def get_flow(self, flow_id: str, requester: str | None = None) -> FlowRecord:
        for item in self._read_json(self._flows_path):
            if item.get("flow_id") == flow_id:
                flow = FlowRecord.model_validate(item)
                self._ensure_flow_access(flow, requester)
                return flow
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="flow not found")

    def create_flow(
        self,
        session_id: str,
        start_url: str,
        steps: list[dict[str, Any]],
        source_event_count: int = 0,
        requester: str | None = None,
        owner: str | None = None,
    ) -> FlowRecord:
        requester = requester or owner
        session = self._get_session(session_id)
        if session is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session not found")
        self._ensure_session_access(session, requester)
        now = datetime.now(UTC)
        try:
            validated_steps = [FlowStep.model_validate(step) for step in steps]
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={"message": "invalid flow steps payload", "errors": exc.errors()},
            ) from exc
        record = FlowRecord(
            flow_id=f"fl_{uuid4().hex}",
            session_id=session_id,
            start_url=start_url,
            source_event_count=max(0, source_event_count),
            steps=validated_steps,
            created_at=now,
            updated_at=now,
            quality_score=self._score_flow(steps),
        )
        with self._lock:
            flows = self._read_json(self._flows_path)
            flows.append(record.model_dump(mode="json"))
            self._write_json(self._flows_path, flows)
        return record

    def import_latest_flow_draft(self, owner: str | None = None) -> FlowRecord:
        latest_pointer = self._runtime_root / "latest-session.json"
        if not latest_pointer.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="latest session pointer not found"
            )
        try:
            latest = json.loads(latest_pointer.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="latest session pointer is invalid",
            )
        session_id = str(latest.get("sessionId") or "")
        session_dir = str(latest.get("sessionDir") or "")
        if not session_id or not session_dir:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="latest session pointer missing keys",
            )
        session_dir_path = Path(session_dir).resolve()
        if not self._is_within_runtime_root(session_dir_path):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="latest session path is outside runtime root",
            )
        flow_path = (session_dir_path / "flow-draft.json").resolve()
        if not self._is_within_runtime_root(flow_path):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="latest flow path is outside runtime root",
            )
        if not flow_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="latest flow draft not found"
            )
        try:
            raw = json.loads(flow_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="latest flow draft invalid",
            )
        if not isinstance(raw, dict):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="latest flow draft invalid format",
            )
        start_url = str(raw.get("start_url") or "")
        steps = raw.get("steps")
        if not start_url or not isinstance(steps, list):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="latest flow draft missing start_url/steps",
            )
        session = self._get_session(session_id)
        if session is not None:
            self._ensure_session_access(session, owner)
        else:
            self._upsert_session_from_import(
                session_id=session_id, start_url=start_url, owner=owner
            )
        flow = self.create_flow(
            session_id=session_id,
            start_url=start_url,
            steps=[item for item in steps if isinstance(item, dict)],
            source_event_count=int(raw.get("source_event_count") or 0),
            requester=owner,
        )
        self._audit(
            "flow.import_latest", owner, {"flow_id": flow.flow_id, "session_id": session_id}
        )
        return flow

    def update_flow(
        self,
        flow_id: str,
        *,
        steps: list[dict[str, Any]] | None = None,
        start_url: str | None = None,
        expected_version: int | None = None,
        requester: str | None = None,
    ) -> FlowRecord:
        with self._lock:
            flows = self._read_json(self._flows_path)
            found = None
            for idx, item in enumerate(flows):
                if item.get("flow_id") != flow_id:
                    continue
                model = FlowRecord.model_validate(item)
                self._ensure_flow_access(model, requester)
                if expected_version is not None and model.version != expected_version:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=f"flow version conflict: expected {expected_version}, current {model.version}",
                    )
                if steps is not None:
                    try:
                        model.steps = [FlowStep.model_validate(step) for step in steps]
                    except ValidationError as exc:
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                            detail={
                                "message": "invalid flow steps payload",
                                "errors": exc.errors(),
                            },
                        ) from exc
                    model.quality_score = self._score_flow(steps)
                if start_url is not None and start_url.strip():
                    model.start_url = start_url.strip()
                model.version += 1
                model.updated_at = datetime.now(UTC)
                flows[idx] = model.model_dump(mode="json")
                found = model
                break
            if found is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="flow not found")
            self._write_json(self._flows_path, flows)
            return found

    def resolve_target_profile(self, payload: ProfileResolveRequest) -> ProfileResolveResponse:
        return video_reconstruction_service.resolve_profile(payload)

    def create_reconstruction_preview(
        self, payload: ReconstructionPreviewRequest
    ) -> ReconstructionPreviewResponse:
        return video_reconstruction_service.preview(payload)

    def generate_reconstruction(
        self,
        payload: ReconstructionGenerateRequest,
        actor: str | None = None,
    ) -> ReconstructionGenerateResponse:
        preview = payload.preview
        if preview is None:
            if not payload.preview_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="preview_id or preview is required",
                )
            preview = video_reconstruction_service.load_preview(payload.preview_id)

        generated = video_reconstruction_service.generate(preview)
        flow_draft = preview.flow_draft
        session_id = str(flow_draft.get("session_id") or f"ss_{uuid4().hex}")
        start_url = str(flow_draft.get("start_url") or "")
        steps = flow_draft.get("steps")
        if not start_url or not isinstance(steps, list):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="preview is missing start_url or steps",
            )
        session = self._get_session(session_id)
        if session is not None:
            self._ensure_session_access(session, actor)
        else:
            self._upsert_session_from_import(
                session_id=session_id, start_url=start_url, owner=actor
            )

        flow = self.create_flow(
            session_id=session_id,
            start_url=start_url,
            steps=[item for item in steps if isinstance(item, dict)],
            source_event_count=int(flow_draft.get("source_event_count") or 0),
            requester=actor,
        )
        generated.flow_id = flow.flow_id

        template = self.create_template(
            flow_id=flow.flow_id,
            name=payload.template_name,
            params_schema=[
                {"key": "email", "type": "email", "required": True},
                {"key": "password", "type": "secret", "required": True},
            ],
            defaults={},
            policies={"otp": {"required": False, "provider": "manual"}},
            created_by=actor,
        )
        generated.template_id = template.template_id

        if payload.create_run:
            run_params = self.autofill_required_run_params(template)
            run_params.update(payload.run_params.model_dump(exclude_none=True))
            run = self.create_run(template.template_id, run_params, actor=actor)
            generated.run_id = run.run_id
        return generated

    def create_template_from_artifacts(
        self,
        payload: OrchestrateFromArtifactsRequest,
        actor: str | None = None,
    ) -> OrchestrateFromArtifactsResponse:
        preview = self.create_reconstruction_preview(
            ReconstructionPreviewRequest(
                artifacts=payload.artifacts,
                video_analysis_mode="gemini",
                extractor_strategy=payload.extractor_strategy,
                auto_refine_iterations=payload.auto_refine_iterations,
            )
        )
        generated = self.generate_reconstruction(
            ReconstructionGenerateRequest(
                preview=preview,
                template_name=payload.template_name,
                create_run=payload.create_run,
                run_params=GeneratedRunParams.model_validate(payload.run_params),
            ),
            actor=actor,
        )
        return OrchestrateFromArtifactsResponse(
            template_id=generated.template_id,
            run_id=generated.run_id,
            reconstructed_flow_quality=generated.reconstructed_flow_quality,
            step_confidence=generated.step_confidence,
            unresolved_segments=generated.unresolved_segments,
            generator_outputs=generated.generator_outputs,
            manual_handoff_required=generated.manual_handoff_required,
            unsupported_reason=generated.unsupported_reason,
        )

    def autofill_required_run_params(self, template: TemplateRecord) -> dict[str, str]:
        return template_ops.autofill_required_run_params(template)

    def list_templates(
        self,
        limit: int = 100,
        requester: str | None = None,
        actor: str | None = None,
    ) -> list[TemplateRecord]:
        return template_ops.list_templates(self, limit=limit, requester=requester or actor)

    def get_template(self, template_id: str, requester: str | None = None) -> TemplateRecord:
        return template_ops.get_template(self, template_id, requester=requester)

    def create_template(
        self,
        *,
        flow_id: str,
        name: str,
        params_schema: list[dict[str, Any] | TemplateParamSpec],
        defaults: dict[str, str],
        policies: dict[str, Any] | TemplatePolicies,
        created_by: str | None = None,
    ) -> TemplateRecord:
        return template_ops.create_template(
            self,
            flow_id=flow_id,
            name=name,
            params_schema=params_schema,
            defaults=defaults,
            policies=policies,
            created_by=created_by,
        )

    def update_template(
        self,
        template_id: str,
        *,
        name: str | None = None,
        params_schema: list[dict[str, Any] | TemplateParamSpec] | None = None,
        defaults: dict[str, str] | None = None,
        policies: dict[str, Any] | TemplatePolicies | None = None,
        actor: str | None = None,
    ) -> TemplateRecord:
        return template_ops.update_template(
            self,
            template_id,
            name=name,
            params_schema=params_schema,
            defaults=defaults,
            policies=policies,
            actor=actor,
        )

    def export_template(self, template_id: str, actor: str | None = None) -> dict[str, Any]:
        return template_ops.export_template(self, template_id, actor=actor)

    def list_template_history(
        self, template_id: str, requester: str | None = None
    ) -> list[TemplateRecord]:
        return template_ops.list_template_history(self, template_id, requester=requester)

    def fork_template_version(
        self,
        template_id: str,
        *,
        template_name: str | None = None,
        change_note: str | None = None,
        params_schema: list[dict[str, Any] | TemplateParamSpec] | None = None,
        defaults: dict[str, str] | None = None,
        policies: dict[str, Any] | TemplatePolicies | None = None,
        actor: str | None = None,
    ) -> TemplateRecord:
        return template_ops.fork_template_version(
            self,
            template_id,
            template_name=template_name,
            change_note=change_note,
            params_schema=params_schema,
            defaults=defaults,
            policies=policies,
            actor=actor,
        )

    def mark_template_recommended(
        self, template_id: str, actor: str | None = None
    ) -> TemplateRecord:
        return template_ops.mark_template_recommended(self, template_id, actor=actor)

    def promote_template(
        self,
        *,
        flow_id: str | None = None,
        run_id: str | None = None,
        template_name: str,
        change_note: str | None = None,
        recommended: bool = False,
        actor: str | None = None,
    ) -> TemplateRecord:
        return template_ops.promote_template(
            self,
            flow_id=flow_id,
            run_id=run_id,
            template_name=template_name,
            change_note=change_note,
            recommended=recommended,
            actor=actor,
        )

    def list_runs(
        self,
        limit: int = 100,
        requester: str | None = None,
        actor: str | None = None,
    ) -> list[RunRecord]:
        return run_ops.list_runs(self, limit=limit, requester=requester or actor)

    def get_run(self, run_id: str, requester: str | None = None) -> RunRecord:
        return run_ops.get_run(self, run_id, requester=requester)

    def create_run(
        self,
        template_id: str,
        params: dict[str, str],
        actor: str | None = None,
        otp_code: str | None = None,
    ) -> RunRecord:
        return run_ops.create_run(self, template_id, params, actor=actor, otp_code=otp_code)

    def submit_otp_and_resume(
        self,
        run_id: str,
        otp_code: str | None,
        expected_version: int | None = None,
        actor: str | None = None,
    ) -> RunRecord:
        return resume_ops.submit_otp_and_resume(
            self, run_id, otp_code, expected_version=expected_version, actor=actor
        )

    def submit_resume(
        self,
        run_id: str,
        payload: RunResumeRequest,
        actor: str | None = None,
    ) -> RunRecord:
        return resume_ops.submit_resume(self, run_id, payload, actor=actor)

    def cancel_run(
        self, run_id: str, actor: str | None = None, expected_version: int | None = None
    ) -> RunRecord:
        return run_ops.cancel_run(self, run_id, actor=actor, expected_version=expected_version)

    def _upsert_run(
        self,
        run: RunRecord,
        extras: dict[str, Any] | None = None,
        *,
        expected_version: int | None = None,
        forbid_terminal_regression: bool = True,
    ) -> bool:
        with self._lock:
            return self._save_run_locked(
                run,
                extras=extras,
                expected_version=expected_version,
                forbid_terminal_regression=forbid_terminal_regression,
            )

    def _save_run_locked(
        self,
        run: RunRecord,
        extras: dict[str, Any] | None = None,
        *,
        expected_version: int | None = None,
        forbid_terminal_regression: bool = True,
    ) -> bool:
        with self._runs_file_lock():
            runs = self._read_json_unlocked(self._runs_path)
            encoded = self._encode_run(run)
            if isinstance(extras, dict):
                encoded.update(extras)
            for idx, item in enumerate(runs):
                if item.get("run_id") != run.run_id:
                    continue
                current = RunRecord.model_validate(item)
                if expected_version is not None and current.version != expected_version:
                    return False
                if (
                    forbid_terminal_regression
                    and current.status in self._TERMINAL_RUN_STATUSES
                    and run.status != current.status
                ):
                    return False
                if isinstance(item, dict):
                    for key, value in item.items():
                        if key not in encoded:
                            encoded[key] = value
                runs[idx] = encoded
                self._write_json_unlocked(self._runs_path, runs)
                return True
            if expected_version not in (None, 0):
                return False
            runs.append(encoded)
            self._write_json_unlocked(self._runs_path, runs)
            return True

    def _load_run_locked(self, run_id: str) -> RunRecord | None:
        with self._runs_file_lock():
            runs = self._read_json_unlocked(self._runs_path)
        for item in runs:
            if item.get("run_id") == run_id:
                return RunRecord.model_validate(item)
        return None

    def _get_validated_params_snapshot(self, run_id: str) -> dict[str, str]:
        with self._lock:
            now_ts = time.time()
            self._prune_validated_params_cache_locked(now_ts=now_ts)
            cached = self._validated_params_cache.get(run_id)
            if cached is not None:
                return dict(cached[1])
            for item in self._read_json(self._runs_path):
                if item.get("run_id") != run_id:
                    continue
                snapshot = self._decode_validated_params_snapshot(item)
                if snapshot:
                    if self._cache_max_entries > 0:
                        self._validated_params_cache[run_id] = (now_ts, dict(snapshot))
                        self._prune_validated_params_cache_locked(now_ts=now_ts)
                    return dict(snapshot)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT, detail="run params snapshot unavailable"
                )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")

    def _encode_run(self, run: RunRecord) -> dict[str, Any]:
        return run.model_dump(mode="json")

    def _decode_validated_params_snapshot(self, payload: dict[str, Any]) -> dict[str, str]:
        return self._normalize_snapshot_params(payload.get(self._LEGACY_VALIDATED_PARAMS_KEY))

    def _normalize_snapshot_params(self, raw: Any) -> dict[str, str]:
        if not isinstance(raw, dict):
            return {}
        snapshot: dict[str, str] = {}
        for key, value in raw.items():
            if isinstance(key, str):
                snapshot[key] = value if isinstance(value, str) else ""
        return snapshot

    def _cache_validated_params_snapshot(self, run_id: str, params: dict[str, str]) -> None:
        with self._lock:
            if self._cache_max_entries == 0:
                self._validated_params_cache.clear()
                return
            now_ts = time.time()
            self._validated_params_cache[run_id] = (now_ts, dict(params))
            self._prune_validated_params_cache_locked(now_ts=now_ts)

    def _prune_validated_params_cache_locked(self, *, now_ts: float | None = None) -> None:
        if not self._validated_params_cache:
            return
        now_value = now_ts if now_ts is not None else time.time()
        ttl_seconds = self._cache_ttl_seconds
        if ttl_seconds > 0:
            expired_keys = [
                run_id
                for run_id, (cached_at, _) in self._validated_params_cache.items()
                if now_value - cached_at > ttl_seconds
            ]
            for run_id in expired_keys:
                self._validated_params_cache.pop(run_id, None)
        max_entries = self._cache_max_entries
        if max_entries >= 0 and len(self._validated_params_cache) > max_entries:
            overflow = len(self._validated_params_cache) - max_entries
            oldest = sorted(self._validated_params_cache.items(), key=lambda item: item[1][0])[
                :overflow
            ]
            for run_id, _ in oldest:
                self._validated_params_cache.pop(run_id, None)

    def _read_non_negative_int_env(self, key: str, default: int) -> int:
        raw = os.getenv(key, str(default)).strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            return default
        return max(0, value)

    def _claim_run_for_resume(
        self, run_id: str, actor: str | None, otp_value: str
    ) -> tuple[RunRecord, RunStatus]:
        return resume_ops.claim_run_for_resume(self, run_id, actor, otp_value)

    def _mark_run_resume_failed(self, run_id: str, message: str) -> RunRecord:
        return resume_ops.mark_run_resume_failed(self, run_id, message)

    def _sync_run_status(self, run: RunRecord) -> None:
        run_ops.sync_run_status(self, run)

    def _map_task_status(self, task_status: str) -> RunStatus:
        return run_ops.map_task_status(task_status)

    def _build_env(
        self, start_url: str, params: dict[str, str], otp_code: str | None
    ) -> dict[str, str]:
        return run_ops.build_env(
            start_url,
            params,
            otp_code,
            stripe_param_keys=self._STRIPE_PARAM_KEYS,
            is_secret_param_key=self._is_secret_param_key,
        )

    def _resolve_otp_code(self, otp: OtpPolicy, manual_code: str | None) -> str | None:
        return run_ops.resolve_otp_code(otp, manual_code)

    def _score_flow(self, steps: list[dict[str, Any]]) -> int:
        if not steps:
            return 0
        with_selector = 0
        for step in steps:
            target = step.get("target") if isinstance(step, dict) else None
            selectors = target.get("selectors") if isinstance(target, dict) else None
            if isinstance(selectors, list) and selectors:
                with_selector += 1
        return int((with_selector / max(1, len(steps))) * 100)

    def _validate_params(
        self, template: TemplateRecord, params: dict[str, str], otp: OtpPolicy
    ) -> None:
        params_ops.validate_params(template, params, otp)

    def _sanitize_defaults(
        self,
        params_schema: list[dict[str, Any] | TemplateParamSpec],
        defaults: dict[str, str],
    ) -> dict[str, str]:
        return params_ops.sanitize_defaults(params_schema, defaults)

    def _export_scrubbed_defaults(self, template: TemplateRecord) -> dict[str, str]:
        return params_ops.export_scrubbed_defaults(template)

    def _public_params(self, template: TemplateRecord, params: dict[str, str]) -> dict[str, str]:
        return params_ops.public_params(template, params, self._SENSITIVE_PARAM_KEYS)

    def _is_secret_param_key(self, key: str) -> bool:
        return params_ops.is_secret_param_key(key, self._SENSITIVE_PARAM_KEYS)

    def _normalize_session_mode(self, mode: str) -> str:
        normalized = mode.strip().lower()
        return self._SESSION_MODE_ALIAS.get(normalized, normalized)

    def _extract_progress(self, output_tail: str) -> tuple[int, list[RunLogEntry]]:
        cursor, logs, _wait_context = run_ops.extract_progress(
            output_tail, redact_text=self._redact_text
        )
        return cursor, logs

    def _extract_wait_context(self, payload: dict[str, Any]) -> RunWaitContext | None:
        return run_ops.extract_wait_context(payload)

    def _resolve_resume_from_step_id(self, wait_context: RunWaitContext | None) -> str | None:
        return run_ops.resolve_resume_from_step_id(wait_context)

    def _coerce_optional_text(self, *candidates: Any) -> str | None:
        return run_ops.coerce_optional_text(*candidates)

    def _coerce_optional_bool(self, *candidates: Any) -> bool | None:
        return run_ops.coerce_optional_bool(*candidates)

    def _append_unique_logs(self, run: RunRecord, entries: list[RunLogEntry]) -> None:
        run_ops.append_unique_logs(run, entries)

    def _read_json(self, path: Path) -> list[dict[str, Any]]:
        if path == self._runs_path:
            with self._runs_file_lock():
                return self._read_json_unlocked(path)
        return self._read_json_unlocked(path)

    def _read_json_unlocked(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
        return []

    def _write_json(self, path: Path, payload: list[dict[str, Any]]) -> None:
        if path == self._runs_path:
            with self._runs_file_lock():
                self._write_json_unlocked(path, payload)
            return
        self._write_json_unlocked(path, payload)

    def _write_json_unlocked(self, path: Path, payload: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    @contextmanager
    def _runs_file_lock(self):
        self._runs_file_lock_path.parent.mkdir(parents=True, exist_ok=True)
        if fcntl is None:
            yield
            return
        with self._runs_file_lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _read_positive_int_env(self, key: str, *, default: int, minimum: int = 1) -> int:
        raw = env_str(key, "").strip()
        try:
            parsed = int(raw) if raw else default
        except ValueError:
            parsed = default
        return max(minimum, parsed)

    def _rotate_audit_if_needed(self, incoming_bytes: int) -> None:
        current_size = self._audit_path.stat().st_size if self._audit_path.exists() else 0
        if current_size + max(0, incoming_bytes) <= self._audit_max_bytes:
            return
        oldest = self._audit_path.with_name(f"{self._audit_path.name}.{self._audit_backup_count}")
        if oldest.exists():
            oldest.unlink()
        for idx in range(self._audit_backup_count - 1, 0, -1):
            source = self._audit_path.with_name(f"{self._audit_path.name}.{idx}")
            target = self._audit_path.with_name(f"{self._audit_path.name}.{idx + 1}")
            if source.exists():
                source.replace(target)
        if self._audit_path.exists():
            self._audit_path.replace(self._audit_path.with_name(f"{self._audit_path.name}.1"))

    def _prune_audit_history(self) -> None:
        cutoff_ts = datetime.now(UTC).timestamp() - (self._audit_retention_days * 24 * 60 * 60)
        candidates = [self._audit_path]
        for idx in range(1, self._audit_backup_count + 1):
            candidates.append(self._audit_path.with_name(f"{self._audit_path.name}.{idx}"))
        for candidate in candidates:
            if not candidate.exists():
                continue
            if candidate.stat().st_mtime < cutoff_ts:
                candidate.unlink()

    def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
        line = json.dumps(
            {
                "ts": datetime.now(UTC).isoformat(),
                "request_id": REQUEST_ID_CTX.get(),
                "trace_id": TRACE_ID_CTX.get(),
                "component": "automation.universal",
                "evidenceClass": "log",
                "event": action,
                "status": "ok",
                "action": action,
                "actor": actor or "anonymous",
                "payload": self._redact_payload(payload),
            },
            ensure_ascii=False,
        )
        incoming_bytes = len((line + "\n").encode("utf-8"))
        with self._audit_lock:
            try:
                self._audit_path.parent.mkdir(parents=True, exist_ok=True)
                self._rotate_audit_if_needed(incoming_bytes)
                with self._audit_path.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
                self._prune_audit_history()
            except OSError as exc:
                self._audit_write_failures += 1
                print(
                    f"[universal-audit] write failed (count={self._audit_write_failures}): {exc}",
                    file=sys.stderr,
                )

    def _redact_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        return secrets_ops.redact_payload(payload, self._redact_text)

    def _redact_text(self, value: str) -> str:
        return secrets_ops.redact_text(value, self._SENSITIVE_LOG_PATTERNS)

    def _ensure_allowed_param_keys(
        self, params_schema: list[TemplateParamSpec], params: dict[str, str], *, source: str
    ) -> None:
        params_ops.ensure_allowed_param_keys(params_schema, params, source=source)

    def _get_session(self, session_id: str) -> SessionRecord | None:
        for item in self._read_json(self._sessions_path):
            if item.get("session_id") == session_id:
                return SessionRecord.model_validate(item)
        return None

    def _ensure_session_access(self, session: SessionRecord, requester: str | None) -> None:
        if requester is None:
            return
        if session.owner != requester:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="session access denied"
            )

    def _flow_owner(self, flow: FlowRecord) -> str | None:
        session = self._get_session(flow.session_id)
        return session.owner if session else None

    def _ensure_flow_access(self, flow: FlowRecord, requester: str | None) -> None:
        if requester is None:
            return
        owner = self._flow_owner(flow)
        if owner != requester:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="flow access denied")

    def _template_owner(self, template: TemplateRecord) -> str | None:
        if template.created_by:
            return template.created_by
        flow = self.get_flow(template.flow_id)
        return self._flow_owner(flow)

    def _ensure_template_access(self, template: TemplateRecord, requester: str | None) -> None:
        if requester is None:
            return
        owner = self._template_owner(template)
        if owner != requester:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="template access denied"
            )

    def _run_owner(self, run: RunRecord) -> str | None:
        try:
            template = self.get_template(run.template_id)
            return self._template_owner(template)
        except HTTPException:
            for item in self._read_json(self._runs_path):
                if item.get("run_id") != run.run_id:
                    continue
                owner = item.get(self._run_owner_key)
                return owner if isinstance(owner, str) else None
            return None

    def _is_within_runtime_root(self, path: Path) -> bool:
        try:
            return path.resolve().is_relative_to(self._runtime_root.resolve())
        except ValueError:
            return False

    def _upsert_session_from_import(
        self, *, session_id: str, start_url: str, owner: str | None
    ) -> None:
        now = datetime.now(UTC)
        with self._lock:
            sessions = self._read_json(self._sessions_path)
            for idx, item in enumerate(sessions):
                if item.get("session_id") != session_id:
                    continue
                model = SessionRecord.model_validate(item)
                if owner and model.owner != owner:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN, detail="session access denied"
                    )
                sessions[idx] = model.model_dump(mode="json")
                self._write_json(self._sessions_path, sessions)
                return
            model = SessionRecord(
                session_id=session_id,
                start_url=start_url,
                mode="manual",
                owner=owner,
                started_at=now,
            )
            sessions.append(model.model_dump(mode="json"))
            self._write_json(self._sessions_path, sessions)


universal_platform_service = UniversalPlatformService()
