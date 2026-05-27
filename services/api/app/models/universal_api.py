from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, AnyUrl, BaseModel, ConfigDict, Field

from app.models.flow import FlowRecord, FlowStep, SessionRecord
from app.models.run import RunRecord
from app.models.template import TemplatePolicies, TemplateParamSpec, TemplateRecord


class SessionStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_url: AnyUrl
    mode: Literal["manual", "ai", "midscene"] = "manual"


class SessionListResponse(BaseModel):
    sessions: list[SessionRecord] = Field(default_factory=list)


class FlowCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1)
    start_url: str = Field(min_length=1)
    source_event_count: int = Field(default=0, ge=0)
    steps: list[FlowStep] = Field(default_factory=list)


class FlowUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_url: str | None = Field(default=None, min_length=1)
    steps: list[FlowStep] | None = None
    expected_version: int | None = Field(default=None, ge=1)


class FlowListResponse(BaseModel):
    flows: list[FlowRecord] = Field(default_factory=list)


class TemplateCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flow_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    params_schema: list[TemplateParamSpec] = Field(default_factory=list)
    defaults: dict[str, str] = Field(default_factory=dict)
    policies: TemplatePolicies = Field(default_factory=TemplatePolicies)


class TemplateUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1)
    params_schema: list[TemplateParamSpec] | None = None
    defaults: dict[str, str] | None = None
    policies: TemplatePolicies | None = None


class TemplateListResponse(BaseModel):
    templates: list[TemplateRecord] = Field(default_factory=list)


class TemplatePromoteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    flow_id: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("flow_id", "flowId"),
        serialization_alias="flow_id",
    )
    run_id: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("run_id", "runId"),
        serialization_alias="run_id",
    )
    template_name: str = Field(
        min_length=1,
        validation_alias=AliasChoices("template_name", "templateName"),
        serialization_alias="template_name",
    )
    change_note: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("change_note", "changeNote"),
        serialization_alias="change_note",
    )
    recommended: bool = False


class TemplateVersionForkRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    template_name: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("template_name", "templateName"),
        serialization_alias="template_name",
    )
    change_note: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("change_note", "changeNote"),
        serialization_alias="change_note",
    )
    params_schema: list[TemplateParamSpec] | None = None
    defaults: dict[str, str] | None = None
    policies: TemplatePolicies | None = None


class TemplateHistoryResponse(BaseModel):
    templates: list[TemplateRecord] = Field(default_factory=list)


class RunCreateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    template_id: str = Field(
        min_length=1,
        validation_alias=AliasChoices("template_id", "templateId"),
        serialization_alias="template_id",
    )
    session_id: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("session_id", "sessionId"),
        serialization_alias="session_id",
    )
    params: dict[str, Any] = Field(default_factory=dict)
    otp_code: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("otp_code", "otpCode"),
        serialization_alias="otp_code",
    )


class RunOtpSubmitRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    otp_code: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("otp_code", "otpCode"),
        serialization_alias="otp_code",
    )
    expected_version: int | None = Field(
        default=None,
        validation_alias=AliasChoices("expected_version", "expectedVersion"),
        serialization_alias="expected_version",
    )


class RunListResponse(BaseModel):
    runs: list[RunRecord] = Field(default_factory=list)


class RunResponse(BaseModel):
    run: RunRecord


class RunEnvelopeResponse(RunResponse):
    """Backward-compatible alias for legacy response model name."""


class TemplateFromArtifactsRequest(BaseModel):
    artifacts: dict[str, Any]
    video_analysis_mode: Literal["gemini"] = "gemini"
    extractor_strategy: str = "balanced"
    auto_refine_iterations: int = 3
    template_name: str = "reconstructed-template"


class TemplateFromArtifactsResponse(BaseModel):
    template_id: str
    flow_id: str
    reconstructed_flow_quality: int
    generator_outputs: dict[str, str] = Field(default_factory=dict)
