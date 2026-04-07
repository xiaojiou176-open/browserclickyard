from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

SelectorKind = Literal["role", "text", "testid", "css", "xpath", "id", "name"]
FlowAction = Literal[
    "navigate", "click", "type", "select", "wait_for", "assert", "extract", "branch", "manual_gate"
]
FlowSourceEngine = Literal["gemini", "heuristic", "manual"]


class SelectorCandidate(BaseModel):
    kind: SelectorKind
    value: str
    score: int = 50


class FlowStepTarget(BaseModel):
    selectors: list[SelectorCandidate] = Field(default_factory=list)


class FlowStep(BaseModel):
    step_id: str
    action: FlowAction | str
    url: str | None = None
    value_ref: str | None = None
    selected_selector_index: int | None = None
    target: FlowStepTarget | None = None
    preconditions: list[str] = Field(default_factory=list)
    evidence_ref: str | None = None
    confidence: float = 1.0
    source_engine: FlowSourceEngine | str = "manual"
    manual_handoff_required: bool = False
    unsupported_reason: str | None = None

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, value: float) -> float:
        if value < 0:
            return 0.0
        if value > 1:
            return 1.0
        return value


class SessionRecord(BaseModel):
    session_id: str
    start_url: str
    mode: Literal["manual", "ai"] = "manual"
    owner: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    artifacts_index: dict[str, str] = Field(default_factory=dict)


class FlowRecord(BaseModel):
    flow_id: str
    session_id: str
    version: int = 1
    quality_score: int = 0
    start_url: str
    source_event_count: int = 0
    steps: list[FlowStep] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
