from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query

from app.api.common import COMMON_ERROR_RESPONSES, accept_cookie_header
from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.models.proof import (
    ProofCampaignCreateRequest,
    ProofCampaignDiffRequest,
    ProofCampaignDiffResponse,
    ProofCampaignListResponse,
    ProofCampaignResponse,
    ReleaseBriefResponse,
    RunAiReviewResponse,
    RunCompareRequest,
    RunCompareResponse,
    SimilarFailuresResponse,
    TargetFeasibilityResponse,
)
from app.services.proof_service import proof_service

router = APIRouter(
    prefix="/api/proof",
    tags=["proof"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)


@router.get("/campaigns", response_model=ProofCampaignListResponse)
def list_proof_campaigns(
    limit: int = Query(default=100, ge=1, le=200),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ProofCampaignListResponse:
    return ProofCampaignListResponse(
        campaigns=proof_service.list_campaigns(limit=limit, requester=security.verified_actor)
    )


@router.post("/campaigns", response_model=ProofCampaignResponse)
def create_proof_campaign(
    payload: ProofCampaignCreateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ProofCampaignResponse:
    result = proof_service.create_campaign(
        run_ids=payload.run_ids,
        model=payload.model,
        name=payload.name,
        description=payload.description,
        actor=security.verified_actor,
    )
    return ProofCampaignResponse(**result)


@router.get("/campaigns/{campaign_id}", response_model=ProofCampaignResponse)
def get_proof_campaign(
    campaign_id: str = Path(min_length=1),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ProofCampaignResponse:
    result = proof_service.get_campaign(campaign_id, requester=security.verified_actor)
    return ProofCampaignResponse(**result)


@router.post("/campaigns/{campaign_id}/diff", response_model=ProofCampaignDiffResponse)
def diff_proof_campaign(
    payload: ProofCampaignDiffRequest,
    campaign_id: str = Path(min_length=1),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ProofCampaignDiffResponse:
    result = proof_service.diff_campaigns(
        left_campaign_id=campaign_id,
        right_campaign_id=payload.other_campaign_id,
        requester=security.verified_actor,
    )
    return ProofCampaignDiffResponse(**result)


@router.post("/runs/compare", response_model=RunCompareResponse)
def compare_runs_for_proof(
    payload: RunCompareRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunCompareResponse:
    result = proof_service.compare_runs(
        left_run_id=payload.left_run_id,
        right_run_id=payload.right_run_id,
        requester=security.verified_actor,
    )
    return RunCompareResponse(**result)


@router.get("/runs/{run_id}/ai-review", response_model=RunAiReviewResponse)
def get_run_ai_review_projection(
    run_id: str = Path(min_length=1),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> RunAiReviewResponse:
    result = proof_service.read_run_ai_review(run_id=run_id, requester=security.verified_actor)
    return RunAiReviewResponse(**result)


@router.get("/runs/{run_id}/release-brief", response_model=ReleaseBriefResponse)
def get_run_release_brief(
    run_id: str = Path(min_length=1),
    baseline_run_id: str | None = Query(default=None, min_length=1),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ReleaseBriefResponse:
    result = proof_service.build_release_brief(
        run_id=run_id,
        baseline_run_id=baseline_run_id,
        requester=security.verified_actor,
    )
    return ReleaseBriefResponse(**result)


@router.get("/runs/{run_id}/similar-failures", response_model=SimilarFailuresResponse)
def get_similar_failures(
    run_id: str = Path(min_length=1),
    limit: int = Query(default=5, ge=1, le=20),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> SimilarFailuresResponse:
    result = proof_service.find_similar_failures(
        run_id=run_id,
        limit=limit,
        requester=security.verified_actor,
    )
    return SimilarFailuresResponse(**result)


@router.get("/templates/{template_id}/feasibility", response_model=TargetFeasibilityResponse)
def get_template_target_feasibility(
    template_id: str = Path(min_length=1),
    target: str = Query(min_length=1),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TargetFeasibilityResponse:
    result = proof_service.evaluate_template_target(
        template_id=template_id,
        target_name=target,
        requester=security.verified_actor,
    )
    return TargetFeasibilityResponse(**result)
