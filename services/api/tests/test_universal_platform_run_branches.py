from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from app.models.run import RunLogEntry, RunRecord, RunWaitContext
from app.models.template import OtpPolicy
from app.services.universal_platform import run as run_ops


def _make_run(
    *,
    run_id: str = "run-1",
    status: str = "queued",
    version: int = 1,
    task_id: str | None = None,
    wait_context: RunWaitContext | None = None,
    step_cursor: int = 0,
    updated_at: datetime | None = None,
    logs: list[RunLogEntry] | None = None,
) -> RunRecord:
    now = updated_at or datetime.now(UTC)
    return RunRecord(
        run_id=run_id,
        template_id="tpl-1",
        status=status,  # type: ignore[arg-type]
        version=version,
        task_id=task_id,
        wait_context=wait_context,
        step_cursor=step_cursor,
        created_at=now,
        updated_at=now,
        logs=list(logs or []),
    )


def test_list_runs_handles_owner_fallback_filter_and_limit_floor() -> None:
    now = datetime.now(UTC)
    run_owned = _make_run(run_id="run-owned", updated_at=now - timedelta(minutes=2))
    run_other = _make_run(run_id="run-other", updated_at=now - timedelta(minutes=1))
    run_fallback = _make_run(run_id="run-fallback", updated_at=now)
    raw_items = [
        {**run_owned.model_dump(mode="json"), "owner": "alice"},
        {**run_other.model_dump(mode="json"), "owner": "bob"},
        {**run_fallback.model_dump(mode="json"), "owner": 42},
    ]

    class ListService:
        _runs_path = "runs.json"
        _run_owner_key = "owner"

        def __init__(self) -> None:
            self.sync_calls: list[str] = []
            self.owner_calls: list[str] = []

        def _read_json(self, path: str) -> list[dict[str, Any]]:
            assert path == self._runs_path
            return list(raw_items)

        def _sync_run_status(self, item: RunRecord) -> None:
            self.sync_calls.append(item.run_id)

        def _run_owner(self, run: RunRecord) -> str | None:
            self.owner_calls.append(run.run_id)
            return "alice" if run.run_id == "run-fallback" else "nobody"

    service = ListService()

    filtered = run_ops.list_runs(service, limit=100, requester="alice")
    assert [item.run_id for item in filtered] == ["run-fallback", "run-owned"]
    assert service.sync_calls == ["run-owned", "run-fallback"]
    assert service.owner_calls == ["run-fallback"]

    floor_limited = run_ops.list_runs(service, limit=0, requester="alice")
    assert len(floor_limited) == 1


def test_get_run_missing_and_owner_mismatch() -> None:
    class GetService:
        def __init__(self, run: RunRecord | None, owner: str = "owner-a") -> None:
            self._run = run
            self._owner = owner
            self.synced = False

        def _load_run_locked(self, run_id: str) -> RunRecord | None:
            assert run_id == "run-1"
            return self._run

        def _run_owner(self, run: RunRecord) -> str | None:
            return self._owner

        def _sync_run_status(self, run: RunRecord) -> None:
            self.synced = True

    with pytest.raises(HTTPException) as missing:
        run_ops.get_run(GetService(None), "run-1")
    assert missing.value.status_code == 404

    with pytest.raises(HTTPException) as forbidden:
        run_ops.get_run(GetService(_make_run(), owner="owner-a"), "run-1", requester="owner-b")
    assert forbidden.value.status_code == 404

    ok_service = GetService(_make_run(), owner="owner-a")
    got = run_ops.get_run(ok_service, "run-1", requester="owner-a")
    assert got.run_id == "run-1"
    assert ok_service.synced is True


def test_create_run_waiting_otp_conflict_raises_409() -> None:
    otp = OtpPolicy(required=True, provider="manual")
    template = SimpleNamespace(
        flow_id="flow-1",
        defaults={},
        params_schema=[],
        policies=SimpleNamespace(otp=otp),
    )
    flow = SimpleNamespace(start_url="https://example.com")

    class CreateService:
        _run_owner_key = "owner"

        def get_template(self, template_id: str, requester: str | None = None) -> Any:
            assert template_id == "tpl-1"
            return template

        def get_flow(self, flow_id: str, requester: str | None = None) -> Any:
            assert flow_id == "flow-1"
            return flow

        def _ensure_allowed_param_keys(self, *args: Any, **kwargs: Any) -> None:
            return None

        def _validate_params(self, *args: Any, **kwargs: Any) -> None:
            return None

        def _public_params(self, template_obj: Any, merged: dict[str, str]) -> dict[str, str]:
            return dict(merged)

        def _cache_validated_params_snapshot(self, run_id: str, params: dict[str, str]) -> None:
            return None

        def _resolve_otp_code(self, otp_policy: OtpPolicy, otp_code: str | None) -> str | None:
            assert otp_policy.required is True
            return None

        def _upsert_run(
            self, run: RunRecord, extras: dict[str, Any] | None = None, expected_version: int = 0
        ) -> bool:
            assert expected_version == 0
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return _make_run(run_id=run_id, version=7)

        def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
            return None

    with pytest.raises(HTTPException) as conflict:
        run_ops.create_run(CreateService(), "tpl-1", {}, actor="owner-a")
    assert conflict.value.status_code == 409
    assert "expected 0, current 7" in conflict.value.detail


def test_cancel_run_reraises_non_404_cancel_error(monkeypatch: pytest.MonkeyPatch) -> None:
    run = _make_run(status="running", task_id="task-1")

    class CancelService:
        def get_run(self, run_id: str, requester: str | None = None) -> RunRecord:
            return run

        def _upsert_run(self, record: RunRecord, expected_version: int | None = None) -> bool:
            return True

        def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
            return None

    def fail_cancel(task_id: str, requested_by: str | None = None) -> None:
        raise HTTPException(status_code=500, detail="cancel backend failed")

    monkeypatch.setattr(run_ops.automation_service, "cancel_task", fail_cancel)

    with pytest.raises(HTTPException) as raised:
        run_ops.cancel_run(CancelService(), "run-1", actor="owner-a")
    assert raised.value.status_code == 500
    assert raised.value.detail == "cancel backend failed"


def test_cancel_run_refreshes_and_conflicts_on_persist_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial = _make_run(
        run_id="run-1",
        status="running",
        version=2,
        task_id="task-1",
        wait_context=RunWaitContext(reason_code="manual_gate"),
    )
    latest = _make_run(run_id="run-1", status="failed", version=9, task_id=None, wait_context=None)

    class CancelService:
        def __init__(self) -> None:
            self.run = initial

        def get_run(self, run_id: str, requester: str | None = None) -> RunRecord:
            return self.run

        def _upsert_run(self, record: RunRecord, expected_version: int | None = None) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return latest

        def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
            return None

    monkeypatch.setattr(run_ops.automation_service, "cancel_task", lambda *args, **kwargs: None)
    service = CancelService()

    with pytest.raises(HTTPException) as conflict:
        run_ops.cancel_run(service, "run-1", actor="owner-a")
    assert conflict.value.status_code == 409
    assert service.run.version == 9
    assert service.run.status == "failed"


def test_sync_run_status_cancelled_refreshes_when_upsert_conflicts() -> None:
    run = _make_run(
        run_id="run-1",
        status="cancelled",
        version=3,
        task_id="task-1",
        wait_context=RunWaitContext(reason_code="stale"),
    )
    latest = _make_run(
        run_id="run-1", status="cancelled", version=6, task_id=None, wait_context=None
    )

    class SyncService:
        def _upsert_run(self, record: RunRecord, expected_version: int | None = None) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return latest

    run_ops.sync_run_status(SyncService(), run)
    assert run.version == 6
    assert run.task_id is None
    assert run.wait_context is None


def test_sync_run_status_manual_gate_conflict_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    run = _make_run(run_id="run-1", status="running", version=1, task_id="task-1")
    latest = _make_run(run_id="run-1", status="waiting_user", version=8, task_id=None)
    output_tail = json.dumps({"manualGate": {"reasonCode": "captcha_required"}})

    class SyncService:
        def _redact_text(self, text: str) -> str:
            return text

        def _upsert_run(self, record: RunRecord, expected_version: int | None = None) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return latest

    monkeypatch.setattr(
        run_ops.automation_service,
        "get_task",
        lambda task_id, requested_by=None: SimpleNamespace(
            status="running", output_tail=output_tail
        ),
    )
    run_ops.sync_run_status(SyncService(), run)
    assert run.version == 8
    assert run.status == "waiting_user"


def test_sync_run_status_clears_wait_context_and_conflicted_progress_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _make_run(
        run_id="run-1",
        status="running",
        version=4,
        task_id="task-1",
        wait_context=RunWaitContext(reason_code="old-gate"),
        step_cursor=0,
    )
    latest = _make_run(
        run_id="run-1",
        status="running",
        version=10,
        task_id="task-1",
        wait_context=None,
        step_cursor=3,
    )
    output_tail = json.dumps(
        {"stepResults": [{"step_id": "s1", "action": "click", "ok": True, "detail": "ok"}]}
    )

    class SyncService:
        def _redact_text(self, text: str) -> str:
            return f"safe:{text}"

        def _upsert_run(self, record: RunRecord, expected_version: int | None = None) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return latest

    monkeypatch.setattr(
        run_ops.automation_service,
        "get_task",
        lambda task_id, requested_by=None: SimpleNamespace(
            status="running", output_tail=output_tail
        ),
    )
    run_ops.sync_run_status(SyncService(), run)
    assert run.version == 10
    assert run.wait_context is None
    assert run.step_cursor == 3


def test_build_env_covers_password_and_otp_suffix() -> None:
    env = run_ops.build_env(
        "https://start.example.com",
        {
            "accountPassword": "pw",  # pragma: allowlist secret
            "emailOtp": "111222",
            "displayName": "alice",
            "stripeCardNumber": "4242",
        },
        otp_code=None,
        stripe_param_keys=("stripeCardNumber",),
        is_secret_param_key=lambda key: (
            key.lower().endswith("password") or key == "stripeCardNumber"
        ),
    )
    assert env["START_URL"] == "https://start.example.com"
    assert env["FLOW_SECRET_INPUT"] == "pw"  # pragma: allowlist secret
    assert env["FLOW_OTP_CODE"] == "111222"
    assert env["FLOW_INPUT"] == "alice"
    assert env["stripeCardNumber"] == "4242"
    assert json.loads(env["FLOW_SECRET_INPUT_JSON"]) == {
        "accountPassword": "pw",  # pragma: allowlist secret
        "stripeCardNumber": "4242",
    }
    assert json.loads(env["FLOW_INPUT_JSON"]) == {"emailOtp": "111222", "displayName": "alice"}


def test_extract_progress_handles_no_json_invalid_json_and_non_dict_steps() -> None:
    assert run_ops.extract_progress("plain text", redact_text=lambda text: text) == (0, [], None)

    cursor, logs, wait_context = run_ops.extract_progress(
        "prefix {not-json", redact_text=lambda text: text
    )
    assert cursor == 0
    assert logs == []
    assert wait_context is None

    cursor, logs, wait_context = run_ops.extract_progress(
        json.dumps(
            {
                "stepResults": [
                    1,
                    {"step_id": "", "action": "noop", "ok": True, "detail": "ignored"},
                    {"step_id": "s2", "action": "click", "ok": False, "detail": "raw secret"},
                ]
            }
        ),
        redact_text=lambda text: f"redacted:{text}",
    )
    assert cursor == 1
    assert len(logs) == 1
    assert logs[0].level == "error"
    assert "redacted:raw secret" in logs[0].message
    assert wait_context is None


def test_extract_progress_supports_single_step_payload() -> None:
    cursor, logs, wait_context = run_ops.extract_progress(
        json.dumps({"stepId": "s9", "action": "type", "ok": True, "detail": "ok"}),
        redact_text=lambda text: text,
    )
    assert cursor == 1
    assert len(logs) == 1
    assert logs[0].level == "info"
    assert "step s9 (type) ok: ok" in logs[0].message
    assert wait_context is None


def test_extract_wait_context_requires_anchor_or_required_true() -> None:
    payload = {"manual_gate": {"required": "false"}}
    assert run_ops.extract_wait_context(payload) is None


def test_resolve_resume_from_step_and_coercion_helpers() -> None:
    assert run_ops.resolve_resume_from_step_id(None) is None
    context = RunWaitContext(after_step_id="after-1")
    assert run_ops.resolve_resume_from_step_id(context) == "after-1"

    assert run_ops.coerce_optional_text(None, "   ", " chosen ") == "chosen"
    assert run_ops.coerce_optional_bool(" true ") is True
    assert run_ops.coerce_optional_bool("0") is False


def test_append_unique_logs_skips_duplicates() -> None:
    first = RunLogEntry(ts=datetime.now(UTC), level="info", message="duplicate")
    duplicate = RunLogEntry(ts=datetime.now(UTC), level="warn", message="duplicate")
    new = RunLogEntry(ts=datetime.now(UTC), level="error", message="new")
    run = _make_run(logs=[first])

    run_ops.append_unique_logs(run, [duplicate, new])
    assert [entry.message for entry in run.logs] == ["duplicate", "new"]


def test_persist_run_compensate_reraises_conflict_when_cancel_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _make_run(run_id="run-1")

    class PersistService:
        def _upsert_run(self, record: RunRecord, extras=None, expected_version: int = 0) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return _make_run(run_id=run_id, version=9)

    monkeypatch.setattr(run_ops.automation_service, "cancel_task", lambda *args, **kwargs: None)

    with pytest.raises(HTTPException) as excinfo:
        run_ops._persist_run_or_compensate(PersistService(), run, "task-1", actor="owner-a")
    assert excinfo.value.status_code == 409
    assert "expected 0, current 9" in excinfo.value.detail


def test_persist_run_compensate_http_conflict_and_cancel_failure_becomes_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _make_run(run_id="run-1")

    class PersistService:
        def _upsert_run(self, record: RunRecord, extras=None, expected_version: int = 0) -> bool:
            return False

        def _load_run_locked(self, run_id: str) -> RunRecord:
            return _make_run(run_id=run_id, version=3)

    monkeypatch.setattr(
        run_ops.automation_service,
        "cancel_task",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("cancel failed")),
    )

    with pytest.raises(HTTPException) as excinfo:
        run_ops._persist_run_or_compensate(PersistService(), run, "task-2", actor="owner-a")
    assert excinfo.value.status_code == 500
    assert excinfo.value.detail == "failed to persist run and failed to cancel automation task"


def test_persist_run_compensate_non_http_failure_variants(monkeypatch: pytest.MonkeyPatch) -> None:
    run = _make_run(run_id="run-1")

    class PersistService:
        def __init__(self, cancel_should_fail: bool) -> None:
            self.cancel_should_fail = cancel_should_fail

        def _upsert_run(self, record: RunRecord, extras=None, expected_version: int = 0) -> bool:
            raise RuntimeError("disk full")

    monkeypatch.setattr(run_ops.automation_service, "cancel_task", lambda *args, **kwargs: None)
    with pytest.raises(HTTPException) as generic_error:
        run_ops._persist_run_or_compensate(
            PersistService(cancel_should_fail=False), run, "task-3", actor=None
        )
    assert generic_error.value.status_code == 500
    assert generic_error.value.detail == "failed to persist run after submitting automation task"

    monkeypatch.setattr(
        run_ops.automation_service,
        "cancel_task",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("cancel failed")),
    )
    with pytest.raises(HTTPException) as both_failed:
        run_ops._persist_run_or_compensate(
            PersistService(cancel_should_fail=True), run, "task-4", actor=None
        )
    assert both_failed.value.status_code == 500
    assert both_failed.value.detail == "failed to persist run and failed to cancel automation task"


def test_refresh_run_from_storage_noop_when_latest_missing() -> None:
    run = _make_run(run_id="run-1", status="running", version=2)
    original = run.model_dump()

    class RefreshService:
        def _load_run_locked(self, run_id: str) -> None:
            return None

    run_ops._refresh_run_from_storage(RefreshService(), run)
    assert run.model_dump() == original


def test_run_version_conflict_reports_missing_current() -> None:
    class ConflictService:
        def _load_run_locked(self, run_id: str) -> None:
            return None

    error = run_ops._run_version_conflict(ConflictService(), "run-404", expected=2)
    assert error.status_code == 409
    assert error.detail == "run version conflict: expected 2, current missing"
