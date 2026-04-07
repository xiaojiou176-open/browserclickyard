from __future__ import annotations

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

RunResumeKind = Literal["otp", "approval", "input", "checkpoint_ack"]


class ManualGateInputField(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    kind: Literal["otp", "text", "textarea", "ack"] = "text"
    required: bool = False
    placeholder: str | None = Field(default=None, max_length=160)
    help_text: str | None = Field(default=None, max_length=400)


class ManualGateAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: RunResumeKind
    label: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)


class RunResumeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    kind: RunResumeKind = "otp"
    otp_code: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("otp_code", "otpCode"),
        serialization_alias="otp_code",
    )
    input_text: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("input_text", "inputText"),
        serialization_alias="input_text",
    )
    approved: bool | None = None
    confirmation_note: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("confirmation_note", "confirmationNote"),
        serialization_alias="confirmation_note",
    )
    checkpoint_id: str | None = Field(
        default=None,
        min_length=1,
        validation_alias=AliasChoices("checkpoint_id", "checkpointId"),
        serialization_alias="checkpoint_id",
    )
    payload: dict[str, Any] = Field(default_factory=dict)
    expected_version: int | None = Field(
        default=None,
        validation_alias=AliasChoices("expected_version", "expectedVersion"),
        serialization_alias="expected_version",
    )
