from __future__ import annotations

from app.core.settings import env_str
from app.core.runtime_paths import automation_runtime_root, repo_root

import copy
import os
import hashlib
import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status
from app.models.automation import ProfileResolveRequest
from app.models.automation import (
    ProfileResolveResponse,
    ReconstructionGenerateResponse,
    ReconstructionPreviewRequest,
    ReconstructionPreviewResponse,
)
from app.services.engine_adapters.gemini_adapter import GeminiExtractionInput
from app.services.engine_adapters import GeminiAdapter
from app.services.reconstruction.artifact_resolver import (
    resolve_artifacts as strict_resolve_artifacts,
    resolve_optional_path as strict_resolve_optional_path,
    safe_resolve_under,
)
from app.services.video_reconstruction.generation import (
    build_generated_api,
    build_generated_playwright,
    calculate_quality,
    derive_bootstrap_sequence,
    normalize_codegen_steps,
    pick_action_endpoint,
)
from app.services.video_reconstruction.io import (
    default_generator_outputs,
    discover_start_url,
    persist_preview,
    safe_recon_path,
)
from app.services.video_reconstruction.types import ResolvedArtifacts
from app.services.video_reconstruction.orchestration import (
    build_generate_response,
    build_preview_response,
    build_profile_response,
)
from app.services.video_reconstruction.validation import (
    detect_protection_signals,
    validate_preview_id,
)

_DEFAULT_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
_DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 3600
_DEFAULT_CONTEXT_CACHE_MAX_ENTRIES = 256
_DEFAULT_MEDIA_RESOLUTION = "high"
_ALLOWED_MEDIA_RESOLUTIONS = {"low", "medium", "high", "native"}


@dataclass
class _ContextCacheEntry:
    steps: list[dict[str, Any]]
    expires_at: datetime


class _NoopAdapter:
    def extract_steps(self, payload: GeminiExtractionInput) -> list[dict[str, Any]]:
        _ = payload
        return []


class VideoReconstructionService:
    _PREVIEW_ID_RE = re.compile(r"^prv_[0-9a-f]{32}$")

    def __init__(self) -> None:
        self._root = repo_root()
        self._runtime_root = automation_runtime_root(self._root).resolve()
        self._default_runtime_root = (self._root / ".runtime-cache" / "automation").resolve()
        self._recon_root = self._runtime_root / "reconstruction"
        self._preview_dir = self._recon_root / "previews"
        self._generated_dir = self._recon_root / "generated"
        self._gemini = GeminiAdapter()
        self._lavague = _NoopAdapter()
        self._ui_tars = _NoopAdapter()
        self._openadapt = _NoopAdapter()
        self._context_cache_mode = self._resolve_context_cache_mode()
        self._context_cache_ttl_seconds = self._resolve_context_cache_ttl_seconds()
        self._context_cache_max_entries = self._resolve_context_cache_max_entries()
        self._context_cache_lock = Lock()
        self._context_cache: OrderedDict[str, _ContextCacheEntry] = OrderedDict()
        self._context_cache_stats: dict[str, int] = {
            "hits": 0,
            "misses": 0,
            "expired": 0,
            "writes": 0,
            "evictions": 0,
        }
        self._last_context_cache_event: dict[str, Any] = {
            "status": "none",
            "mode": self._context_cache_mode,
            "hit": False,
            "fallback": None,
            "key": None,
            "reason": None,
            "stats": dict(self._context_cache_stats),
        }

    def _artifact_max_bytes(self) -> int:
        raw = os.getenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", "").strip()
        if not raw:
            return _DEFAULT_ARTIFACT_MAX_BYTES
        try:
            value = int(raw)
        except ValueError:
            return _DEFAULT_ARTIFACT_MAX_BYTES
        return max(1, value)

    def _resolve_artifacts(self, artifacts: Any) -> ResolvedArtifacts:
        artifact_payload = (
            artifacts.model_dump() if hasattr(artifacts, "model_dump") else dict(artifacts or {})
        )
        runtime_root = self._select_runtime_root(artifact_payload)
        resolved = strict_resolve_artifacts(
            runtime_root=runtime_root,
            artifacts=artifact_payload,
            artifact_max_bytes=self._artifact_max_bytes(),
            discover_start_url=self._discover_start_url,
        )
        return ResolvedArtifacts(
            start_url=resolved.start_url,
            session_dir=resolved.session_dir,
            video_path=resolved.video_path,
            har_path=resolved.har_path,
            html_path=resolved.html_path,
            html_content=resolved.html_content,
            har_entries=resolved.har_entries,
        )

    def _resolve_optional_path(
        self,
        session_dir: Path,
        raw_path: Any,
        fallback_name: str,
        *,
        allowed_exts: set[str],
    ) -> Path | None:
        runtime_root = self._runtime_root_for_path(session_dir)
        return strict_resolve_optional_path(
            runtime_root=runtime_root,
            session_dir=session_dir,
            raw_path=raw_path,
            fallback_name=fallback_name,
            allowed_exts=allowed_exts,
            artifact_max_bytes=self._artifact_max_bytes(),
        )

    def _discover_start_url(self, har_entries: list[dict[str, Any]]) -> str | None:
        return discover_start_url(har_entries)

    def _calculate_quality(self, steps: list[dict[str, Any]]) -> int:
        return calculate_quality(steps)

    def _default_generator_outputs(self, preview_id: str) -> dict[str, str]:
        try:
            return default_generator_outputs(preview_id, self._PREVIEW_ID_RE, self._generated_dir)
        except Exception:
            target_dir = (self._generated_dir / preview_id).resolve()
            return {
                "flow_draft": str(target_dir / "flow-draft.json"),
                "playwright_spec": str(target_dir / "generated-playwright.spec.ts"),
                "api_spec": str(target_dir / "generated-api.spec.ts"),
                "readiness_report": str(target_dir / "run-readiness-report.json"),
            }

    def _pick_action_endpoint(self, har_entries: list[dict[str, Any]]) -> dict[str, Any] | None:
        return pick_action_endpoint(har_entries)

    def _derive_bootstrap_sequence(
        self,
        har_entries: list[dict[str, Any]],
        action_endpoint: dict[str, Any] | None,
    ) -> list[dict[str, str]]:
        return derive_bootstrap_sequence(har_entries, action_endpoint)

    def _normalize_codegen_steps(self, raw_steps: Any) -> list[dict[str, Any]]:
        return normalize_codegen_steps(raw_steps)

    def _build_generated_api(self, flow_draft: dict[str, Any]) -> str:
        return build_generated_api(flow_draft)

    def _materialize_generated_outputs(
        self, preview_id: str, flow_draft: dict[str, Any]
    ) -> dict[str, str]:
        output_paths = self._default_generator_outputs(preview_id)
        target_dir = Path(output_paths["flow_draft"]).resolve().parent
        target_dir.mkdir(parents=True, exist_ok=True)
        Path(output_paths["flow_draft"]).write_text(
            json.dumps(flow_draft, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        Path(output_paths["playwright_spec"]).write_text(
            build_generated_playwright(flow_draft), encoding="utf-8"
        )
        Path(output_paths["api_spec"]).write_text(build_generated_api(flow_draft), encoding="utf-8")
        steps = flow_draft.get("steps", [])
        manual_gate_reasons = [
            str(step.get("unsupported_reason"))
            for step in steps
            if isinstance(step, dict)
            and str(step.get("action") or "") == "manual_gate"
            and step.get("unsupported_reason")
        ]
        bootstrap_steps = flow_draft.get("bootstrap_sequence", [])
        action_endpoint = flow_draft.get("action_endpoint")
        manual_gate_reason_counts: dict[str, int] = {"cloudflare": 0, "captcha": 0, "otp": 0}
        manual_gate_stats_panel: dict[str, int] = {
            "total_manual_gate_steps": 0,
            "known_reason_code_hits": 0,
        }
        readiness_payload: dict[str, Any] = {
            "generated_at": datetime.now(UTC).isoformat(),
            "preview_id": preview_id,
            "flow_id": flow_draft.get("flow_id"),
            "step_count": len(steps) if isinstance(steps, list) else 0,
            "ready": True,
            "api_replay_ready": isinstance(action_endpoint, dict)
            and bool(action_endpoint.get("path")),
            "required_bootstrap_steps": len(bootstrap_steps)
            if isinstance(bootstrap_steps, list)
            else 0,
            "manual_gate_reasons": manual_gate_reasons,
            "replay_attempt": {"attempted": False, "success": None, "status": "not_attempted"},
            "replay_success_samples_7d": 0,
            "replay_success_rate_7d": None,
            "replay_sla": {"replay_success_samples_7d": 0, "replay_success_rate_7d": None},
            "manual_gate_reason_matrix": {"counts": manual_gate_reason_counts},
            "manual_gate_stats_panel": manual_gate_stats_panel,
        }
        for reason in manual_gate_reasons:
            lowered = reason.lower()
            for key in ("cloudflare", "captcha", "otp"):
                if key in lowered:
                    manual_gate_reason_counts[key] += 1
                    manual_gate_stats_panel["known_reason_code_hits"] += 1
        manual_gate_stats_panel["total_manual_gate_steps"] = len(manual_gate_reasons)
        Path(output_paths["readiness_report"]).write_text(
            json.dumps(readiness_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return output_paths

    def _resolve_context_cache_mode(self) -> str:
        value = os.getenv("GEMINI_CONTEXT_CACHE_MODE", "memory").strip().lower()
        return value if value in {"memory", "api"} else "memory"

    def _resolve_context_cache_ttl_seconds(self) -> int:
        raw = os.getenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "").strip()
        if not raw:
            return _DEFAULT_CONTEXT_CACHE_TTL_SECONDS
        try:
            return max(1, int(raw))
        except ValueError:
            return _DEFAULT_CONTEXT_CACHE_TTL_SECONDS

    def _resolve_context_cache_max_entries(self) -> int:
        raw = os.getenv("GEMINI_CONTEXT_CACHE_MAX_ENTRIES", "").strip()
        if not raw:
            return _DEFAULT_CONTEXT_CACHE_MAX_ENTRIES
        try:
            return max(1, int(raw))
        except ValueError:
            return _DEFAULT_CONTEXT_CACHE_MAX_ENTRIES

    def _prune_expired_context_cache_locked(
        self, now: datetime, *, exclude_key: str | None = None
    ) -> None:
        expired_keys = [
            key
            for key, entry in self._context_cache.items()
            if entry.expires_at <= now and key != exclude_key
        ]
        for key in expired_keys:
            self._context_cache.pop(key, None)
        if expired_keys:
            self._context_cache_stats["expired"] += len(expired_keys)

    def _evict_context_cache_if_needed_locked(self) -> None:
        while len(self._context_cache) > self._context_cache_max_entries:
            self._context_cache.popitem(last=False)
            self._context_cache_stats["evictions"] += 1

    @staticmethod
    def _normalize_media_resolution(raw: Any, fallback: str) -> str:
        normalized = str(raw or "").strip().lower()
        if normalized in _ALLOWED_MEDIA_RESOLUTIONS:
            return normalized
        return fallback

    def _compute_context_cache_key(
        self,
        artifacts: ResolvedArtifacts,
        mode: str,
        strategy: str,
        media_resolution_by_input: dict[str, str] | None,
    ) -> str:
        basis = {
            "mode": mode,
            "strategy": strategy,
            "start_url": artifacts.start_url,
            "har_entries": artifacts.har_entries,
            "html_hash": hashlib.sha256(artifacts.html_content.encode("utf-8")).hexdigest(),
            "media_resolution_by_input": media_resolution_by_input or {},
        }
        serialized = json.dumps(basis, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def _is_under(root: Path, candidate: Path) -> bool:
        try:
            candidate.resolve().relative_to(root.resolve())
            return True
        except ValueError:
            return False

    def _runtime_root_for_path(self, candidate: Path) -> Path:
        if self._is_under(self._runtime_root, candidate):
            return self._runtime_root
        if self._is_under(self._default_runtime_root, candidate):
            return self._default_runtime_root
        return self._runtime_root

    def _select_runtime_root(self, artifacts: dict[str, Any]) -> Path:
        session_dir_raw = str(artifacts.get("session_dir") or "").strip()
        if session_dir_raw:
            return self._runtime_root_for_path(Path(session_dir_raw))
        return self._runtime_root

    def _build_gemini_input(
        self, artifacts: ResolvedArtifacts, strategy: str
    ) -> GeminiExtractionInput:
        return GeminiExtractionInput(
            start_url=artifacts.start_url,
            har_entries=artifacts.har_entries,
            html_content=artifacts.html_content,
            extractor_strategy=strategy,
        )

    def _infer_input_type_for_step(self, step: dict[str, Any]) -> str:
        evidence_ref = str(step.get("evidence_ref") or "").lower()
        if evidence_ref.startswith("screenshot:") or evidence_ref.startswith("image:"):
            return "screenshot"
        if evidence_ref.startswith("pdf:") or evidence_ref.startswith("document:"):
            return "pdf"
        if evidence_ref.startswith("video:"):
            return "video"
        return "video"

    def _apply_media_resolution(
        self,
        steps: list[dict[str, Any]],
        media_resolution_by_input: dict[str, str] | None,
    ) -> list[dict[str, Any]]:
        if not media_resolution_by_input:
            return steps
        default_resolution = self._normalize_media_resolution(
            media_resolution_by_input.get("default"),
            _DEFAULT_MEDIA_RESOLUTION,
        )
        applied: list[dict[str, Any]] = []
        for step in steps:
            cloned = dict(step)
            input_type = self._infer_input_type_for_step(cloned)
            cloned["media_resolution"] = self._normalize_media_resolution(
                media_resolution_by_input.get(input_type),
                default_resolution,
            )
            applied.append(cloned)
        return applied

    def _normalize_preview_steps(self, steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for idx, step in enumerate(steps, start=1):
            item = {
                "step_id": str(step.get("step_id") or f"s{idx}"),
                "action": str(step.get("action") or "manual_gate"),
                "url": step.get("url"),
                "value_ref": step.get("value_ref"),
                "target": step.get("target") or {"selectors": []},
                "selected_selector_index": step.get("selected_selector_index"),
                "preconditions": step.get("preconditions") or [],
                "evidence_ref": step.get("evidence_ref"),
                "confidence": max(0.0, min(1.0, float(step.get("confidence", 0.0)))),
                "source_engine": str(step.get("source_engine") or "gemini"),
                "manual_handoff_required": bool(step.get("manual_handoff_required", False)),
                "unsupported_reason": step.get("unsupported_reason"),
            }
            if "media_resolution" in step:
                item["media_resolution"] = step.get("media_resolution")
            normalized.append(item)
        return normalized

    @staticmethod
    def _coerce_step_list(raw_steps: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_steps, list):
            return []
        normalized: list[dict[str, Any]] = []
        for item in raw_steps:
            if isinstance(item, dict):
                normalized.append(item)
        return normalized

    def _merge_ensemble_steps(self, candidates: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        merged: dict[str, dict[str, Any]] = {}
        for steps in candidates:
            for idx, step in enumerate(steps, start=1):
                step_id = str(step.get("step_id") or f"s{idx}")
                existing = merged.get(step_id)
                if existing is None or float(step.get("confidence", 0.0)) > float(
                    existing.get("confidence", 0.0)
                ):
                    merged[step_id] = dict(step, step_id=step_id)
        ordered = sorted(merged.values(), key=lambda item: str(item.get("step_id") or ""))
        return ordered

    def _extract_steps(
        self,
        artifacts: ResolvedArtifacts,
        mode: str,
        strategy: str,
        *,
        media_resolution_by_input: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        normalized_mode = mode.strip().lower()
        if normalized_mode == "ensemble":
            payload = self._build_gemini_input(artifacts, strategy)
            merged = self._merge_ensemble_steps(
                [
                    self._gemini.extract_steps(payload),
                    self._lavague.extract_steps(payload),
                    self._ui_tars.extract_steps(payload),
                    self._openadapt.extract_steps(payload),
                ]
            )
            return self._apply_media_resolution(merged, media_resolution_by_input)

        payload = self._build_gemini_input(artifacts, strategy)
        cache_key = self._compute_context_cache_key(
            artifacts, normalized_mode, strategy, media_resolution_by_input
        )

        if self._context_cache_mode == "api":
            cached_result = self._gemini.extract_steps_with_context_cache(
                payload,
                cache_key=cache_key,
                ttl_seconds=self._context_cache_ttl_seconds,
                media_resolution_by_input=media_resolution_by_input or {},
            )
            steps = self._coerce_step_list(cached_result.get("steps"))
            event = {
                "status": str(cached_result.get("status") or "api_miss"),
                "mode": "api",
                "hit": bool(cached_result.get("hit")),
                "fallback": cached_result.get("fallback"),
                "key": cache_key,
                "reason": cached_result.get("reason"),
                "stats": dict(self._context_cache_stats),
            }
            self._last_context_cache_event = event
            return self._apply_media_resolution(steps, media_resolution_by_input)

        now = datetime.now(UTC)
        cached_entry: _ContextCacheEntry | None = None
        expired = False
        with self._context_cache_lock:
            self._prune_expired_context_cache_locked(now, exclude_key=cache_key)
            existing = self._context_cache.get(cache_key)
            if existing is not None:
                if existing.expires_at > now:
                    cached_entry = existing
                    self._context_cache_stats["hits"] += 1
                    self._context_cache.move_to_end(cache_key)
                else:
                    self._context_cache.pop(cache_key, None)
                    expired = True
                    self._context_cache_stats["expired"] += 1
            if cached_entry is None:
                self._context_cache_stats["misses"] += 1

        if cached_entry is not None:
            self._last_context_cache_event = {
                "status": "hit",
                "mode": "memory",
                "hit": True,
                "fallback": None,
                "key": cache_key,
                "reason": None,
                "stats": dict(self._context_cache_stats),
            }
            return self._apply_media_resolution(
                copy.deepcopy(cached_entry.steps), media_resolution_by_input
            )

        steps = self._gemini.extract_steps(payload)
        expires_at = now + timedelta(seconds=self._context_cache_ttl_seconds)
        with self._context_cache_lock:
            self._prune_expired_context_cache_locked(now)
            if cache_key in self._context_cache:
                self._context_cache.pop(cache_key, None)
            self._context_cache[cache_key] = _ContextCacheEntry(
                steps=copy.deepcopy(steps), expires_at=expires_at
            )
            self._context_cache.move_to_end(cache_key)
            self._evict_context_cache_if_needed_locked()
            self._context_cache_stats["writes"] += 1
        self._last_context_cache_event = {
            "status": "expired_refill" if expired else "miss",
            "mode": "memory",
            "hit": False,
            "fallback": None,
            "key": cache_key,
            "reason": None,
            "stats": dict(self._context_cache_stats),
        }
        return self._apply_media_resolution(steps, media_resolution_by_input)

    def _resolve_media_resolution_policy(
        self,
        metadata: dict[str, Any],
        artifacts: ResolvedArtifacts,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        default_resolution = self._normalize_media_resolution(
            env_str("GEMINI_MEDIA_RESOLUTION_DEFAULT", _DEFAULT_MEDIA_RESOLUTION),
            _DEFAULT_MEDIA_RESOLUTION,
        )
        by_input_type: dict[str, str] = {}
        raw_policy = metadata.get("media_resolution")
        if isinstance(raw_policy, str) and raw_policy.strip():
            default_resolution = self._normalize_media_resolution(raw_policy, default_resolution)
        elif isinstance(raw_policy, dict):
            if isinstance(raw_policy.get("default"), str) and raw_policy.get("default"):
                default_resolution = self._normalize_media_resolution(
                    raw_policy["default"], default_resolution
                )
            for key, value in raw_policy.items():
                if key == "default" or not isinstance(value, str):
                    continue
                by_input_type[str(key).strip().lower()] = self._normalize_media_resolution(
                    value, default_resolution
                )
        pdf_resolution = metadata.get("media_resolution_pdf")
        if isinstance(pdf_resolution, str) and pdf_resolution.strip():
            by_input_type["pdf"] = self._normalize_media_resolution(
                pdf_resolution, default_resolution
            )

        detected: set[str] = set(by_input_type.keys())
        if artifacts.video_path is not None:
            detected.add("video")
        if (
            str(metadata.get("screenshot_before_path") or "").strip()
            or str(metadata.get("screenshot_after_path") or "").strip()
        ):
            detected.add("screenshot")
        if (
            str(metadata.get("document_path") or "").strip()
            or str(metadata.get("pdf_path") or "").strip()
        ):
            detected.add("pdf")

        resolved_by_input: dict[str, str] = {}
        for input_type in detected:
            resolved_by_input[input_type] = by_input_type.get(input_type, default_resolution)
        policy = {
            "default": default_resolution,
            "by_input_type": resolved_by_input,
            "detected_input_types": sorted(detected),
        }
        return policy, resolved_by_input

    def resolve_profile(self, payload: ProfileResolveRequest) -> ProfileResolveResponse:
        artifacts = self._resolve_artifacts(payload.artifacts)
        signals = detect_protection_signals(artifacts)
        return build_profile_response(artifacts, signals)

    def preview(self, payload: ReconstructionPreviewRequest) -> ReconstructionPreviewResponse:
        artifacts = self._resolve_artifacts(payload.artifacts)
        signals = detect_protection_signals(artifacts)
        metadata = (
            payload.artifacts.metadata if isinstance(payload.artifacts.metadata, dict) else {}
        )
        media_resolution_policy, media_resolution_by_input = self._resolve_media_resolution_policy(
            metadata, artifacts
        )
        steps = self._extract_steps(
            artifacts,
            payload.video_analysis_mode,
            payload.extractor_strategy,
            media_resolution_by_input=media_resolution_by_input,
        )
        steps = self._apply_media_resolution(steps, media_resolution_by_input)
        normalized_steps = self._normalize_preview_steps(steps)

        preview_id = f"prv_{uuid4().hex}"
        generator_outputs = self._default_generator_outputs(preview_id)
        action_endpoint = self._pick_action_endpoint(artifacts.har_entries)
        bootstrap_sequence = self._derive_bootstrap_sequence(artifacts.har_entries, action_endpoint)

        response = build_preview_response(
            preview_id=preview_id,
            artifacts=artifacts,
            steps=normalized_steps,
            signals=signals,
            action_endpoint=action_endpoint,
            bootstrap_sequence=bootstrap_sequence,
            generator_outputs=generator_outputs,
        )
        response.flow_draft["media_resolution_policy"] = media_resolution_policy
        response.flow_draft["context_cache"] = dict(self._last_context_cache_event)
        persist_preview(self._preview_dir, response.preview_id, response.model_dump(mode="json"))
        return response

    def load_preview(self, preview_id: str) -> ReconstructionPreviewResponse:
        validate_preview_id(preview_id, self._PREVIEW_ID_RE)
        preview_path = safe_recon_path(self._preview_dir, f"{preview_id}.json")
        try:
            raw = json.loads(preview_path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="preview not found"
            ) from exc
        return ReconstructionPreviewResponse.model_validate(raw)

    def generate(self, preview: ReconstructionPreviewResponse) -> ReconstructionGenerateResponse:
        generated_paths = self._materialize_generated_outputs(
            preview.preview_id, preview.flow_draft
        )
        return build_generate_response(preview, generated_paths)


video_reconstruction_service = VideoReconstructionService()

__all__ = [
    "VideoReconstructionService",
    "video_reconstruction_service",
    "ResolvedArtifacts",
    "safe_resolve_under",
]
