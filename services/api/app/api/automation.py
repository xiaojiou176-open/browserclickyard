from __future__ import annotations

from typing import Literal, cast

from fastapi import APIRouter, Depends, Header, Path, Request
from fastapi import HTTPException, status
from fastapi import Query

from app.api.dependencies.security import (
    AutomationSecurityContext,
    require_automation_access,
)
from app.api.common import (
    COMMON_ERROR_RESPONSES,
    accept_cookie_header,
    reject_unknown_query_params,
)
from app.core.access_control import require_access, require_actor
from app.core.env_governance import is_automation_run_payload_strict
from app.models.automation import (
    CommandListResponse,
    RunCommandRequest,
    RunCommandResponse,
    TaskListResponse,
    TaskSnapshot,
)
from app.services.automation_service import automation_service

router = APIRouter(
    prefix="/api/automation",
    tags=["automation"],
    responses=COMMON_ERROR_RESPONSES,
    dependencies=[Depends(accept_cookie_header)],
)

TaskStatusFilter = Literal["queued", "running", "success", "failed", "cancelled"]
TaskStatusFilterInput = TaskStatusFilter | Literal["null"]
_TASK_ID_PATTERN = (
    r"^(?:"
    r"idem-[0-9a-f]{32}"
    r"|"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r")$"
)
_COMMAND_ID_PATTERN = r"^[a-z][a-z0-9-]{0,63}$"


@router.get("/commands", response_model=CommandListResponse)
def list_commands(
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> CommandListResponse:
    require_access(request, x_automation_token)
    return CommandListResponse(commands=automation_service.list_commands())


@router.get("/tasks", response_model=TaskListResponse)
def list_tasks(
    security: AutomationSecurityContext = Depends(require_automation_access),
    status_filter: TaskStatusFilterInput | None = Query(default=None, alias="status"),
    command_id: str | None = Query(default=None, pattern=_COMMAND_ID_PATTERN),
    limit: int = Query(default=100, ge=1, le=500),
) -> TaskListResponse:
    typed_status = (
        None if status_filter in (None, "null") else cast(TaskStatusFilter, status_filter)
    )
    return TaskListResponse(
        tasks=automation_service.list_tasks(
            status=typed_status,
            command_id=command_id,
            limit=limit,
            requested_by=security.actor,
        )
    )


@router.get("/tasks/{task_id}", response_model=TaskSnapshot)
def get_task(
    request: Request,
    task_id: str = Path(pattern=_TASK_ID_PATTERN),
    x_automation_token: str | None = Header(default=None),
) -> TaskSnapshot:
    reject_unknown_query_params(request, allowed=frozenset())
    return automation_service.get_task(
        task_id, requested_by=require_actor(request, x_automation_token)
    )


@router.post("/run", response_model=RunCommandResponse)
def run_command(
    payload: RunCommandRequest,
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> RunCommandResponse:
    actor = require_actor(request, x_automation_token)
    env_provided = payload.env is not None
    if env_provided and is_automation_run_payload_strict():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="env is deprecated, use params",
        )
    task = automation_service.run_command(
        payload.command,
        payload.resolved_params,
        used_deprecated_env=env_provided,
        requested_by=actor,
    )
    return RunCommandResponse(task=task)


@router.post("/tasks/{task_id}/cancel", response_model=TaskSnapshot)
def cancel_task(
    request: Request,
    task_id: str = Path(pattern=_TASK_ID_PATTERN),
    x_automation_token: str | None = Header(default=None),
) -> TaskSnapshot:
    reject_unknown_query_params(request, allowed=frozenset())
    return automation_service.cancel_task(
        task_id, requested_by=require_actor(request, x_automation_token)
    )
