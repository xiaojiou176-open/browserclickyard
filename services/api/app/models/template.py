from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Literal

from pydantic import BaseModel, Field, model_validator

ParamType = Literal["string", "secret", "enum", "regex", "email"]


class TemplateParamSpec(BaseModel):
    key: str
    type: ParamType = "string"
    required: bool = False
    description: str | None = None
    enum_values: list[str] = Field(default_factory=list)
    pattern: str | None = None


class OtpPolicy(BaseModel):
    required: bool = False
    provider: Literal["manual", "gmail", "imap", "vonage"] = "manual"
    timeout_seconds: int = 120
    regex: str = r"\b(\d{6})\b"
    sender_filter: str | None = None
    subject_filter: str | None = None


class TemplatePolicies(BaseModel):
    retries: int = 0
    timeout_seconds: int = 120
    otp: OtpPolicy = Field(default_factory=OtpPolicy)
    branches: dict[str, Any] = Field(default_factory=dict)


class TemplateRecord(BaseModel):
    template_id: str
    template_family_id: str | None = None
    parent_template_id: str | None = None
    flow_id: str
    version: int = 1
    status: Literal["draft", "active", "superseded", "archived"] = "active"
    name: str
    params_schema: list[TemplateParamSpec] = Field(default_factory=list)
    defaults: dict[str, str] = Field(default_factory=dict)
    policies: TemplatePolicies = Field(default_factory=TemplatePolicies)
    recommended: bool = False
    promotion_source: dict[str, Any] = Field(default_factory=dict)
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def fill_family_defaults(self) -> "TemplateRecord":
        if not self.template_family_id:
            self.template_family_id = self.template_id
        return self
