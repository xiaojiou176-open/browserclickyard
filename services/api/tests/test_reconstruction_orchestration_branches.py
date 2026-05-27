from __future__ import annotations

from pathlib import Path

from app.services.video_reconstruction.orchestration import (
    build_generate_response,
    build_preview_response,
    build_profile_response,
)
from app.services.video_reconstruction.types import ResolvedArtifacts


def _artifacts(
    tmp_path: Path,
    *,
    html_content: str = "<main>snapshot</main>",
    har_entries: list[dict[str, object]] | None = None,
) -> ResolvedArtifacts:
    return ResolvedArtifacts(
        start_url="https://example.com/register",
        session_dir=tmp_path / "session-001",
        video_path=None,
        har_path=None,
        html_path=None,
        html_content=html_content,
        har_entries=har_entries or [],
    )


def test_build_profile_response_adds_manual_checkpoints_for_missing_artifacts(
    tmp_path: Path,
) -> None:
    response = build_profile_response(
        _artifacts(tmp_path, html_content="", har_entries=[]), ["captcha"]
    )

    assert response.profile == "ui-centric"
    assert response.manual_handoff_required is True
    assert response.dom_alignment_score == 0.2
    assert response.har_alignment_score == 0.15
    assert response.recommended_manual_checkpoints == [
        "manual_gate: verify anti-bot checkpoint before replay",
        "manual_checkpoint: missing HAR entries",
        "manual_checkpoint: missing HTML snapshot",
    ]
    assert response.unsupported_reason == "manual gate required due to: captcha"


def test_build_profile_response_prefers_api_centric_when_har_is_present(tmp_path: Path) -> None:
    response = build_profile_response(
        _artifacts(tmp_path, har_entries=[{"url": "https://example.com/api/register"}]),
        [],
    )

    assert response.profile == "api-centric"
    assert response.manual_handoff_required is False
    assert response.recommended_manual_checkpoints == []
    assert response.unsupported_reason is None


def test_build_preview_response_appends_manual_gate_and_tracks_low_confidence(
    tmp_path: Path,
) -> None:
    preview = build_preview_response(
        "preview-001",
        _artifacts(tmp_path, har_entries=[{"url": "https://example.com/api/register"}]),
        steps=[
            {"step_id": "s1", "action": "navigate", "confidence": 0.95},
            {"step_id": "s2", "action": "click", "confidence": 0.42},
        ],
        signals=["otp"],
        action_endpoint={"method": "POST", "path": "/api/register"},
        bootstrap_sequence=[{"method": "GET", "path": "/api/csrf"}],
        generator_outputs={"playwright": "generated.spec.ts"},
    )

    assert preview.manual_handoff_required is True
    assert preview.unsupported_reason == "manual gate required due to: otp"
    assert preview.unresolved_segments == ["low-confidence:s2", "manual_gate"]
    assert preview.flow_draft["action_endpoint"] == {"method": "POST", "path": "/api/register"}
    assert preview.flow_draft["bootstrap_sequence"] == [{"method": "GET", "path": "/api/csrf"}]
    assert preview.flow_draft["steps"][-1]["action"] == "manual_gate"
    assert preview.flow_draft["steps"][-1]["manual_handoff_required"] is True
    assert preview.reconstructed_flow_quality == 79


def test_build_generate_response_falls_back_when_preview_flow_lacks_id() -> None:
    preview = build_preview_response(
        "preview-002",
        ResolvedArtifacts(
            start_url="https://example.com/register",
            session_dir=Path("session-002"),
            video_path=None,
            har_path=None,
            html_path=None,
            html_content="<main>snapshot</main>",
            har_entries=[],
        ),
        steps=[],
        signals=[],
        action_endpoint=None,
        bootstrap_sequence=[],
        generator_outputs={},
    )
    preview.flow_draft.pop("flow_id", None)

    generated = build_generate_response(preview, {"playwright": "generated.spec.ts"})

    assert generated.flow_id.startswith("fl_")
    assert generated.template_id.startswith("tp_")
    assert generated.generator_outputs == {"playwright": "generated.spec.ts"}
    assert generated.manual_handoff_required is False
