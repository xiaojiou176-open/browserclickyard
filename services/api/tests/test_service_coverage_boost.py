from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException, status

import app.services.universal_platform_service as universal_module
import app.services.universal_platform.resume as resume_module
import app.services.universal_platform.run as run_module
from app.models.automation import (
    ReconstructionGenerateRequest,
    ReconstructionPreviewResponse,
)
from app.models.run import RunLogEntry, RunRecord
from app.models.template import (
    OtpPolicy,
    TemplateParamSpec,
    TemplatePolicies,
    TemplateRecord,
)
from app.services.automation_service import RunningTask
from app.services.universal_platform_service import UniversalPlatformService
from app.services.video_reconstruction_service import (
    ResolvedArtifacts,
    VideoReconstructionService,
    safe_resolve_under,
)


def _new_universal_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> UniversalPlatformService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("UNIVERSAL_PLATFORM_DATA_DIR", str(runtime_root / "universal"))
    return UniversalPlatformService()


def _new_video_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> VideoReconstructionService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    return VideoReconstructionService()


def test_universal_validation_and_missing_resource_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as missing_url:
        service.start_session("   ", "manual")
    assert missing_url.value.status_code == 422

    with pytest.raises(HTTPException) as bad_mode:
        service.start_session("https://example.com", "robot")
    assert bad_mode.value.status_code == 422

    with pytest.raises(HTTPException) as missing_session:
        service.finish_session("ss-missing")
    assert missing_session.value.status_code == 404

    with pytest.raises(HTTPException) as missing_flow:
        service.get_flow("fl-missing")
    assert missing_flow.value.status_code == 404

    with pytest.raises(HTTPException) as missing_template:
        service.get_template("tp-missing")
    assert missing_template.value.status_code == 404

    with pytest.raises(HTTPException) as missing_update:
        service.update_template("tp-missing", name="x")
    assert missing_update.value.status_code == 404

    with pytest.raises(HTTPException) as missing_preview:
        service.generate_reconstruction(ReconstructionGenerateRequest())
    assert missing_preview.value.status_code == 422


def test_universal_import_latest_flow_draft_error_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    latest = service._runtime_root / "latest-session.json"
    session_dir = service._runtime_root / "session-a"
    session_dir.mkdir(parents=True, exist_ok=True)
    flow_path = session_dir / "flow-draft.json"

    with pytest.raises(HTTPException) as no_pointer:
        service.import_latest_flow_draft()
    assert no_pointer.value.status_code == 404

    latest.write_text("{ broken", encoding="utf-8")
    with pytest.raises(HTTPException) as invalid_pointer:
        service.import_latest_flow_draft()
    assert invalid_pointer.value.status_code == 500

    latest.write_text(json.dumps({"sessionId": "s-only"}), encoding="utf-8")
    with pytest.raises(HTTPException) as missing_keys:
        service.import_latest_flow_draft()
    assert missing_keys.value.status_code == 500

    latest.write_text(
        json.dumps({"sessionId": "s-a", "sessionDir": str(session_dir)}), encoding="utf-8"
    )
    with pytest.raises(HTTPException) as missing_flow:
        service.import_latest_flow_draft()
    assert missing_flow.value.status_code == 404

    flow_path.write_text("{ invalid", encoding="utf-8")
    with pytest.raises(HTTPException) as invalid_flow:
        service.import_latest_flow_draft()
    assert invalid_flow.value.status_code == 500

    flow_path.write_text("[]", encoding="utf-8")
    with pytest.raises(HTTPException) as invalid_shape:
        service.import_latest_flow_draft()
    assert invalid_shape.value.status_code == 500

    flow_path.write_text(json.dumps({"start_url": "", "steps": []}), encoding="utf-8")
    with pytest.raises(HTTPException) as missing_fields:
        service.import_latest_flow_draft()
    assert missing_fields.value.status_code == 422


def test_universal_helpers_filters_and_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    assert "actor" in service.list_templates.__code__.co_varnames, (
        "actor-filtered template listing was removed from current universal service API"
    )
    now = datetime.now(UTC)

    session = service.start_session("https://example.com", "manual", owner="owner-a")
    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        owner="owner-a",
    )
    assert service.list_flows(actor="owner-b") == []

    template = service.create_template(
        flow_id=flow.flow_id,
        name="template-a",
        params_schema=[{"key": "username", "type": "string", "required": True}],
        defaults={"username": "u"},
        policies={"otp": {"required": False, "provider": "manual"}},
        created_by="owner-a",
    )
    assert service.list_templates(actor="owner-b") == []

    run = RunRecord(
        run_id="rn-a",
        template_id=template.template_id,
        status="queued",
        params={"username": "u"},
        created_at=now,
        updated_at=now,
    )
    service._upsert_run(
        run,
        extras={
            service._run_owner_key: "owner-a",
            service._run_resume_params_key: {"username": "u"},
        },
    )
    assert service.list_runs(actor="owner-b") == []
    assert service._map_task_status("unexpected") == "failed"
    assert service._score_flow([]) == 0
    assert service._normalize_snapshot_params("not-a-dict") == {}
    assert service._normalize_snapshot_params({1: "x", "k": None}) == {"k": ""}

    required_template = TemplateRecord(
        template_id="tp-required",
        flow_id=flow.flow_id,
        name="required",
        params_schema=[TemplateParamSpec(key="username", type="string", required=True)],
        defaults={},
        policies=TemplatePolicies(otp=OtpPolicy(required=False)),
        created_by="owner-a",
        created_at=now,
        updated_at=now,
    )
    with pytest.raises(HTTPException) as required_error:
        service._validate_params(required_template, {}, required_template.policies.otp)
    assert required_error.value.status_code == 422

    enum_template = required_template.model_copy(
        update={
            "params_schema": [
                TemplateParamSpec(key="tier", type="enum", required=False, enum_values=["pro"])
            ]
        }
    )
    with pytest.raises(HTTPException):
        service._validate_params(enum_template, {"tier": "free"}, enum_template.policies.otp)

    regex_template = required_template.model_copy(
        update={
            "params_schema": [
                TemplateParamSpec(key="otp", type="regex", required=False, pattern=r"^\d{6}$")
            ]
        }
    )
    with pytest.raises(HTTPException):
        service._validate_params(regex_template, {"otp": "abc"}, regex_template.policies.otp)

    email_template = required_template.model_copy(
        update={"params_schema": [TemplateParamSpec(key="email", type="email", required=False)]}
    )
    with pytest.raises(HTTPException):
        service._validate_params(
            email_template, {"email": "invalid-email"}, email_template.policies.otp
        )

    secret_template = required_template.model_copy(
        update={
            "params_schema": [TemplateParamSpec(key="password", type="secret", required=False)],
            "defaults": {"password": "hidden"},
        }
    )
    assert service._export_scrubbed_defaults(secret_template)["password"] == "***"
    assert (
        service.autofill_required_run_params(
            required_template.model_copy(
                update={
                    "params_schema": [
                        TemplateParamSpec(key="email", type="email"),
                        TemplateParamSpec(key="password", type="secret"),
                        TemplateParamSpec(key="username", type="string"),
                    ],
                    "defaults": {"username": "fallback-user"},
                }
            )
        )["username"]
        == "fallback-user"
    )

    assert service._extract_progress("") == (0, [])
    assert service._extract_progress("plain text without json") == (0, [])
    assert service._extract_progress("{ bad json") == (0, [])
    cursor, logs = service._extract_progress(
        json.dumps(
            {
                "stepResults": [
                    "bad",
                    {"step_id": "s1", "action": "click", "ok": True, "detail": "done"},
                ]
            }
        )
    )
    assert cursor == 1
    assert logs and "step s1" in logs[0].message
    single_cursor, single_logs = service._extract_progress(
        json.dumps({"stepId": "sx", "action": "type", "ok": False, "detail": "no"})
    )
    assert single_cursor == 1
    assert single_logs and "failed" in single_logs[0].message

    run.logs = [RunLogEntry(ts=now, level="info", message="dup")]
    service._append_unique_logs(
        run,
        [
            RunLogEntry(ts=now, level="info", message="dup"),
            RunLogEntry(ts=now, level="warn", message="new"),
        ],
    )
    assert [entry.message for entry in run.logs] == ["dup", "new"]


def test_universal_json_io_upsert_and_cancel_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    now = datetime.now(UTC)

    service._runs_path.parent.mkdir(parents=True, exist_ok=True)
    service._runs_path.write_text(
        json.dumps(
            [
                {
                    "run_id": "rn-1",
                    "template_id": "tp-1",
                    "status": "queued",
                    "step_cursor": 0,
                    "params": {},
                    "task_id": "task-1",
                    "created_at": now.isoformat(),
                    "updated_at": now.isoformat(),
                    "logs": [],
                    "_legacy_hint": "keep",
                }
            ],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    service._upsert_run(
        RunRecord(
            run_id="rn-1",
            template_id="tp-1",
            status="queued",
            task_id="task-1",
            params={},
            created_at=now,
            updated_at=now,
        ),
        extras={service._run_owner_key: "owner-a"},
    )
    persisted = json.loads(service._runs_path.read_text(encoding="utf-8"))
    assert persisted[0]["_legacy_hint"] == "keep"
    assert persisted[0][service._run_owner_key] == "owner-a"

    invalid_json_path = tmp_path / "invalid.json"
    invalid_json_path.write_text("{ broken", encoding="utf-8")
    assert service._read_json(invalid_json_path) == []
    invalid_json_path.write_text(json.dumps({"not": "a-list"}), encoding="utf-8")
    assert service._read_json(invalid_json_path) == []
    invalid_json_path.write_text(json.dumps([{"k": 1}, "skip"]), encoding="utf-8")
    assert service._read_json(invalid_json_path) == [{"k": 1}]

    def _cancel_missing(*_args: Any, **_kwargs: Any):
        _ = (_args, _kwargs)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="missing")

    automation_target = getattr(
        universal_module, "automation_service", run_module.automation_service
    )
    monkeypatch.setattr(automation_target, "cancel_task", _cancel_missing)
    cancelled = service.cancel_run("rn-1", actor="owner-a")
    assert cancelled.status == "cancelled"
    assert any("not found" in entry.message for entry in cancelled.logs)


def test_universal_runs_file_lock_invokes_flock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    calls: list[int] = []

    class _FakeFcntl:
        LOCK_EX = 2
        LOCK_UN = 8

        @staticmethod
        def flock(_fd: int, op: int) -> None:
            calls.append(op)

    monkeypatch.setattr(universal_module, "fcntl", _FakeFcntl)
    now = datetime.now(UTC)
    service._upsert_run(
        RunRecord(
            run_id="rn-lock",
            template_id="tp-lock",
            status="queued",
            params={},
            created_at=now,
            updated_at=now,
        ),
        extras={service._run_owner_key: "owner-a"},
    )

    assert _FakeFcntl.LOCK_EX in calls
    assert _FakeFcntl.LOCK_UN in calls


def test_create_run_compensates_when_run_persist_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    session = service.start_session("https://example.com", "manual", owner="owner-a")
    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        requester="owner-a",
    )
    template = service.create_template(
        flow_id=flow.flow_id,
        name="persist-fail-template",
        params_schema=[],
        defaults={},
        policies={"otp": {"required": False, "provider": "manual"}},
        created_by="owner-a",
    )

    now = datetime.now(UTC)
    monkeypatch.setattr(
        run_module.automation_service,
        "run_command",
        lambda command_id, env_overrides, *, requested_by: RunningTask(
            task_id="task-compensate-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot(),
    )
    cancelled: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        run_module.automation_service,
        "cancel_task",
        lambda task_id, requested_by=None: cancelled.append((task_id, requested_by)),
    )
    monkeypatch.setattr(
        service,
        "_upsert_run",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("disk full")),
    )

    with pytest.raises(HTTPException) as exc:
        service.create_run(template.template_id, params={}, actor="owner-a")
    assert exc.value.status_code == 500
    assert "failed to persist run after submitting automation task" in str(exc.value.detail)
    assert cancelled == [("task-compensate-1", "owner-a")]


def test_resume_compensates_when_run_persist_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    session = service.start_session("https://example.com/otp", "manual", owner="owner-a")
    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com/otp",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com/otp"}],
        requester="owner-a",
    )
    template = service.create_template(
        flow_id=flow.flow_id,
        name="resume-persist-fail",
        params_schema=[],
        defaults={},
        policies={"otp": {"required": True, "provider": "manual", "regex": r"\b(\d{6})\b"}},
        created_by="owner-a",
    )
    waiting = service.create_run(template.template_id, params={}, actor="owner-a")
    assert waiting.status == "waiting_otp"

    now = datetime.now(UTC)
    monkeypatch.setattr(
        resume_module.automation_service,
        "run_command",
        lambda command_id, env_overrides, *, requested_by: RunningTask(
            task_id="task-resume-compensate-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot(),
    )
    cancelled: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        resume_module.automation_service,
        "cancel_task",
        lambda task_id, requested_by=None: cancelled.append((task_id, requested_by)),
    )
    original_save_run_locked = service._save_run_locked
    save_calls = {"n": 0}

    def flaky_save_run_locked(*args: Any, **kwargs: Any) -> Any:
        save_calls["n"] += 1
        if save_calls["n"] == 2:
            raise RuntimeError("persist failed during resume handoff")
        return original_save_run_locked(*args, **kwargs)

    monkeypatch.setattr(service, "_save_run_locked", flaky_save_run_locked)
    with pytest.raises(HTTPException) as exc:
        service.submit_otp_and_resume(waiting.run_id, "123456", actor="owner-a")
    assert exc.value.status_code == 500
    assert "failed to persist resumed run after submitting automation task" in str(exc.value.detail)
    assert cancelled == [("task-resume-compensate-1", "owner-a")]


def test_create_run_surfaces_cancel_failure_when_compensation_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    session = service.start_session("https://example.com", "manual", owner="owner-a")
    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        requester="owner-a",
    )
    template = service.create_template(
        flow_id=flow.flow_id,
        name="persist-fail-cancel-fail-template",
        params_schema=[],
        defaults={},
        policies={"otp": {"required": False, "provider": "manual"}},
        created_by="owner-a",
    )

    now = datetime.now(UTC)
    monkeypatch.setattr(
        run_module.automation_service,
        "run_command",
        lambda command_id, env_overrides, *, requested_by: RunningTask(
            task_id="task-compensate-fail-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot(),
    )
    monkeypatch.setattr(
        run_module.automation_service,
        "cancel_task",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("cancel failed")),
    )
    monkeypatch.setattr(
        service,
        "_upsert_run",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("disk full")),
    )

    with pytest.raises(HTTPException) as exc:
        service.create_run(template.template_id, params={}, actor="owner-a")
    assert exc.value.status_code == 500
    assert "failed to persist run and failed to cancel automation task" in str(exc.value.detail)


def test_resume_surfaces_cancel_failure_when_compensation_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    session = service.start_session("https://example.com/otp", "manual", owner="owner-a")
    flow = service.create_flow(
        session_id=session.session_id,
        start_url="https://example.com/otp",
        steps=[{"step_id": "s1", "action": "navigate", "url": "https://example.com/otp"}],
        requester="owner-a",
    )
    template = service.create_template(
        flow_id=flow.flow_id,
        name="resume-cancel-fail",
        params_schema=[],
        defaults={},
        policies={"otp": {"required": True, "provider": "manual", "regex": r"\b(\d{6})\b"}},
        created_by="owner-a",
    )
    waiting = service.create_run(template.template_id, params={}, actor="owner-a")
    assert waiting.status == "waiting_otp"

    now = datetime.now(UTC)
    monkeypatch.setattr(
        resume_module.automation_service,
        "run_command",
        lambda command_id, env_overrides, *, requested_by: RunningTask(
            task_id="task-resume-compensate-fail-1",
            command_id=command_id,
            status="queued",
            created_at=now,
            requested_by=requested_by,
        ).snapshot(),
    )
    monkeypatch.setattr(
        resume_module.automation_service,
        "cancel_task",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("cancel failed")),
    )
    original_save_run_locked = service._save_run_locked
    save_calls = {"n": 0}

    def flaky_save_run_locked(*args: Any, **kwargs: Any) -> Any:
        save_calls["n"] += 1
        if save_calls["n"] == 2:
            raise RuntimeError("persist failed during resume handoff")
        return original_save_run_locked(*args, **kwargs)

    monkeypatch.setattr(service, "_save_run_locked", flaky_save_run_locked)
    with pytest.raises(HTTPException) as exc:
        service.submit_otp_and_resume(waiting.run_id, "123456", actor="owner-a")
    assert exc.value.status_code == 500
    assert "failed to persist resumed run and failed to cancel automation task" in str(
        exc.value.detail
    )


def test_list_runs_uses_persisted_owner_without_owner_lookup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_universal_service(monkeypatch, tmp_path)
    now = datetime.now(UTC).isoformat()
    service._runs_path.parent.mkdir(parents=True, exist_ok=True)
    service._runs_path.write_text(
        json.dumps(
            [
                {
                    "run_id": "rn-a1",
                    "template_id": "tp-1",
                    "status": "queued",
                    "params": {},
                    "created_at": now,
                    "updated_at": now,
                    "logs": [],
                    service._run_owner_key: "owner-a",
                },
                {
                    "run_id": "rn-a2",
                    "template_id": "tp-2",
                    "status": "queued",
                    "params": {},
                    "created_at": now,
                    "updated_at": now,
                    "logs": [],
                    service._run_owner_key: "owner-a",
                },
                {
                    "run_id": "rn-b1",
                    "template_id": "tp-3",
                    "status": "queued",
                    "params": {},
                    "created_at": now,
                    "updated_at": now,
                    "logs": [],
                    service._run_owner_key: "owner-b",
                },
            ],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(service, "_sync_run_status", lambda run: None)

    def _unexpected_owner_lookup(_run: RunRecord) -> str | None:
        raise AssertionError("list_runs should use persisted owner and skip _run_owner lookup")

    monkeypatch.setattr(service, "_run_owner", _unexpected_owner_lookup)
    listed = service.list_runs(actor="owner-a")
    assert [item.run_id for item in listed] == ["rn-a1", "rn-a2"]


def test_video_safe_paths_and_helper_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "root"
    root.mkdir(parents=True)
    inside = root / "artifact.har"
    inside.write_text("{}", encoding="utf-8")
    outside = tmp_path / "outside.har"
    outside.write_text("{}", encoding="utf-8")

    with pytest.raises(HTTPException):
        safe_resolve_under(root, inside, allowed_exts={".json"}, max_bytes=1024)
    with pytest.raises(HTTPException):
        safe_resolve_under(root, outside, allowed_exts={".har"}, max_bytes=1024)

    service = _new_video_service(monkeypatch, tmp_path)
    assert hasattr(service, "_artifact_max_bytes"), (
        "artifact_max_bytes helper no longer exists in current reconstruction service"
    )
    monkeypatch.setenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", "bad")
    assert service._artifact_max_bytes() == 16 * 1024 * 1024
    monkeypatch.setenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", "0")
    assert service._artifact_max_bytes() == 1

    session_dir = service._runtime_root / "s1"
    session_dir.mkdir(parents=True, exist_ok=True)
    assert (
        service._resolve_optional_path(session_dir, None, "missing.har", allowed_exts={".har"})
        is None
    )
    fallback_dir = session_dir / "register.har"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    with pytest.raises(HTTPException):
        service._resolve_optional_path(session_dir, None, "register.har", allowed_exts={".har"})

    assert (
        service._discover_start_url([{"url": "ftp://x"}, {"url": "https://ok.example"}])
        == "https://ok.example"
    )
    assert service._calculate_quality([]) == 0
    assert service._default_generator_outputs("prv-x")["flow_draft"].endswith(
        "/prv-x/flow-draft.json"
    )

    action_endpoint = service._pick_action_endpoint(
        [
            {"method": "GET", "url": "https://example.com/app.js", "status": 200},
            {"method": "POST", "url": "https://example.com/api/register", "status": 201},
            {"method": "GET", "url": "https://example.com/api/csrf", "status": 200},
        ]
    )
    assert action_endpoint is not None
    assert action_endpoint["path"] == "/api/register"

    assert service._derive_bootstrap_sequence([], None) == []
    assert (
        service._derive_bootstrap_sequence([], {"method": "POST", "fullUrl": "", "path": "/x"})
        == []
    )
    bootstrap = service._derive_bootstrap_sequence(
        [
            {"method": "GET", "url": "https://example.com/api/csrf", "status": 200},
            {"method": "GET", "url": "https://example.com/challenge", "status": 200},
            {"method": "POST", "url": "https://example.com/api/register", "status": 201},
            {"method": "GET", "url": "https://example.com/preflight", "status": 200},
        ],
        {"method": "POST", "fullUrl": "https://example.com/api/register", "path": "/api/register"},
    )
    assert bootstrap
    assert bootstrap[-1]["reason"] in {
        "context-bootstrap",
        "token-bootstrap",
        "protection-bootstrap",
    }


def test_video_ensemble_codegen_and_materialization(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_video_service(monkeypatch, tmp_path)
    assert hasattr(service, "_lavague"), (
        "ensemble adapters were removed from current reconstruction service"
    )

    monkeypatch.setattr(
        service._gemini,
        "extract_steps",
        lambda _: [
            {"step_id": "s1", "action": "navigate", "confidence": 0.9, "source_engine": "gemini"},
            {"step_id": "s2", "action": "click", "confidence": 0.4, "source_engine": "gemini"},
        ],
    )
    monkeypatch.setattr(
        service._lavague,
        "extract_steps",
        lambda _: [
            {"step_id": "s1", "action": "navigate", "confidence": 0.1, "source_engine": "lavague"}
        ],
    )
    monkeypatch.setattr(
        service._ui_tars,
        "extract_steps",
        lambda _: [
            {"step_id": "s2", "action": "click", "confidence": 0.95, "source_engine": "ui_tars"}
        ],
    )
    monkeypatch.setattr(service._openadapt, "extract_steps", lambda _: [])

    artifacts = ResolvedArtifacts(
        start_url="https://example.com",
        session_dir=service._runtime_root / "session-e",
        video_path=None,
        har_path=None,
        html_path=None,
        html_content="<html/>",
        har_entries=[],
    )
    merged = service._extract_steps(artifacts, "ensemble", "balanced")
    assert merged
    assert len(merged) >= 2

    assert service._normalize_codegen_steps("not-a-list") == []
    normalized = service._normalize_codegen_steps(
        [
            "skip",
            {
                "step_id": "s1",
                "action": "click",
                "target": {
                    "selectors": [
                        "skip",
                        {"kind": "css", "value": "#ok"},
                        {"kind": "", "value": "x"},
                    ]
                },
                "selected_selector_index": 0,
                "preconditions": ["a", 1],
            },
        ]
    )
    assert len(normalized) == 1
    assert normalized[0]["selectors"] == [{"kind": "css", "value": "#ok"}]

    api_spec = service._build_generated_api(
        {"start_url": "https://example.com", "action_endpoint": "bad", "bootstrap_sequence": {}}
    )
    assert "generated reconstruction api replay" in api_spec
    assert "ACTION_ENDPOINT" in api_spec

    flow_draft = {
        "flow_id": "fl-g",
        "start_url": "https://example.com",
        "steps": [{"step_id": "s1", "action": "navigate", "confidence": 0.8}],
        "action_endpoint": {
            "method": "POST",
            "path": "/api/register",
            "fullUrl": "https://example.com/api/register",
        },
        "bootstrap_sequence": [],
    }
    outputs = service._materialize_generated_outputs("prv-materialize", flow_draft)
    assert Path(outputs["flow_draft"]).exists()
    assert Path(outputs["playwright_spec"]).exists()
    assert Path(outputs["api_spec"]).exists()
    assert Path(outputs["readiness_report"]).exists()

    preview = ReconstructionPreviewResponse(
        preview_id="prv-materialize",
        flow_draft=flow_draft,
        reconstructed_flow_quality=80,
        step_confidence=[0.8],
        unresolved_segments=[],
        generator_outputs=outputs,
    )
    generated = service.generate(preview)
    assert generated.flow_id == "fl-g"
