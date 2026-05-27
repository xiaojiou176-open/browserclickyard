from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from typing import Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)

TaskStatus = Literal["queued", "running", "success", "failed", "cancelled"]
ArtifactSessionDir = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=192, pattern=r"^[^\x00-\x1F\x7F]*[\\/][^\x00-\x1F\x7F]*$"
    ),
]
ArtifactMediaPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=4096),
]
GeneratedRunValue = Annotated[str, StringConstraints(min_length=1)]
ArtifactPathSegment = r"[^\x00-\x1F\x7F/\\]+"
ArtifactJsonOrHarPath = (
    rf"(?i)^(?:{ArtifactPathSegment}[\\/])*[^./\\][^\x00-\x1F\x7F/\\]*\.(?:har|json)$"
)
ArtifactHtmlPath = (
    rf"(?i)^(?:{ArtifactPathSegment}[\\/])*[^./\\][^\x00-\x1F\x7F/\\]*\.(?:html|htm)$"
)
ArtifactVideoPath = (
    rf"(?i)^(?:{ArtifactPathSegment}[\\/])*[^./\\][^\x00-\x1F\x7F/\\]*\.(?:mp4|webm|mov|mkv)$"
)


class CommandDefinition(BaseModel):
    command_id: str
    title: str
    description: str
    tags: list[str] = Field(default_factory=list)
    accepts_env: bool = True


class RunCommandRequest(BaseModel):
    command: str = Field(min_length=1, validation_alias=AliasChoices("command", "command_id"))
    params: "RunCommandParams | None" = None
    env: dict[str, str] | None = Field(
        default=None,
        description="Deprecated: use `params` instead. This field will be removed after RC cutover.",
        json_schema_extra={"deprecated": True},
    )

    @property
    def command_id(self) -> str:
        return self.command

    @property
    def resolved_params(self) -> dict[str, str]:
        merged: dict[str, str] = {}
        if self.params is not None:
            merged.update(self.params.to_env_dict())
        for key, value in (self.env or {}).items():
            if key not in merged:
                merged[key] = value
        return merged

    @field_validator("env")
    @classmethod
    def validate_env(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return value
        if len(value) > 32:
            raise ValueError("env exceeds max key count (32)")
        for key, env_value in value.items():
            if len(key) > 64:
                raise ValueError("env key exceeds max length (64)")
            if len(env_value) > 2048:
                raise ValueError("env value exceeds max length (2048)")
        return value


class RunCommandParams(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    base_url: str | None = Field(default=None, alias="BASE_URL")
    start_url: str | None = Field(default=None, alias="START_URL")
    success_selector: str | None = Field(default=None, alias="SUCCESS_SELECTOR")
    ai_provider: str | None = Field(default=None, alias="AI_PROVIDER")
    ai_speed_mode: str | None = Field(default=None, alias="AI_SPEED_MODE")
    video_analyzer_provider: str | None = Field(default=None, alias="VIDEO_ANALYZER_PROVIDER")
    midscene_model_name: str | None = Field(default=None, alias="MIDSCENE_MODEL_NAME")
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")
    gemini_model: str | None = Field(default=None, alias="GEMINI_MODEL")
    gemini_fast_model: str | None = Field(default=None, alias="GEMINI_FAST_MODEL")
    gemini_embedding_model: str | None = Field(default=None, alias="GEMINI_EMBEDDING_MODEL")
    gemini_thinking_level: str | None = Field(default=None, alias="GEMINI_THINKING_LEVEL")
    gemini_include_thoughts: str | None = Field(default=None, alias="GEMINI_INCLUDE_THOUGHTS")
    gemini_context_cache_ttl_seconds: str | None = Field(
        default=None, alias="GEMINI_CONTEXT_CACHE_TTL_SECONDS"
    )
    gemini_media_resolution_default: str | None = Field(
        default=None, alias="GEMINI_MEDIA_RESOLUTION_DEFAULT"
    )
    gemini_tool_mode: str | None = Field(default=None, alias="GEMINI_TOOL_MODE")
    midscene_strict: str | None = Field(default=None, alias="MIDSCENE_STRICT")
    register_password: str | None = Field(default=None, alias="REGISTER_PASSWORD")
    headless: str | None = Field(default=None, alias="HEADLESS")
    flow_step_id: str | None = Field(default=None, alias="FLOW_STEP_ID")
    flow_from_step_id: str | None = Field(default=None, alias="FLOW_FROM_STEP_ID")
    flow_replay_preconditions: str | None = Field(default=None, alias="FLOW_REPLAY_PRECONDITIONS")
    flow_selector_index: str | None = Field(default=None, alias="FLOW_SELECTOR_INDEX")
    flow_input: str | None = Field(default=None, alias="FLOW_INPUT")
    flow_secret_input: str | None = Field(default=None, alias="FLOW_SECRET_INPUT")
    flow_otp_code: str | None = Field(default=None, alias="FLOW_OTP_CODE")
    automation_idempotency_key: str | None = Field(default=None, alias="AUTOMATION_IDEMPOTENCY_KEY")
    automation_idempotency_replay: str | None = Field(
        default=None, alias="AUTOMATION_IDEMPOTENCY_REPLAY"
    )

    def to_env_dict(self) -> dict[str, str]:
        serialized = self.model_dump(by_alias=True, exclude_none=True)
        return {key: value for key, value in serialized.items() if isinstance(value, str)}


class TaskSnapshot(BaseModel):
    task_id: str
    command: str = ""
    command_id: str | None = None
    status: TaskStatus
    requested_by: str | None = None
    attempt: int = 1
    max_attempts: int = 1
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    exit_code: int | None = None
    message: str | None = None
    output_tail: str = ""

    @model_validator(mode="before")
    @classmethod
    def fill_legacy_fields(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        command = payload.get("command")
        command_id = payload.get("command_id")
        if (
            (not isinstance(command, str) or not command)
            and isinstance(command_id, str)
            and command_id
        ):
            payload["command"] = command_id
        if payload.get("command_id") in (None, "") and isinstance(payload.get("command"), str):
            payload["command_id"] = payload["command"]
        if payload.get("updated_at") is None:
            payload["updated_at"] = (
                payload.get("finished_at") or payload.get("started_at") or payload.get("created_at")
            )
        return payload


class RunCommandResponse(BaseModel):
    task: TaskSnapshot


class TaskListResponse(BaseModel):
    tasks: list[TaskSnapshot]


class CommandListResponse(BaseModel):
    commands: list[CommandDefinition]


class FlowPreviewStep(BaseModel):
    step_id: str
    action: str
    url: str | None = None
    value_ref: str | None = None
    selector: str | None = None


class FlowPreviewResponse(BaseModel):
    session_id: str | None = None
    start_url: str | None = None
    generated_at: datetime | None = None
    source_event_count: int = 0
    step_count: int = 0
    steps: list[FlowPreviewStep] = Field(default_factory=list)


class FlowDraftDocumentResponse(BaseModel):
    session_id: str | None = None
    flow: dict[str, Any] | None = None


class FlowDraftDocumentUpdateRequest(BaseModel):
    flow: dict[str, Any]


class ReplayLatestStepRequest(BaseModel):
    step_id: str = Field(min_length=1)


class ReplayFromStepRequest(BaseModel):
    step_id: str = Field(min_length=1)
    replay_preconditions: bool = False


class SelectorAttemptResponse(BaseModel):
    selector_index: int | None = None
    kind: str
    value: str
    normalized: str | None = None
    success: bool
    error: str | None = None


class StepEvidenceResponse(BaseModel):
    step_id: str
    action: str | None = None
    ok: bool | None = None
    detail: str | None = None
    duration_ms: int | None = None
    matched_selector: str | None = None
    selector_index: int | None = None
    screenshot_before_path: str | None = None
    screenshot_after_path: str | None = None
    screenshot_before_data_url: str | None = None
    screenshot_after_data_url: str | None = None
    fallback_trail: list[SelectorAttemptResponse] = Field(default_factory=list)


class EvidenceTimelineItemResponse(BaseModel):
    step_id: str
    action: str | None = None
    ok: bool | None = None
    detail: str | None = None
    duration_ms: int | None = None
    matched_selector: str | None = None
    selector_index: int | None = None
    screenshot_before_path: str | None = None
    screenshot_after_path: str | None = None
    screenshot_before_data_url: str | None = None
    screenshot_after_data_url: str | None = None
    fallback_trail: list[SelectorAttemptResponse] = Field(default_factory=list)


class EvidenceTimelineResponse(BaseModel):
    items: list[EvidenceTimelineItemResponse] = Field(default_factory=list)


class ReconstructionArtifactsRequest(BaseModel):
    """Artifact paths are accepted only when they resolve under the automation runtime root."""

    model_config = ConfigDict(extra="forbid")

    session_id: str | None = Field(default=None, pattern=r"^ss_[0-9a-f]{32}$")
    session_dir: ArtifactSessionDir | None = Field(
        default=None,
        description="Runtime-root-bound session directory path.",
    )
    video_path: ArtifactMediaPath | None = Field(
        default=None,
        pattern=ArtifactVideoPath,
        description="Runtime-root-bound video artifact path.",
    )
    har_path: ArtifactMediaPath | None = Field(
        default=None,
        pattern=ArtifactJsonOrHarPath,
        description="Runtime-root-bound HAR artifact path.",
    )
    html_path: ArtifactMediaPath | None = Field(
        default=None,
        pattern=ArtifactHtmlPath,
        description="Runtime-root-bound HTML snapshot path.",
    )
    html_content: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("session_dir", "video_path", "har_path", "html_path")
    @classmethod
    def validate_artifact_paths(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("artifact path not found")
        if "\x00" in normalized:
            raise ValueError("artifact path not found")
        if any((ord(ch) < 32 or ord(ch) == 127) for ch in normalized):
            raise ValueError("artifact path not found")
        return normalized


class OrchestrateFromArtifactsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifacts: ReconstructionArtifactsRequest
    video_analysis_mode: Literal["gemini"] = "gemini"
    extractor_strategy: Literal["strict", "balanced", "aggressive"] = "balanced"
    auto_refine_iterations: int = Field(default=3, ge=1, le=10)
    template_name: str = Field(default="reconstructed-template", min_length=1, max_length=128)
    create_run: StrictBool = False
    run_params: "GeneratedRunParams" = Field(default_factory=lambda: GeneratedRunParams())


class OrchestrateFromArtifactsResponse(BaseModel):
    template_id: str
    run_id: str | None = None
    reconstructed_flow_quality: int
    step_confidence: list[float] = Field(default_factory=list)
    unresolved_segments: list[str] = Field(default_factory=list)
    generator_outputs: dict[str, str] = Field(default_factory=dict)
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None


class ProfileResolveRequest(BaseModel):
    artifacts: ReconstructionArtifactsRequest
    extractor_strategy: Literal["strict", "balanced", "aggressive"] = "balanced"


class ProfileResolveResponse(BaseModel):
    profile: str
    video_signals: list[str] = Field(default_factory=list)
    dom_alignment_score: float = 0.0
    har_alignment_score: float = 0.0
    recommended_manual_checkpoints: list[str] = Field(default_factory=list)
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None


class ReconstructionPreviewStep(BaseModel):
    step_id: str
    action: str
    url: str | None = None
    value_ref: str | None = None
    evidence_ref: str | None = None
    confidence: float = 1.0
    source_engine: str = "gemini"
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None


class ReconstructionPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifacts: ReconstructionArtifactsRequest
    video_analysis_mode: Literal["gemini"] = "gemini"
    extractor_strategy: Literal["strict", "balanced", "aggressive"] = "balanced"
    auto_refine_iterations: int = Field(default=3, ge=1, le=10)


class ReconstructionPreviewResponse(BaseModel):
    preview_id: str
    flow_draft: dict[str, Any]
    reconstructed_flow_quality: int
    step_confidence: list[float] = Field(default_factory=list)
    unresolved_segments: list[str] = Field(default_factory=list)
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None
    generator_outputs: dict[str, str] = Field(default_factory=dict)


class ReconstructionGenerateRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"anyOf": [{"required": ["preview_id"]}, {"required": ["preview"]}]},
    )

    preview_id: str | None = Field(default=None, min_length=1)
    preview: ReconstructionPreviewResponse | None = None
    template_name: str = Field(default="reconstructed-template", min_length=1, max_length=128)
    create_run: StrictBool = False
    run_params: "GeneratedRunParams" = Field(default_factory=lambda: GeneratedRunParams())


class GeneratedRunParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: GeneratedRunValue | None = Field(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: GeneratedRunValue | None = None


class ReconstructionGenerateResponse(BaseModel):
    flow_id: str
    template_id: str
    run_id: str | None = None
    generator_outputs: dict[str, str] = Field(default_factory=dict)
    reconstructed_flow_quality: int
    step_confidence: list[float] = Field(default_factory=list)
    unresolved_segments: list[str] = Field(default_factory=list)
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None
