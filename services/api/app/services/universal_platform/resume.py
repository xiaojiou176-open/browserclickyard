from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status

from app.models.manual_gate import RunResumeRequest
from app.models.run import RunLogEntry, RunRecord, RunStatus
from app.services.automation_service import automation_service


def submit_otp_and_resume(
    service: Any,
    run_id: str,
    otp_code: str | None,
    expected_version: int | None = None,
    actor: str | None = None,
) -> RunRecord:
    otp_value = (otp_code or "").strip()
    claimed_run, previous_status = claim_run_for_resume(
        service, run_id, actor, otp_value, expected_version=expected_version
    )
    claimed_version = claimed_run.version
    try:
        template = service.get_template(claimed_run.template_id, requester=actor)
        flow = service.get_flow(template.flow_id, requester=actor)
        params = service._get_validated_params_snapshot(run_id)
        service._validate_params(template, params, template.policies.otp)
        env = service._build_env(flow.start_url, params, otp_value)
        if previous_status == "waiting_user":
            resume_from_step_id = service._resolve_resume_from_step_id(claimed_run.wait_context)
            if resume_from_step_id:
                env["FLOW_FROM_STEP_ID"] = resume_from_step_id
            env["FLOW_RESUME_CONTEXT"] = "true"
        task = automation_service.run_command("automation-replay-flow", env, requested_by=actor)
    except Exception as exc:
        mark_run_resume_failed(service, run_id, f"otp resume submit failed: {exc}")
        service._audit("run.resume_otp_failed", actor, {"run_id": run_id, "error": str(exc)})
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to submit otp resume run",
        ) from exc

    try:
        with service._lock:
            run = service._load_run_locked(run_id)
            if run is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
            if run.version != claimed_version or run.status != "queued":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "run resume conflict: "
                        f"expected version={claimed_version}, status=queued; "
                        f"current version={run.version}, status={run.status}"
                    ),
                )
            run.status = service._map_task_status(task.status)
            run.task_id = task.task_id
            run.wait_context = None
            run.version += 1
            run.updated_at = datetime.now(UTC)
            resume_message = (
                f"otp accepted and resumed with task {task.task_id}"
                if previous_status == "waiting_otp"
                else f"manual gate resolved and resumed with task {task.task_id}"
            )
            run.logs.append(RunLogEntry(ts=datetime.now(UTC), level="info", message=resume_message))
            if not service._save_run_locked(run, expected_version=claimed_version):
                latest = service._load_run_locked(run_id)
                latest_version = latest.version if latest is not None else "missing"
                latest_status = latest.status if latest is not None else "missing"
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "run resume conflict: "
                        f"expected version={claimed_version}, status=queued; "
                        f"current version={latest_version}, status={latest_status}"
                    ),
                )
    except Exception as exc:
        cancel_error: Exception | None = None
        try:
            automation_service.cancel_task(task.task_id, requested_by=actor)
        except Exception as cancel_exc:
            cancel_error = cancel_exc
        if cancel_error is not None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="failed to persist resumed run and failed to cancel automation task",
            ) from cancel_error
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to persist resumed run after submitting automation task",
        ) from exc

    audit_action = "run.resume_otp" if previous_status == "waiting_otp" else "run.resume_user"
    service._audit(audit_action, actor, {"run_id": run_id, "task_id": task.task_id})
    return run


def submit_resume(
    service: Any,
    run_id: str,
    payload: RunResumeRequest,
    *,
    actor: str | None = None,
) -> RunRecord:
    run = service.get_run(run_id, requester=actor)
    previous_status = run.status
    resume_value = _resolve_resume_value(previous_status, payload)
    claimed_run, previous_status = claim_run_for_resume(
        service,
        run_id,
        actor,
        resume_value,
        expected_version=payload.expected_version,
    )
    claimed_version = claimed_run.version
    try:
        template = service.get_template(claimed_run.template_id, requester=actor)
        flow = service.get_flow(template.flow_id, requester=actor)
        params = service._get_validated_params_snapshot(run_id)
        service._validate_params(template, params, template.policies.otp)
        env = service._build_env(
            flow.start_url,
            params,
            resume_value if payload.kind == "otp" else None,
        )
        if payload.kind == "input" and resume_value:
            env["FLOW_INPUT"] = resume_value
            env["FLOW_RESUME_INPUT"] = resume_value
        if payload.kind == "approval":
            env["FLOW_MANUAL_APPROVED"] = "true"
            if payload.confirmation_note:
                env["FLOW_INPUT"] = payload.confirmation_note
        if previous_status == "waiting_user":
            resume_from_step_id = service._resolve_resume_from_step_id(claimed_run.wait_context)
            if resume_from_step_id:
                env["FLOW_FROM_STEP_ID"] = resume_from_step_id
            env["FLOW_RESUME_CONTEXT"] = "true"
        task = automation_service.run_command("automation-replay-flow", env, requested_by=actor)
    except Exception as exc:
        mark_run_resume_failed(service, run_id, f"manual resume submit failed: {exc}")
        service._audit("run.resume_failed", actor, {"run_id": run_id, "error": str(exc)})
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to submit manual resume run",
        ) from exc

    try:
        with service._lock:
            latest_run = service._load_run_locked(run_id)
            if latest_run is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
            if latest_run.version != claimed_version or latest_run.status != "queued":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "run resume conflict: "
                        f"expected version={claimed_version}, status=queued; "
                        f"current version={latest_run.version}, status={latest_run.status}"
                    ),
                )
            latest_run.status = service._map_task_status(task.status)
            latest_run.task_id = task.task_id
            latest_run.wait_context = None
            latest_run.version += 1
            latest_run.updated_at = datetime.now(UTC)
            latest_run.logs.append(
                RunLogEntry(
                    ts=datetime.now(UTC),
                    level="info",
                    message=f"manual gate resumed with kind={payload.kind} task={task.task_id}",
                )
            )
            if not service._save_run_locked(latest_run, expected_version=claimed_version):
                newer = service._load_run_locked(run_id)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "run resume conflict: "
                        f"expected version={claimed_version}, status=queued; "
                        f"current version={newer.version if newer else 'missing'}, "
                        f"status={newer.status if newer else 'missing'}"
                    ),
                )
    except Exception as exc:
        cancel_error: Exception | None = None
        try:
            automation_service.cancel_task(task.task_id, requested_by=actor)
        except Exception as cancel_exc:
            cancel_error = cancel_exc
        if cancel_error is not None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="failed to persist resumed run and failed to cancel automation task",
            ) from cancel_error
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to persist resumed run after submitting automation task",
        ) from exc

    service._audit(
        f"run.resume_{payload.kind}",
        actor,
        {"run_id": run_id, "task_id": task.task_id, "kind": payload.kind},
    )
    return latest_run


def claim_run_for_resume(
    service: Any,
    run_id: str,
    actor: str | None,
    otp_value: str,
    *,
    expected_version: int | None = None,
) -> tuple[RunRecord, RunStatus]:
    service.get_run(run_id, requester=actor)
    with service._lock:
        current = service._load_run_locked(run_id)
        if current is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
        if expected_version is not None and current.version != expected_version:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"run version conflict: expected {expected_version}, current {current.version}",
            )
        previous_status = current.status
        if previous_status not in {"waiting_otp", "waiting_user"}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="run is not waiting for user input"
            )
        if previous_status == "waiting_otp" and not otp_value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="otp_code is required"
            )
        base_version = current.version
        current.status = "queued"
        current.version += 1
        current.updated_at = datetime.now(UTC)
        claim_message = "otp resume claimed; scheduling run"
        if previous_status == "waiting_user":
            claim_message = "manual gate resume claimed; scheduling run"
        current.logs.append(RunLogEntry(ts=datetime.now(UTC), level="info", message=claim_message))
        if not service._save_run_locked(current, expected_version=base_version):
            raise _run_version_conflict(service, run_id, expected=base_version)
        return current, previous_status


def mark_run_resume_failed(service: Any, run_id: str, message: str) -> RunRecord:
    with service._lock:
        run = service._load_run_locked(run_id)
        if run is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
        previous_status = run.status
        if previous_status in {"success", "cancelled"}:
            return run
        base_version = run.version
        if previous_status != "failed":
            run.version += 1
        run.status = "failed"
        run.updated_at = datetime.now(UTC)
        run.logs.append(
            RunLogEntry(ts=datetime.now(UTC), level="error", message=service._redact_text(message))
        )
        if not service._save_run_locked(run, expected_version=base_version):
            latest = service._load_run_locked(run_id)
            if latest is not None:
                return latest
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
        return run


def _run_version_conflict(service: Any, run_id: str, *, expected: int) -> HTTPException:
    current = service._load_run_locked(run_id)
    current_version = current.version if current is not None else "missing"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"run version conflict: expected {expected}, current {current_version}",
    )


def _resolve_resume_value(previous_status: RunStatus, payload: RunResumeRequest) -> str:
    otp_value = (payload.otp_code or "").strip()
    input_value = (payload.input_text or "").strip()
    note_value = (payload.confirmation_note or "").strip()

    if payload.kind == "checkpoint_ack":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="checkpoint_ack is not supported by the resume endpoint",
        )

    if previous_status == "waiting_otp":
        if payload.kind not in {"otp", "input"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="waiting_otp runs require kind=otp or kind=input",
            )
        value = otp_value or input_value
        if not value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="otp_code is required",
            )
        return value

    if payload.kind == "approval":
        if payload.approved is False:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="resume endpoint does not support negative approval",
            )
        return note_value

    if payload.kind == "otp":
        return otp_value
    return input_value
