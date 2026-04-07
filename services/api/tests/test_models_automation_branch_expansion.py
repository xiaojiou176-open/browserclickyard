from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

import pytest
from pydantic import ValidationError

from app.models.automation import (
    EvidenceTimelineResponse,
    FlowPreviewResponse,
    OrchestrateFromArtifactsRequest,
    ReconstructionArtifactsRequest,
    RunCommandParams,
    RunCommandRequest,
    SelectorAttemptResponse,
    StepEvidenceResponse,
    TaskSnapshot,
)


def test_run_command_request_supports_command_id_alias_and_property() -> None:
    payload = RunCommandRequest.model_validate({"command_id": "script-pipeline-capture"})

    assert payload.command == "script-pipeline-capture"
    assert payload.command_id == "script-pipeline-capture"


def test_run_command_request_resolved_params_prefers_params_over_env() -> None:
    payload = RunCommandRequest(
        command="script-pipeline-capture",
        params=RunCommandParams(BASE_URL="https://params.example.com", FLOW_STEP_ID="step-2"),
        env={
            "BASE_URL": "https://env.example.com",
            "SUCCESS_SELECTOR": "#done",
        },
    )

    assert payload.resolved_params == {
        "BASE_URL": "https://params.example.com",
        "FLOW_STEP_ID": "step-2",
        "SUCCESS_SELECTOR": "#done",
    }


def test_run_command_request_resolved_params_handles_none_values() -> None:
    payload = RunCommandRequest(command="script-pipeline-capture")

    assert payload.resolved_params == {}


def test_run_command_request_validate_env_accepts_explicit_none() -> None:
    payload = RunCommandRequest(command="script-pipeline-capture", env=None)

    assert payload.env is None


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({f"K{i}": "v" for i in range(33)}, "env exceeds max key count (32)"),
        ({"k" * 65: "v"}, "env key exceeds max length (64)"),
        ({"KEY": "v" * 2049}, "env value exceeds max length (2048)"),
    ],
)
def test_run_command_request_validate_env_rejects_invalid_inputs(
    env: dict[str, str], message: str
) -> None:
    with pytest.raises(ValidationError) as exc_info:
        RunCommandRequest(command="script-pipeline-capture", env=env)

    assert message in str(exc_info.value)


def test_run_command_params_accepts_alias_and_field_name_inputs() -> None:
    params = RunCommandParams.model_validate(
        {"BASE_URL": "https://alias.example.com", "flow_step_id": "step-9"}
    )

    assert params.base_url == "https://alias.example.com"
    assert params.flow_step_id == "step-9"
    assert params.to_env_dict() == {
        "BASE_URL": "https://alias.example.com",
        "FLOW_STEP_ID": "step-9",
    }


def test_run_command_params_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        RunCommandParams.model_validate({"UNKNOWN_FIELD": "x"})


def test_run_command_params_rejects_non_string_values() -> None:
    with pytest.raises(ValidationError):
        RunCommandParams.model_validate({"FLOW_SELECTOR_INDEX": 3})


def test_task_snapshot_fills_command_from_legacy_command_id() -> None:
    created_at = datetime(2025, 1, 1, tzinfo=UTC)
    snapshot = TaskSnapshot(
        task_id="task-1",
        command_id="script-pipeline-capture",
        status="queued",
        created_at=created_at,
        updated_at=created_at,
    )

    assert snapshot.command == "script-pipeline-capture"
    assert snapshot.command_id == "script-pipeline-capture"


def test_task_snapshot_fills_missing_command_id_from_command() -> None:
    created_at = datetime(2025, 1, 1, tzinfo=UTC)
    snapshot = TaskSnapshot(
        task_id="task-2",
        command="script-pipeline-full-midscene",
        status="running",
        created_at=created_at,
        updated_at=created_at,
    )

    assert snapshot.command == "script-pipeline-full-midscene"
    assert snapshot.command_id == "script-pipeline-full-midscene"


@pytest.mark.parametrize(
    ("started_at", "finished_at", "expected"),
    [
        (None, None, datetime(2025, 1, 1, tzinfo=UTC)),
        (datetime(2025, 1, 2, tzinfo=UTC), None, datetime(2025, 1, 2, tzinfo=UTC)),
        (
            datetime(2025, 1, 2, tzinfo=UTC),
            datetime(2025, 1, 3, tzinfo=UTC),
            datetime(2025, 1, 3, tzinfo=UTC),
        ),
    ],
)
def test_task_snapshot_populates_updated_at_in_priority_order(
    started_at: datetime | None, finished_at: datetime | None, expected: datetime
) -> None:
    created_at = datetime(2025, 1, 1, tzinfo=UTC)
    snapshot = TaskSnapshot.model_validate(
        {
            "task_id": "task-updated",
            "command": "script-pipeline-capture",
            "status": "queued",
            "created_at": created_at,
            "started_at": started_at,
            "finished_at": finished_at,
        }
    )

    assert snapshot.updated_at == expected


def test_task_snapshot_model_validator_handles_non_dict_input() -> None:
    marker = object()

    validated = cast(Any, TaskSnapshot.fill_legacy_fields)(marker)

    assert validated is marker


def test_orchestrate_request_accepts_auto_refine_iterations_in_range() -> None:
    request = OrchestrateFromArtifactsRequest(
        artifacts=ReconstructionArtifactsRequest(),
        auto_refine_iterations=3,
    )

    assert request.auto_refine_iterations == 3


@pytest.mark.parametrize("iterations", [0, 11])
def test_orchestrate_request_rejects_auto_refine_iterations_out_of_range(iterations: int) -> None:
    with pytest.raises(ValidationError):
        OrchestrateFromArtifactsRequest(
            artifacts=ReconstructionArtifactsRequest(),
            auto_refine_iterations=iterations,
        )


@pytest.mark.parametrize("create_run", [0, 1, "false", "true"])
def test_orchestrate_request_rejects_non_boolean_create_run(create_run: object) -> None:
    with pytest.raises(ValidationError):
        OrchestrateFromArtifactsRequest.model_validate(
            {
                "artifacts": ReconstructionArtifactsRequest().model_dump(mode="json"),
                "create_run": create_run,
            }
        )


@pytest.mark.parametrize("field_name", ["session_dir", "video_path", "har_path", "html_path"])
def test_reconstruction_artifacts_request_rejects_null_byte_path(field_name: str) -> None:
    with pytest.raises(ValidationError):
        ReconstructionArtifactsRequest.model_validate({field_name: "bad\x00path"})


@pytest.mark.parametrize("field_name", ["session_dir", "video_path", "har_path", "html_path"])
def test_reconstruction_artifacts_request_rejects_blank_path(field_name: str) -> None:
    with pytest.raises(ValidationError):
        ReconstructionArtifactsRequest.model_validate({field_name: "   "})


def test_default_factories_create_independent_containers() -> None:
    step_a = StepEvidenceResponse(step_id="s1")
    step_b = StepEvidenceResponse(step_id="s2")
    step_a.fallback_trail.append(SelectorAttemptResponse(kind="css", value="#submit", success=True))

    artifacts_a = ReconstructionArtifactsRequest()
    artifacts_b = ReconstructionArtifactsRequest()
    artifacts_a.metadata["k"] = "v"

    timeline = EvidenceTimelineResponse()
    preview = FlowPreviewResponse()

    assert step_b.fallback_trail == []
    assert artifacts_b.metadata == {}
    assert timeline.items == []
    assert preview.steps == []
    assert preview.step_count == 0
    assert preview.source_event_count == 0
