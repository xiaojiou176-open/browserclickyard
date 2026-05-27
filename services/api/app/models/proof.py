from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class RunCompareMetricsDelta(BaseModel):
    model_config = ConfigDict(extra="allow")

    values: dict[str, float | int | None] = Field(default_factory=dict)


class RunCompareCheckDelta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    added_failed_or_blocked: list[str] = Field(default_factory=list)
    removed_failed_or_blocked: list[str] = Field(default_factory=list)
    persisted_failed_or_blocked: list[str] = Field(default_factory=list)


class RunCompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    left_run_id: str = Field(min_length=1)
    right_run_id: str = Field(min_length=1)


class RunCompareResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    left_run_id: str
    right_run_id: str
    left_gate_status: str | None = None
    right_gate_status: str | None = None
    metrics_delta: RunCompareMetricsDelta = Field(default_factory=RunCompareMetricsDelta)
    checks: RunCompareCheckDelta = Field(default_factory=RunCompareCheckDelta)
    summary: dict[str, Any] = Field(default_factory=dict)


class ProofCampaignRecord(BaseModel):
    model_config = ConfigDict(extra="allow")

    campaign_id: str
    model: str
    name: str | None = None
    description: str | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime
    status: str
    policy_mode: str = "strict"
    run_ids: list[str] = Field(default_factory=list)
    reason_codes: list[str] = Field(default_factory=list)
    report_path: str
    index_path: str


class ProofCampaignCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    run_ids: list[str] = Field(min_length=1)


class ProofCampaignListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    campaigns: list[ProofCampaignRecord] = Field(default_factory=list)


class ProofCampaignResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    campaign: ProofCampaignRecord
    report: dict[str, Any] = Field(default_factory=dict)


class ProofCampaignDiffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    other_campaign_id: str = Field(min_length=1)


class ProofCampaignDiffResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    left_campaign_id: str
    right_campaign_id: str
    diff: dict[str, Any] = Field(default_factory=dict)


class RunAiReviewResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    run_id: str
    enabled: bool
    report_path: str | None = None
    markdown_path: str | None = None
    findings: list[dict[str, Any]] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    generation: dict[str, Any] = Field(default_factory=dict)


class ReleaseBriefResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    run_id: str
    baseline_run_id: str | None = None
    recommendation: str
    gate_status: str | None = None
    observed: dict[str, Any] = Field(default_factory=dict)
    ai_interpretation: dict[str, Any] = Field(default_factory=dict)
    evidence_snapshot: dict[str, Any] = Field(default_factory=dict)
    open_questions: list[str] = Field(default_factory=list)
    next_step: str


class SimilarFailureMatch(BaseModel):
    model_config = ConfigDict(extra="allow")

    run_id: str
    score: float
    gate_status: str | None = None
    reason_codes: list[str] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    why_matched: str
    report_path: str | None = None


class SimilarFailuresResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    run_id: str
    matches: list[SimilarFailureMatch] = Field(default_factory=list)


class TargetFeasibilityResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    template_id: str
    target: str
    supported: bool
    blocked_reasons: list[str] = Field(default_factory=list)
    migration_hints: list[str] = Field(default_factory=list)
    required_capabilities: list[str] = Field(default_factory=list)
