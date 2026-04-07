from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from fastapi.exceptions import RequestValidationError

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import COMMON_ERROR_RESPONSES
from app.models.automation import (
    ReconstructionGenerateRequest,
    ReconstructionGenerateResponse,
    ReconstructionPreviewRequest,
    ReconstructionPreviewResponse,
)
from app.services.universal_platform_service import universal_platform_service

router = APIRouter(
    prefix="/api/reconstruction", tags=["reconstruction"], responses=COMMON_ERROR_RESPONSES
)
_PREVIEW_ID_RE = re.compile(r"^prv_[0-9a-f]{32}$")


@router.post("/preview", response_model=ReconstructionPreviewResponse)
def reconstruction_preview(
    payload: ReconstructionPreviewRequest,
    _security: AutomationSecurityContext = Depends(require_automation_access),
) -> ReconstructionPreviewResponse:
    return universal_platform_service.create_reconstruction_preview(payload)


@router.post("/generate", response_model=ReconstructionGenerateResponse)
def reconstruction_generate(
    payload: ReconstructionGenerateRequest,
    security: AutomationSecurityContext = Depends(require_automation_access),
) -> ReconstructionGenerateResponse:
    if payload.preview_id is not None and _PREVIEW_ID_RE.fullmatch(payload.preview_id) is None:
        raise RequestValidationError(
            [
                {
                    "type": "string_pattern_mismatch",
                    "loc": ("body", "preview_id"),
                    "msg": "String should match pattern '^prv_[0-9a-f]{32}$'",
                    "input": payload.preview_id,
                    "ctx": {"pattern": "^prv_[0-9a-f]{32}$"},
                }
            ]
        )
    return universal_platform_service.generate_reconstruction(
        payload,
        actor=security.actor,
    )
