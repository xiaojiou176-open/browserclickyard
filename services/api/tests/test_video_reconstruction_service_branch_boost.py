from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest

import app.services.video_reconstruction_service as service_module
from app.models.automation import (
    ProfileResolveRequest,
    ReconstructionArtifactsRequest,
    ReconstructionPreviewResponse,
)
from app.services.video_reconstruction_service import (
    ResolvedArtifacts,
    VideoReconstructionService,
)


def _new_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> VideoReconstructionService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    return VideoReconstructionService()


def _resolved_artifacts(
    service: VideoReconstructionService, *, include_video: bool
) -> ResolvedArtifacts:
    session_dir = service._runtime_root / "session"
    session_dir.mkdir(parents=True, exist_ok=True)
    video_path = None
    if include_video:
        video_path = session_dir / "recording.mp4"
        video_path.write_bytes(b"video")
    return ResolvedArtifacts(
        start_url="https://example.com",
        session_dir=session_dir,
        video_path=video_path,
        har_path=None,
        html_path=None,
        html_content="<html><body>capture</body></html>",
        har_entries=[{"method": "POST", "url": "https://example.com/api/register", "status": 201}],
    )


def test_env_fallbacks_and_noop_adapter_branch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", raising=False)
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "invalid")
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_MAX_ENTRIES", "invalid")
    service = _new_service(monkeypatch, tmp_path)

    assert service._context_cache_ttl_seconds == 3600
    assert service._context_cache_max_entries == 256
    assert service._artifact_max_bytes() == 16 * 1024 * 1024

    monkeypatch.setenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", "not-a-number")
    assert service._artifact_max_bytes() == 16 * 1024 * 1024
    assert service._lavague.extract_steps(cast(Any, object())) == []


def test_resolve_artifacts_uses_runtime_root_and_model_dump(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    session_dir = service._runtime_root / "session-model"
    video_path = session_dir / "recording.mp4"
    session_dir.mkdir(parents=True, exist_ok=True)
    video_path.write_bytes(b"video")

    class _ArtifactsPayload:
        def model_dump(self) -> dict[str, Any]:
            return {
                "session_dir": str(session_dir),
                "video_path": str(video_path),
                "html_content": "<html>dump</html>",
            }

    class _Resolved:
        def __init__(self) -> None:
            self.start_url = "https://example.com"
            self.session_dir = session_dir
            self.video_path = video_path
            self.har_path = None
            self.html_path = None
            self.html_content = "<html>dump</html>"
            self.har_entries = [{"url": "https://example.com"}]

    captured: dict[str, Any] = {}

    def _fake_resolve_artifacts(
        *,
        runtime_root: Path,
        artifacts: dict[str, Any],
        artifact_max_bytes: int,
        discover_start_url: Any,
    ) -> _Resolved:
        captured["runtime_root"] = runtime_root
        captured["artifacts"] = dict(artifacts)
        captured["artifact_max_bytes"] = artifact_max_bytes
        captured["discover_start_url"] = discover_start_url
        return _Resolved()

    monkeypatch.setattr(service_module, "strict_resolve_artifacts", _fake_resolve_artifacts)

    resolved = service._resolve_artifacts(_ArtifactsPayload())
    assert resolved.start_url == "https://example.com"
    assert resolved.session_dir == session_dir
    assert resolved.video_path == video_path
    assert captured["runtime_root"] == service._runtime_root
    assert captured["artifacts"]["session_dir"] == str(session_dir)
    assert captured["artifact_max_bytes"] == 16 * 1024 * 1024


def test_runtime_root_and_media_policy_branch_expansion(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    outside = tmp_path / "outside" / "entry"
    default_candidate = service._default_runtime_root / "session-default"

    assert service._is_under(service._runtime_root, outside) is False
    assert service._runtime_root_for_path(default_candidate) == service._default_runtime_root
    assert service._runtime_root_for_path(outside) == service._runtime_root
    assert service._select_runtime_root({"session_dir": str(default_candidate)}) == (
        service._default_runtime_root
    )
    assert service._select_runtime_root({}) == service._runtime_root

    no_video_artifacts = _resolved_artifacts(service, include_video=False)
    policy, resolved = service._resolve_media_resolution_policy(
        {
            "media_resolution": "MEDIUM",
            "media_resolution_pdf": "native",
            "screenshot_before_path": "shots/before.png",
            "document_path": "docs/manual.pdf",
        },
        no_video_artifacts,
    )
    assert policy["default"] == "medium"
    assert "video" not in policy["detected_input_types"]
    assert resolved["screenshot"] == "medium"
    assert resolved["pdf"] == "native"


def test_materialize_generated_outputs_tracks_manual_gate_reason_codes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    preview_id = "prv_" + "b" * 32
    flow_draft = {
        "flow_id": "flow-manual-gate",
        "steps": [
            {"step_id": "s1", "action": "manual_gate", "unsupported_reason": "Cloudflare block"},
            {"step_id": "s2", "action": "manual_gate", "unsupported_reason": "captcha check"},
            {"step_id": "s3", "action": "manual_gate", "unsupported_reason": "otp challenge"},
            {"step_id": "s4", "action": "manual_gate", "unsupported_reason": "needs review"},
        ],
        "bootstrap_sequence": [],
        "action_endpoint": {"path": "/api/replay"},
    }

    outputs = service._materialize_generated_outputs(preview_id, flow_draft)
    readiness = json.loads(Path(outputs["readiness_report"]).read_text(encoding="utf-8"))
    counts = readiness["manual_gate_reason_matrix"]["counts"]
    stats = readiness["manual_gate_stats_panel"]

    assert counts == {"cloudflare": 1, "captcha": 1, "otp": 1}
    assert stats["known_reason_code_hits"] == 3
    assert stats["total_manual_gate_steps"] == 4


def test_extract_steps_replaces_stale_cache_entry_and_coerces_steps(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service, include_video=True)
    policy = {"video": "native"}
    cache_key = service._compute_context_cache_key(artifacts, "gemini", "balanced", policy)

    def _fake_extract(_payload: object) -> list[dict[str, Any]]:
        with service._context_cache_lock:
            service._context_cache[cache_key] = service_module._ContextCacheEntry(
                steps=[{"step_id": "old"}],
                expires_at=datetime.now(UTC) + timedelta(minutes=1),
            )
        return [{"step_id": "fresh", "action": "navigate", "evidence_ref": "video:entry"}]

    monkeypatch.setattr(service._gemini, "extract_steps", _fake_extract)

    steps = service._extract_steps(
        artifacts, "gemini", "balanced", media_resolution_by_input=policy
    )
    assert steps[0]["step_id"] == "fresh"
    assert service._coerce_step_list("not-a-list") == []
    assert service._coerce_step_list([{"step_id": "ok"}, "ignore-me"]) == [{"step_id": "ok"}]

    with service._context_cache_lock:
        assert service._context_cache[cache_key].steps[0]["step_id"] == "fresh"


def test_resolve_profile_and_load_preview_happy_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service, include_video=True)

    monkeypatch.setattr(service, "_resolve_artifacts", lambda _artifacts: artifacts)
    monkeypatch.setattr(service_module, "detect_protection_signals", lambda _artifacts: ["otp"])
    monkeypatch.setattr(
        service_module,
        "build_profile_response",
        lambda _artifacts, _signals: service_module.ProfileResolveResponse(
            profile="manual-check",
            video_signals=["otp"],
            dom_alignment_score=0.0,
            har_alignment_score=0.0,
            recommended_manual_checkpoints=["checkpoint"],
            manual_handoff_required=True,
            unsupported_reason="otp",
        ),
    )

    profile = service.resolve_profile(
        ProfileResolveRequest(artifacts=ReconstructionArtifactsRequest())
    )
    assert profile.profile == "manual-check"
    assert profile.video_signals == ["otp"]

    preview_id = "prv_" + "a" * 32
    preview = ReconstructionPreviewResponse(
        preview_id=preview_id,
        flow_draft={"steps": []},
        reconstructed_flow_quality=0,
    )
    service._preview_dir.mkdir(parents=True, exist_ok=True)
    (service._preview_dir / f"{preview_id}.json").write_text(
        json.dumps(preview.model_dump(mode="json"), ensure_ascii=False),
        encoding="utf-8",
    )

    loaded = service.load_preview(preview_id)
    assert loaded.preview_id == preview_id
    assert loaded.flow_draft["steps"] == []
