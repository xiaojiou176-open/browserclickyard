from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import (
    COMMON_ERROR_RESPONSES,
    accept_cookie_header,
    reject_unknown_query_params,
)
from app.models.automation import (
    OrchestrateFromArtifactsRequest,
    OrchestrateFromArtifactsResponse,
)
from app.models.template import TemplateParamSpec, TemplateRecord
from app.models.universal_api import (
    TemplateCreateRequest,
    TemplateHistoryResponse,
    TemplateListResponse,
    TemplatePromoteRequest,
    TemplateUpdateRequest,
    TemplateVersionForkRequest,
)
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/templates",
    tags=["templates"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)


@router.get("", response_model=TemplateListResponse)
def list_templates(
    limit: int = Query(default=100, ge=1, le=300),
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateListResponse:
    return TemplateListResponse(
        templates=universal_platform_service.list_templates(limit=limit, requester=security.actor)
    )


@router.post("", response_model=TemplateRecord)
def create_template(
    payload: TemplateCreateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    return universal_platform_service.create_template(
        flow_id=payload.flow_id,
        name=payload.name,
        params_schema=cast(list[dict[str, Any] | TemplateParamSpec], payload.params_schema),
        defaults=payload.defaults,
        policies=payload.policies,
        created_by=security.actor,
    )


@router.patch("/from-artifacts", include_in_schema=False)
def create_template_from_artifacts_method_not_allowed() -> None:
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="Method Not Allowed",
        headers={"Allow": "POST"},
    )


@router.get("/from-artifacts", include_in_schema=False)
def create_template_from_artifacts_get_not_allowed() -> None:
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="Method Not Allowed",
        headers={"Allow": "POST"},
    )


@router.get("/{template_id}", response_model=TemplateRecord)
def get_template(
    request: Request,
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    reject_unknown_query_params(request, allowed=frozenset())
    return universal_platform_service.get_template(template_id, requester=security.actor)


@router.patch("/{template_id}", response_model=TemplateRecord)
def update_template(
    request: Request,
    payload: TemplateUpdateRequest,
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    reject_unknown_query_params(request, allowed=frozenset())
    if template_id == "from-artifacts":
        raise HTTPException(
            status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
            detail="Method Not Allowed",
            headers={"Allow": "POST"},
        )
    return universal_platform_service.update_template(
        template_id,
        name=payload.name,
        params_schema=cast(
            list[dict[str, Any] | TemplateParamSpec] | None,
            payload.params_schema,
        ),
        defaults=payload.defaults,
        policies=payload.policies,
        actor=security.actor,
    )


@router.get("/{template_id}/export")
def export_template(
    request: Request,
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> dict[str, Any]:
    reject_unknown_query_params(request, allowed=frozenset())
    return universal_platform_service.export_template(template_id, actor=security.actor)


@router.post("/promote", response_model=TemplateRecord)
def promote_template(
    payload: TemplatePromoteRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    return universal_platform_service.promote_template(
        flow_id=payload.flow_id,
        run_id=payload.run_id,
        template_name=payload.template_name,
        change_note=payload.change_note,
        recommended=payload.recommended,
        actor=security.actor,
    )


@router.get("/{template_id}/history", response_model=TemplateHistoryResponse)
def template_history(
    request: Request,
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateHistoryResponse:
    reject_unknown_query_params(request, allowed=frozenset())
    return TemplateHistoryResponse(
        templates=universal_platform_service.list_template_history(
            template_id, requester=security.actor
        )
    )


@router.post("/{template_id}/fork-version", response_model=TemplateRecord)
def fork_template_version(
    payload: TemplateVersionForkRequest,
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    return universal_platform_service.fork_template_version(
        template_id,
        template_name=payload.template_name,
        change_note=payload.change_note,
        params_schema=cast(
            list[dict[str, Any] | TemplateParamSpec] | None,
            payload.params_schema,
        ),
        defaults=payload.defaults,
        policies=payload.policies,
        actor=security.actor,
    )


@router.post("/{template_id}/mark-recommended", response_model=TemplateRecord)
def mark_template_recommended(
    template_id: str,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> TemplateRecord:
    return universal_platform_service.mark_template_recommended(
        template_id, actor=security.actor
    )


@router.post("/from-artifacts", response_model=OrchestrateFromArtifactsResponse)
def create_template_from_artifacts(
    payload: OrchestrateFromArtifactsRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> OrchestrateFromArtifactsResponse:
    return universal_platform_service.create_template_from_artifacts(
        payload,
        actor=security.actor,
    )
