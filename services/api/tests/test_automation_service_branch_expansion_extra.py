from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import HTTPException
from pytest import MonkeyPatch

import app.services.automation_service as automation_module
from app.models.automation import TaskSnapshot
from app.services.automation_commands import CommandSpec
from app.services.automation_service import RunningTask, automation_service


@dataclass
class FakeStore:
    kind: str = "memory"
    load_items: list[TaskSnapshot] | None = None

    def __post_init__(self) -> None:
        self.saved: dict[str, TaskSnapshot] = {}
        self.closed = False

    def upsert(self, snapshot: TaskSnapshot) -> None:
        self.saved[snapshot.task_id] = snapshot

    def delete(self, task_id: str) -> None:
        self.saved.pop(task_id, None)

    def load(self) -> list[TaskSnapshot]:
        return list(self.load_items or [])

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def reset_automation_service_state() -> None:
    with automation_service._lock:
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        automation_service._idempotency_records.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)


def _mk_task(
    task_id: str,
    status: str,
    *,
    created_at: datetime,
    requested_by: str | None = None,
    attempt: int = 1,
    max_attempts: int = 1,
) -> RunningTask:
    return RunningTask(
        task_id=task_id,
        command_id="script-pipeline-capture",
        status=status,  # type: ignore[arg-type]
        created_at=created_at,
        requested_by=requested_by,
        attempt=attempt,
        max_attempts=max_attempts,
    )


def test_run_command_rejects_unknown_and_unsafe_command_ids(monkeypatch: MonkeyPatch) -> None:
    with pytest.raises(HTTPException) as missing:
        automation_service.run_command("not-exist", {})
    assert missing.value.status_code == 404

    with pytest.raises(HTTPException) as high_risk:
        automation_service.run_command("setup", {})
    assert high_risk.value.status_code == 403
    assert "high-risk command is disabled" in str(high_risk.value.detail)

    monkeypatch.setattr(automation_module, "is_high_risk_automation_command", lambda _cid: False)
    with pytest.raises(HTTPException) as allowlist:
        automation_service.run_command("setup", {})
    assert allowlist.value.status_code == 403
    assert "command is not allowlisted" in str(allowlist.value.detail)


def test_run_command_queue_full_still_counts_deprecated_payload() -> None:
    now = datetime.now(timezone.utc)
    original_max_tasks = automation_service._max_tasks
    automation_service._deprecated_env_hits = 0
    try:
        with automation_service._lock:
            automation_service._max_tasks = 1
            automation_service._tasks["existing"] = _mk_task("existing", "queued", created_at=now)

        with pytest.raises(HTTPException) as overflow:
            automation_service.run_command(
                "script-pipeline-capture",
                {"BASE_URL": "https://example.com"},
                used_deprecated_env=True,
                requested_by="deprecated-user",
            )

        assert overflow.value.status_code == 429
        assert automation_service._deprecated_env_hits == 1
    finally:
        automation_service._max_tasks = original_max_tasks


def test_cancel_task_handles_not_found_forbidden_queued_and_force_kill(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(automation_service, "_sync_from_store_locked", lambda: None)

    with pytest.raises(HTTPException) as missing:
        automation_service.cancel_task("missing")
    assert missing.value.status_code == 404

    now = datetime.now(timezone.utc)
    queued = _mk_task("queued", "queued", created_at=now, requested_by="owner")
    running = _mk_task("running", "running", created_at=now, requested_by="owner")
    running.process = object()  # type: ignore[assignment]
    with automation_service._lock:
        automation_service._tasks[queued.task_id] = queued
        automation_service._tasks[running.task_id] = running

    with pytest.raises(HTTPException) as forbidden:
        automation_service.cancel_task("queued", requested_by="other")
    assert forbidden.value.status_code == 403

    queued_snapshot = automation_service.cancel_task("queued", requested_by="owner")
    assert queued_snapshot.status == "cancelled"
    assert queued_snapshot.message == "task cancelled before start"

    monkeypatch.setattr(automation_service, "_terminate_process", lambda _process: True)
    running_snapshot = automation_service.cancel_task("running", requested_by="owner")
    assert running_snapshot.status == "cancelled"
    assert running_snapshot.message == "task force-killed by user"


def test_run_task_marks_runtime_failed_when_stdout_is_unavailable(
    monkeypatch: MonkeyPatch,
) -> None:
    class FakeProcess:
        stdout = None

        def wait(self, timeout: float | None = None) -> int:
            return 0

        def poll(self) -> int | None:
            return 0

    spec = CommandSpec("script-pipeline-capture", "", "", ["echo"], ["pipeline"])
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["runtime-fail"] = _mk_task(
            "runtime-fail", "queued", created_at=now
        )

    monkeypatch.setattr(
        automation_service, "_spawn_process", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(automation_service, "_enforce_timeout", lambda *_args, **_kwargs: None)

    automation_service._run_task("runtime-fail", spec, {})

    with automation_service._lock:
        task = automation_service._tasks["runtime-fail"]
    assert task.status == "failed"
    assert task.message is not None and "runtime failed" in task.message


def test_run_task_non_retry_failure_sets_exit_code_message(monkeypatch: MonkeyPatch) -> None:
    class FakeStdout:
        def __iter__(self):
            return iter(["oops\n"])

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = FakeStdout()

        def wait(self, timeout: float | None = None) -> int:
            return 9

        def poll(self) -> int | None:
            return 9

    spec = CommandSpec("script-pipeline-capture", "", "", ["echo"], ["pipeline"])
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["no-retry"] = _mk_task(
            "no-retry", "queued", created_at=now, attempt=1, max_attempts=1
        )

    monkeypatch.setattr(
        automation_service, "_spawn_process", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(automation_service, "_enforce_timeout", lambda *_args, **_kwargs: None)

    automation_service._run_task("no-retry", spec, {})

    with automation_service._lock:
        task = automation_service._tasks["no-retry"]
    assert task.exit_code == 9
    assert task.status == "failed"
    assert task.message == "exit code 9"


def test_run_task_retry_with_positive_delay_starts_retry_worker(monkeypatch: MonkeyPatch) -> None:
    class FakeStdout:
        def __iter__(self):
            return iter(["retry\n"])

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = FakeStdout()

        def wait(self, timeout: float | None = None) -> int:
            return 7

        def poll(self) -> int | None:
            return 7

    thread_targets: list[tuple[Any, tuple[Any, ...]]] = []

    class FakeThread:
        def __init__(self, target: Any, args: tuple[Any, ...], daemon: bool = False) -> None:
            self.target = target
            self.args = args

        def start(self) -> None:
            thread_targets.append((self.target, self.args))

    spec = CommandSpec("script-pipeline-capture", "", "", ["echo"], ["pipeline"])
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["retry-pos"] = _mk_task(
            "retry-pos", "queued", created_at=now, attempt=1, max_attempts=2
        )

    monkeypatch.setattr(
        automation_service, "_spawn_process", lambda *_args, **_kwargs: FakeProcess()
    )
    monkeypatch.setattr(automation_service, "_compute_retry_delay_seconds", lambda attempt: 0.5)
    monkeypatch.setattr(automation_module, "Thread", FakeThread)

    automation_service._run_task("retry-pos", spec, {})

    with automation_service._lock:
        task = automation_service._tasks["retry-pos"]
    assert task.status == "queued"
    assert task.attempt == 2
    assert any(target == automation_service._retry_task_after_delay for target, _ in thread_targets)


def test_prune_tasks_drops_oldest_completed_when_over_capacity() -> None:
    now = datetime.now(timezone.utc)
    original_max_tasks = automation_service._max_tasks
    try:
        automation_service._max_tasks = 2
        old_success = _mk_task("old-success", "success", created_at=now - timedelta(hours=3))
        old_success.finished_at = now - timedelta(hours=3)
        mid_failed = _mk_task("mid-failed", "failed", created_at=now - timedelta(hours=2))
        mid_failed.finished_at = now - timedelta(hours=2)
        keep_cancelled = _mk_task("keep-cancel", "cancelled", created_at=now - timedelta(hours=1))
        keep_cancelled.finished_at = now - timedelta(hours=1)
        keep_running = _mk_task("keep-running", "running", created_at=now)

        with automation_service._lock:
            automation_service._tasks = {
                old_success.task_id: old_success,
                mid_failed.task_id: mid_failed,
                keep_cancelled.task_id: keep_cancelled,
                keep_running.task_id: keep_running,
            }
            automation_service._idempotency_records = {
                "key-old": (old_success.task_id, now),
                "key-mid": (mid_failed.task_id, now),
                "key-keep": (keep_cancelled.task_id, now),
            }
            automation_service._prune_tasks_locked()

            remaining_ids = set(automation_service._tasks)
            remaining_keys = set(automation_service._idempotency_records)

        assert old_success.task_id not in remaining_ids
        assert mid_failed.task_id not in remaining_ids
        assert keep_cancelled.task_id in remaining_ids
        assert keep_running.task_id in remaining_ids
        assert remaining_keys == {"key-keep"}
    finally:
        automation_service._max_tasks = original_max_tasks


def test_load_state_recovers_interrupted_tasks_and_sync_keeps_local_handles(
    monkeypatch: MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    queued_snapshot = TaskSnapshot(
        task_id="q1",
        command="script-pipeline-capture",
        command_id="script-pipeline-capture",
        status="queued",
        created_at=now - timedelta(minutes=3),
        updated_at=now - timedelta(minutes=2),
        output_tail="q",
    )
    running_snapshot = TaskSnapshot(
        task_id="r1",
        command="script-pipeline-capture",
        command_id="script-pipeline-capture",
        status="running",
        created_at=now - timedelta(minutes=2),
        updated_at=now - timedelta(minutes=1),
        output_tail="r",
    )

    fake_store = FakeStore(kind="sql", load_items=[queued_snapshot, running_snapshot])
    monkeypatch.setattr(automation_service, "_task_store", fake_store)
    monkeypatch.setattr(automation_service, "_prune_tasks_locked", lambda additional_slots=0: None)

    automation_service._load_state()

    with automation_service._lock:
        assert automation_service._tasks["q1"].status == "failed"
        assert automation_service._tasks["q1"].message == "interrupted by service restart"
        assert automation_service._tasks["r1"].status == "failed"

    proc = object()
    with automation_service._lock:
        automation_service._tasks = {
            "r1": RunningTask(
                task_id="r1",
                command_id="script-pipeline-capture",
                status="running",
                created_at=now,
                process=proc,  # type: ignore[arg-type]
                output_lines=["tail"],
            ),
            "local-only": RunningTask(
                task_id="local-only",
                command_id="script-pipeline-capture",
                status="queued",
                created_at=now,
                process=object(),  # type: ignore[arg-type]
                output_lines=["local"],
            ),
        }

    fresh_snapshot = TaskSnapshot(
        task_id="r1",
        command="script-pipeline-capture",
        command_id="script-pipeline-capture",
        status="running",
        created_at=now,
        updated_at=now,
        output_tail="fresh",
    )
    fake_store.load_items = [fresh_snapshot]
    automation_service._sync_from_store_locked()

    with automation_service._lock:
        assert automation_service._tasks["r1"].process is proc
        assert automation_service._tasks["r1"].output_lines == ["tail"]
        assert "local-only" in automation_service._tasks
