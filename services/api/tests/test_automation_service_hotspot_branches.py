from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, cast

import pytest

import app.services.automation_service as automation_module
from app.services.automation_commands import CommandSpec
from app.services.automation_service import RunningTask, automation_service


@pytest.fixture(autouse=True)
def reset_automation_state() -> None:
    with automation_service._lock:
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        automation_service._idempotency_records.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)


def _mk_task(task_id: str, status: str, *, created_at: datetime) -> RunningTask:
    return RunningTask(
        task_id=task_id,
        command_id="script-pipeline-capture",
        status=status,  # type: ignore[arg-type]
        created_at=created_at,
    )


def test_cancel_running_task_without_process_keeps_cancel_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(automation_service, "_sync_from_store_locked", lambda: None)
    with automation_service._lock:
        automation_service._tasks["running-no-proc"] = _mk_task(
            "running-no-proc",
            "running",
            created_at=now,
        )

    snapshot = automation_service.cancel_task("running-no-proc")
    assert snapshot.status == "cancelled"
    assert snapshot.message == "task cancellation requested by user"


def test_run_task_returns_early_when_task_is_cancelled_before_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["cancelled-at-entry"] = _mk_task(
            "cancelled-at-entry",
            "cancelled",
            created_at=now,
        )

    monkeypatch.setattr(
        automation_service,
        "_spawn_process",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not spawn")),
    )
    spec = CommandSpec("script-pipeline-capture", "run", "desc", ["echo"], ["pipeline"])
    automation_service._run_task("cancelled-at-entry", spec, {})
    with automation_service._lock:
        assert automation_service._tasks["cancelled-at-entry"].status == "cancelled"


def test_run_task_respects_cancelled_state_before_spawn_and_after_spawn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeStdout:
        def __iter__(self):
            return iter([])

        def close(self) -> None:
            return None

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = FakeStdout()
            self.pid = 123

        def wait(self, timeout: float | None = None) -> int:
            return 1

        def poll(self) -> int | None:
            return 1

    class FakeThread:
        def __init__(self, target, args=(), daemon=False):
            self.target = target
            self.args = args

        def start(self) -> None:
            return None

    now = datetime.now(timezone.utc)
    spec = CommandSpec("script-pipeline-capture", "run", "desc", ["echo"], ["pipeline"])
    monkeypatch.setattr(automation_module, "Thread", FakeThread)
    monkeypatch.setattr(automation_service, "_build_child_env", lambda env: env)
    monkeypatch.setattr(automation_service, "_compute_retry_delay_seconds", lambda attempt: 0.0)

    with automation_service._lock:
        automation_service._tasks["cancel-before-spawn"] = _mk_task(
            "cancel-before-spawn",
            "queued",
            created_at=now,
        )

    def _cancel_then_return_env(env_overrides: dict[str, str]) -> dict[str, str]:
        with automation_service._lock:
            automation_service._tasks["cancel-before-spawn"].status = "cancelled"
        return env_overrides

    monkeypatch.setattr(automation_service, "_build_child_env", _cancel_then_return_env)
    monkeypatch.setattr(
        automation_service,
        "_spawn_process",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not spawn")),
    )
    automation_service._run_task("cancel-before-spawn", spec, {})

    with automation_service._lock:
        assert automation_service._tasks["cancel-before-spawn"].status == "cancelled"

    with automation_service._lock:
        automation_service._tasks["cancel-after-spawn"] = _mk_task(
            "cancel-after-spawn",
            "queued",
            created_at=now,
        )

    def _spawn_and_cancel(*_args, **_kwargs):
        with automation_service._lock:
            automation_service._tasks["cancel-after-spawn"].status = "cancelled"
        return FakeProcess()

    terminate_called = {"value": 0}
    monkeypatch.setattr(automation_service, "_spawn_process", _spawn_and_cancel)

    def _fake_terminate_process(_process: object) -> bool:
        terminate_called["value"] += 1
        return False

    monkeypatch.setattr(
        automation_service,
        "_terminate_process",
        _fake_terminate_process,
    )

    automation_service._run_task("cancel-after-spawn", spec, {})
    with automation_service._lock:
        task = automation_service._tasks["cancel-after-spawn"]
    assert task.status == "cancelled"
    assert terminate_called["value"] >= 1


def test_retry_delay_and_retry_worker_guard_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    original_base = automation_service._retry_base_seconds
    original_max = automation_service._retry_max_seconds
    original_jitter = automation_service._retry_jitter_ratio
    try:
        automation_service._retry_base_seconds = 2.0
        automation_service._retry_max_seconds = 16.0
        automation_service._retry_jitter_ratio = 0.0
        assert automation_service._compute_retry_delay_seconds(1) == 0.0
        assert automation_service._compute_retry_delay_seconds(3) == 4.0
    finally:
        automation_service._retry_base_seconds = original_base
        automation_service._retry_max_seconds = original_max
        automation_service._retry_jitter_ratio = original_jitter

    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["not-queued"] = _mk_task(
            "not-queued",
            "running",
            created_at=now,
        )

    invoked = {"value": 0}
    monkeypatch.setattr(automation_service, "_sleep", lambda _delay: None)
    monkeypatch.setattr(
        automation_service,
        "_run_task",
        lambda *_args, **_kwargs: invoked.__setitem__("value", invoked["value"] + 1),
    )
    spec = CommandSpec("script-pipeline-capture", "run", "desc", ["echo"], ["pipeline"])
    automation_service._retry_task_after_delay("not-queued", spec, {}, 0.0)
    assert invoked["value"] == 0


def test_terminate_process_pid_none_refuses_signal_path() -> None:
    class FakeProcess:
        pid = None

        def __init__(self) -> None:
            self.terminate_called = 0
            self.kill_called = 0
            self._wait_calls = 0

        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            self.terminate_called += 1

        def kill(self) -> None:
            self.kill_called += 1

        def wait(self, timeout: float | None = None) -> int:
            self._wait_calls += 1
            if self._wait_calls == 1:
                raise automation_module.subprocess.TimeoutExpired("fake", timeout or 1)
            return 0

    process = FakeProcess()
    force_killed = automation_service._terminate_process(cast(Any, process))
    assert force_killed is False
    assert process.terminate_called == 0
    assert process.kill_called == 0
