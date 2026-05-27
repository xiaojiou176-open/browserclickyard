from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.models.automation import (
    ProfileResolveResponse,
    ReconstructionGenerateResponse,
    ReconstructionPreviewResponse,
)

from .generation import calculate_quality
from .types import ResolvedArtifacts
from .validation import unsupported_reason


def build_profile_response(
    artifacts: ResolvedArtifacts, signals: list[str]
) -> ProfileResolveResponse:
    dom_alignment_score = 0.9 if artifacts.html_content else 0.2
    har_alignment_score = 0.9 if artifacts.har_entries else 0.15
    profile = "api-centric" if artifacts.har_entries else "ui-centric"
    checkpoints: list[str] = []
    if signals:
        checkpoints.append("manual_gate: verify anti-bot checkpoint before replay")
    if not artifacts.har_entries:
        checkpoints.append("manual_checkpoint: missing HAR entries")
    if not artifacts.html_content:
        checkpoints.append("manual_checkpoint: missing HTML snapshot")
    return ProfileResolveResponse(
        profile=profile,
        video_signals=signals,
        dom_alignment_score=round(dom_alignment_score, 3),
        har_alignment_score=round(har_alignment_score, 3),
        recommended_manual_checkpoints=checkpoints,
        manual_handoff_required=bool(signals),
        unsupported_reason=unsupported_reason(signals),
    )


def build_preview_response(
    preview_id: str,
    artifacts: ResolvedArtifacts,
    steps: list[dict[str, Any]],
    signals: list[str],
    action_endpoint: dict[str, Any] | None,
    bootstrap_sequence: list[dict[str, str]],
    generator_outputs: dict[str, str],
) -> ReconstructionPreviewResponse:
    unresolved_segments: list[str] = []
    for step in steps:
        if float(step.get("confidence", 0.0)) < 0.78:
            unresolved_segments.append(f"low-confidence:{step.get('step_id')}")

    manual_handoff_required = bool(signals)
    reason = unsupported_reason(signals)
    flow_steps = list(steps)
    if manual_handoff_required:
        flow_steps.append(
            {
                "step_id": f"s{len(flow_steps) + 1}",
                "action": "manual_gate",
                "confidence": 1.0,
                "source_engine": "compliance",
                "evidence_ref": "policy:manual_gate",
                "manual_handoff_required": True,
                "unsupported_reason": reason,
            }
        )
        unresolved_segments.append("manual_gate")

    flow_draft = {
        "flow_id": f"fl_{uuid4().hex}",
        "session_id": artifacts.session_dir.name,
        "start_url": artifacts.start_url,
        "source_event_count": len(artifacts.har_entries),
        "generated_at": datetime.now(UTC).isoformat(),
        "steps": flow_steps,
        "action_endpoint": action_endpoint,
        "bootstrap_sequence": bootstrap_sequence,
    }
    return ReconstructionPreviewResponse(
        preview_id=preview_id,
        flow_draft=flow_draft,
        reconstructed_flow_quality=calculate_quality(flow_steps),
        step_confidence=[float(step.get("confidence", 0.0)) for step in flow_steps],
        unresolved_segments=unresolved_segments,
        manual_handoff_required=manual_handoff_required,
        unsupported_reason=reason,
        generator_outputs=generator_outputs,
    )


def build_generate_response(
    preview: ReconstructionPreviewResponse,
    generated_paths: dict[str, str],
) -> ReconstructionGenerateResponse:
    flow = preview.flow_draft
    return ReconstructionGenerateResponse(
        flow_id=str(flow.get("flow_id") or f"fl_{uuid4().hex}"),
        template_id=f"tp_{uuid4().hex}",
        run_id=None,
        generator_outputs=generated_paths,
        reconstructed_flow_quality=preview.reconstructed_flow_quality,
        step_confidence=preview.step_confidence,
        unresolved_segments=preview.unresolved_segments,
        manual_handoff_required=preview.manual_handoff_required,
        unsupported_reason=preview.unsupported_reason,
    )
