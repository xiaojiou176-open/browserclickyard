from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Callable
from uuid import uuid4

from fastapi import HTTPException, status

from app.models.template import OtpPolicy
from app.models.run import RunLogEntry, RunRecord, RunStatus, RunWaitContext
from app.services.automation_service import automation_service
from app.services.otp_providers import OtpFetchRequest, resolve_otp_code as fetch_otp_code


def list_runs(service: Any, limit: int = 100, requester: str | None = None) -> list[RunRecord]:
    raw_items = service._read_json(service._runs_path)
    known_owner_by_run_id: dict[str, str] = {}
    if requester:
        prioritized: list[dict[str, Any]] = []
        unresolved_owner: list[dict[str, Any]] = []
        for item in raw_items:
            run_id = item.get("run_id")
            owner = item.get(service._run_owner_key)
            if isinstance(run_id, str) and isinstance(owner, str):
                known_owner_by_run_id[run_id] = owner
                if owner == requester:
                    prioritized.append(item)
                continue
            unresolved_owner.append(item)
        raw_items = prioritized + unresolved_owner
    items = [RunRecord.model_validate(item) for item in raw_items]
    for item in items:
        service._sync_run_status(item)
    if requester:
        filtered: list[RunRecord] = []
        for item in items:
            known_owner = known_owner_by_run_id.get(item.run_id)
            if known_owner is not None:
                if known_owner == requester:
                    filtered.append(item)
                continue
            if service._run_owner(item) == requester:
                filtered.append(item)
        items = filtered
    items.sort(key=lambda item: item.updated_at, reverse=True)
    return items[: max(1, min(limit, 500))]


def get_run(service: Any, run_id: str, requester: str | None = None) -> RunRecord:
    run = service._load_run_locked(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
    if requester is not None:
        owner = service._run_owner(run)
        if owner != requester:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="run not found")
    service._sync_run_status(run)
    return run


def create_run(
    service: Any,
    template_id: str,
    params: dict[str, str],
    actor: str | None = None,
    otp_code: str | None = None,
) -> RunRecord:
    template = service.get_template(template_id, requester=actor)
    flow = service.get_flow(template.flow_id, requester=actor)
    service._ensure_allowed_param_keys(template.params_schema, params, source="run params")
    merged_params = {**template.defaults, **params}
    service._validate_params(template, merged_params, template.policies.otp)
    now = datetime.now(UTC)
    run = RunRecord(
        run_id=f"rn_{uuid4().hex}",
        template_id=template_id,
        status="queued",
        params=service._public_params(template, merged_params),
        created_at=now,
        updated_at=now,
    )
    run_owner = actor
    service._cache_validated_params_snapshot(run.run_id, merged_params)

    otp_code_resolved = service._resolve_otp_code(template.policies.otp, otp_code)
    if template.policies.otp.required and not otp_code_resolved:
        run.status = "waiting_otp"
        run.wait_context = RunWaitContext(
            reason_code="otp_required",
            resume_hint=f"provide OTP from provider {template.policies.otp.provider}",
            provider_domain=template.policies.otp.provider,
            gate_required_by_policy=True,
            screen_title="Manual verification required",
            allowed_resume_kinds=["otp"],
            input_schema=[
                {
                    "name": "otp_code",
                    "label": "OTP code",
                    "kind": "otp",
                    "required": True,
                    "placeholder": "Enter OTP",
                    "help_text": "Provide the one-time passcode and resume the run.",
                }
            ],
            required_actions=[
                {
                    "kind": "otp",
                    "label": "Submit OTP",
                    "description": "Resume this run with a one-time passcode.",
                }
            ],
        )
        run.logs.append(
            RunLogEntry(
                ts=datetime.now(UTC),
                level="warn",
                message=f"waiting OTP from provider {template.policies.otp.provider}",
            )
        )
        extras = {service._run_owner_key: run_owner} if run_owner else None
        if not service._upsert_run(run, extras=extras, expected_version=0):
            raise _run_version_conflict(service, run.run_id, expected=0)
        service._audit("run.waiting_otp", actor, {"run_id": run.run_id, "template_id": template_id})
        return run

    env = service._build_env(flow.start_url, merged_params, otp_code_resolved)
    task = automation_service.run_command("automation-replay-flow", env, requested_by=actor)
    run.status = service._map_task_status(task.status)
    run.task_id = task.task_id
    run.logs.append(
        RunLogEntry(
            ts=datetime.now(UTC), level="info", message=f"submitted automation task {task.task_id}"
        )
    )
    extras = {service._run_owner_key: run_owner} if run_owner else None
    _persist_run_or_compensate(service, run, task.task_id, actor=actor, extras=extras)
    service._audit(
        "run.create",
        actor,
        {"run_id": run.run_id, "template_id": template_id, "task_id": task.task_id},
    )
    return run


def cancel_run(
    service: Any, run_id: str, actor: str | None = None, expected_version: int | None = None
) -> RunRecord:
    run = service.get_run(run_id, requester=actor)
    if expected_version is not None and run.version != expected_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"run version conflict: expected {expected_version}, current {run.version}",
        )
    base_version = run.version
    if run.task_id:
        try:
            automation_service.cancel_task(run.task_id, requested_by=actor)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_404_NOT_FOUND:
                raise
            run.logs.append(
                RunLogEntry(
                    ts=datetime.now(UTC),
                    level="warn",
                    message="linked task not found during cancel",
                )
            )
    run.status = "cancelled"
    run.task_id = None
    run.wait_context = None
    run.version += 1
    run.updated_at = datetime.now(UTC)
    run.logs.append(RunLogEntry(ts=datetime.now(UTC), level="warn", message="cancelled by user"))
    if not service._upsert_run(run, expected_version=base_version):
        _refresh_run_from_storage(service, run)
        raise _run_version_conflict(service, run_id, expected=base_version)
    service._audit("run.cancel", actor, {"run_id": run_id})
    return run


def sync_run_status(service: Any, run: RunRecord) -> None:
    base_version = run.version
    if run.status == "cancelled":
        if run.task_id is not None or run.wait_context is not None:
            run.task_id = None
            run.wait_context = None
            run.updated_at = datetime.now(UTC)
            if not service._upsert_run(run, expected_version=base_version):
                _refresh_run_from_storage(service, run)
        return
    if not run.task_id:
        return
    try:
        task = automation_service.get_task(run.task_id)
    except HTTPException:
        return
    progress_cursor, progress_logs, wait_context = extract_progress(
        task.output_tail, redact_text=service._redact_text
    )
    if progress_cursor > run.step_cursor:
        run.step_cursor = progress_cursor
        run.updated_at = datetime.now(UTC)
    if progress_logs:
        append_unique_logs(run, progress_logs)
    if wait_context is not None:
        run.wait_context = wait_context
        run.status = "waiting_user"
        run.task_id = None
        run.version += 1
        run.updated_at = datetime.now(UTC)
        wait_reason = wait_context.reason_code or "manual_gate"
        run.logs.append(
            RunLogEntry(
                ts=datetime.now(UTC),
                level="warn",
                message=f"run paused for manual gate: {wait_reason}",
            )
        )
        if not service._upsert_run(run, expected_version=base_version):
            _refresh_run_from_storage(service, run)
        return
    if run.wait_context is not None:
        run.wait_context = None
        run.updated_at = datetime.now(UTC)
    mapped = map_task_status(task.status)
    if mapped != run.status:
        run.status = mapped
        run.version += 1
        run.updated_at = datetime.now(UTC)
        run.logs.append(
            RunLogEntry(ts=datetime.now(UTC), level="info", message=f"status synced to {mapped}")
        )
        if not service._upsert_run(run, expected_version=base_version):
            _refresh_run_from_storage(service, run)
        return
    if progress_cursor > 0 or progress_logs:
        if not service._upsert_run(run, expected_version=base_version):
            _refresh_run_from_storage(service, run)


def map_task_status(task_status: str) -> RunStatus:
    if task_status in {"queued", "running", "success", "failed", "cancelled"}:
        return task_status  # type: ignore[return-value]
    return "failed"


def resolve_otp_code(otp: OtpPolicy, manual_code: str | None) -> str | None:
    if not otp.required:
        return None
    return fetch_otp_code(
        OtpFetchRequest(
            provider=otp.provider,
            regex=otp.regex,
            sender_filter=otp.sender_filter,
            subject_filter=otp.subject_filter,
            manual_code=manual_code,
        )
    )


def build_env(
    start_url: str,
    params: dict[str, str],
    otp_code: str | None,
    *,
    stripe_param_keys: tuple[str, ...],
    is_secret_param_key: Callable[[str], bool],
) -> dict[str, str]:
    env: dict[str, str] = {"START_URL": start_url}
    input_map: dict[str, str] = {}
    secret_map: dict[str, str] = {}
    for key, value in params.items():
        if is_secret_param_key(key):
            secret_map[key] = value
        else:
            input_map[key] = value
        if key in stripe_param_keys:
            env[key] = value
            continue
        if key.lower().endswith("password"):
            env["FLOW_SECRET_INPUT"] = value
        elif key.lower().endswith("otp"):
            env["FLOW_OTP_CODE"] = value
        else:
            env["FLOW_INPUT"] = value
    if input_map:
        env["FLOW_INPUT_JSON"] = json.dumps(input_map, ensure_ascii=False)
    if secret_map:
        env["FLOW_SECRET_INPUT_JSON"] = json.dumps(secret_map, ensure_ascii=False)
    if otp_code:
        env["FLOW_OTP_CODE"] = otp_code
    return env


def extract_progress(
    output_tail: str,
    *,
    redact_text: Callable[[str], str],
) -> tuple[int, list[RunLogEntry], RunWaitContext | None]:
    trimmed = output_tail.strip()
    if not trimmed:
        return 0, [], None
    cursor = 0
    logs: list[RunLogEntry] = []
    start = trimmed.find("{")
    if start < 0:
        return cursor, logs, None
    candidate = trimmed[start:]
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        return cursor, logs, None

    if isinstance(parsed, dict) and isinstance(parsed.get("stepResults"), list):
        step_results = parsed.get("stepResults", [])
        for step in step_results:
            if not isinstance(step, dict):
                continue
            step_id = str(step.get("step_id") or "")
            action = str(step.get("action") or "")
            ok = bool(step.get("ok"))
            detail = redact_text(str(step.get("detail") or ""))
            if step_id:
                cursor += 1
                logs.append(
                    RunLogEntry(
                        ts=datetime.now(UTC),
                        level="info" if ok else "error",
                        message=f"step {step_id} ({action}) {'ok' if ok else 'failed'}: {detail}",
                    )
                )
    elif isinstance(parsed, dict) and parsed.get("stepId"):
        step_id = str(parsed.get("stepId"))
        action = str(parsed.get("action") or "")
        ok = bool(parsed.get("ok"))
        detail = redact_text(str(parsed.get("detail") or ""))
        cursor = 1
        logs.append(
            RunLogEntry(
                ts=datetime.now(UTC),
                level="info" if ok else "error",
                message=f"step {step_id} ({action}) {'ok' if ok else 'failed'}: {detail}",
            )
        )

    wait_context = extract_wait_context(parsed) if isinstance(parsed, dict) else None
    return cursor, logs, wait_context


def extract_wait_context(payload: dict[str, Any]) -> RunWaitContext | None:
    manual_gate = payload.get("manualGate")
    if not isinstance(manual_gate, dict):
        manual_gate = payload.get("manual_gate")
    if not isinstance(manual_gate, dict):
        return None
    gate_required = coerce_optional_bool(
        manual_gate.get("required"),
        manual_gate.get("manual_gate_required"),
        manual_gate.get("manualGateRequired"),
    )
    context = RunWaitContext(
        reason_code=coerce_optional_text(
            manual_gate.get("reason_code"), manual_gate.get("reasonCode")
        ),
        at_step_id=coerce_optional_text(manual_gate.get("at_step_id"), manual_gate.get("atStepId")),
        after_step_id=coerce_optional_text(
            manual_gate.get("after_step_id"), manual_gate.get("afterStepId")
        ),
        resume_from_step_id=coerce_optional_text(
            manual_gate.get("resume_from_step_id"),
            manual_gate.get("resumeFromStepId"),
        ),
        resume_hint=coerce_optional_text(
            manual_gate.get("resume_hint"), manual_gate.get("resumeHint")
        ),
        provider_domain=coerce_optional_text(
            manual_gate.get("provider_domain"),
            manual_gate.get("providerDomain"),
        ),
        gate_required_by_policy=coerce_optional_bool(
            manual_gate.get("gate_required_by_policy"),
            manual_gate.get("gateRequiredByPolicy"),
        ),
        screen_title=coerce_optional_text(
            manual_gate.get("screen_title"),
            manual_gate.get("screenTitle"),
            manual_gate.get("title"),
        ),
        allowed_resume_kinds=_resolve_allowed_resume_kinds(manual_gate),
        input_schema=_normalize_input_schema(manual_gate.get("input_schema"))
        or _default_input_schema(manual_gate),
        required_actions=_normalize_object_list(manual_gate.get("required_actions"))
        or _default_required_actions(manual_gate),
        evidence_refs=_normalize_string_list(
            manual_gate.get("evidence_refs"),
            manual_gate.get("evidenceRefs"),
        ),
    )
    has_anchor = any(
        value is not None
        for value in (
            context.reason_code,
            context.at_step_id,
            context.after_step_id,
            context.resume_from_step_id,
            context.resume_hint,
        )
    )
    if gate_required is not True and not has_anchor:
        return None
    return context


def resolve_resume_from_step_id(wait_context: RunWaitContext | None) -> str | None:
    if wait_context is None:
        return None
    return wait_context.resume_from_step_id or wait_context.after_step_id or wait_context.at_step_id


def coerce_optional_text(*candidates: Any) -> str | None:
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        value = candidate.strip()
        if value:
            return value
    return None


def coerce_optional_bool(*candidates: Any) -> bool | None:
    for candidate in candidates:
        if isinstance(candidate, bool):
            return candidate
        if not isinstance(candidate, str):
            continue
        normalized = candidate.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return None


def _normalize_string_list(*candidates: Any) -> list[str]:
    for candidate in candidates:
        if not isinstance(candidate, list):
            continue
        values = [
            str(item).strip()
            for item in candidate
            if isinstance(item, str) and str(item).strip()
        ]
        if values:
            return values
    return []


def _normalize_object_list(candidate: Any) -> list[dict[str, Any]]:
    if not isinstance(candidate, list):
        return []
    return [item for item in candidate if isinstance(item, dict)]


def _normalize_input_schema(candidate: Any) -> list[dict[str, Any]]:
    rows = _normalize_object_list(candidate)
    normalized: list[dict[str, Any]] = []
    for row in rows:
        name = coerce_optional_text(row.get("name"))
        label = coerce_optional_text(row.get("label"))
        if not name or not label:
            continue
        normalized.append(
            {
                "name": name,
                "label": label,
                "kind": coerce_optional_text(row.get("kind")) or "text",
                "required": bool(row.get("required", False)),
                "placeholder": coerce_optional_text(row.get("placeholder")),
                "help_text": coerce_optional_text(row.get("help_text"), row.get("helpText")),
            }
        )
    return normalized


def _resolve_allowed_resume_kinds(manual_gate: dict[str, Any]) -> list[str]:
    explicit = _normalize_string_list(
        manual_gate.get("allowed_resume_kinds"),
        manual_gate.get("allowedResumeKinds"),
    )
    allowed = [value for value in explicit if value in {"otp", "approval", "input"}]
    if allowed:
        return allowed
    reason_code = (
        coerce_optional_text(manual_gate.get("reason_code"), manual_gate.get("reasonCode")) or ""
    ).lower()
    if "otp" in reason_code:
        return ["otp"]
    if "provider_protected_payment_step" in reason_code:
        return ["approval", "otp", "input"]
    return ["approval", "input"]


def _default_input_schema(manual_gate: dict[str, Any]) -> list[dict[str, Any]]:
    allowed = _resolve_allowed_resume_kinds(manual_gate)
    if allowed == ["otp"]:
        return [
            {
                "name": "otp_code",
                "label": "OTP code",
                "kind": "otp",
                "required": True,
                "placeholder": "Enter OTP",
                "help_text": "Provide the one-time passcode and resume the run.",
            }
        ]
    if "input" in allowed:
        return [
            {
                "name": "input_text",
                "label": "Supplemental input",
                "kind": "text",
                "required": False,
                "placeholder": "Enter supplemental input",
                "help_text": "Provide the missing manual input and continue the run.",
            }
        ]
    return []


def _default_required_actions(manual_gate: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    allowed = _resolve_allowed_resume_kinds(manual_gate)
    if "approval" in allowed:
        actions.append(
            {
                "kind": "approval",
                "label": "Continue after manual review",
                "description": "Confirm you completed the required manual action and resume the run.",
            }
        )
    if "otp" in allowed:
        actions.append(
            {
                "kind": "otp",
                "label": "Submit OTP",
                "description": "Resume the run with a one-time passcode.",
            }
        )
    if "input" in allowed:
        actions.append(
            {
                "kind": "input",
                "label": "Submit supplemental input",
                "description": "Resume the run with additional operator-provided input.",
            }
        )
    return actions


def append_unique_logs(run: RunRecord, entries: list[RunLogEntry]) -> None:
    existing = {entry.message for entry in run.logs}
    for entry in entries:
        if entry.message in existing:
            continue
        run.logs.append(entry)
        existing.add(entry.message)


def _persist_run_or_compensate(
    service: Any,
    run: RunRecord,
    task_id: str,
    *,
    actor: str | None,
    extras: dict[str, Any] | None = None,
) -> None:
    try:
        if not service._upsert_run(run, extras=extras, expected_version=0):
            raise _run_version_conflict(service, run.run_id, expected=0)
    except Exception as exc:
        cancel_error: Exception | None = None
        try:
            automation_service.cancel_task(task_id, requested_by=actor)
        except Exception as cancel_exc:
            cancel_error = cancel_exc
        if isinstance(exc, HTTPException):
            if cancel_error is not None:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="failed to persist run and failed to cancel automation task",
                ) from cancel_error
            raise
        if cancel_error is not None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="failed to persist run and failed to cancel automation task",
            ) from cancel_error
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to persist run after submitting automation task",
        ) from exc


def _refresh_run_from_storage(service: Any, run: RunRecord) -> None:
    latest = service._load_run_locked(run.run_id)
    if latest is None:
        return
    for field_name in RunRecord.model_fields:
        setattr(run, field_name, getattr(latest, field_name))


def _run_version_conflict(service: Any, run_id: str, *, expected: int) -> HTTPException:
    current = service._load_run_locked(run_id)
    current_version = current.version if current is not None else "missing"
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"run version conflict: expected {expected}, current {current_version}",
    )
