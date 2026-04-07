from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import time
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import pytest
from pytest import MonkeyPatch

from app.services.automation_service import RunningTask, automation_service


@pytest.fixture(autouse=True)
def reset_automation_service_state() -> None:
    with automation_service._lock:
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        automation_service._idempotency_records.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)


def _wait_for_terminal(task_id: str, timeout_seconds: float = 2.0) -> RunningTask:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with automation_service._lock:
            task = automation_service._tasks.get(task_id)
            if task is not None and task.status in {"success", "failed", "cancelled"}:
                return task
        time.sleep(0.01)
    raise AssertionError(f"task did not finish before timeout: {task_id}")


def test_run_command_strips_control_env_before_spawn(monkeypatch: MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    class FakeProcess:
        def __init__(self) -> None:
            self.stdout = iter(["ok\n"])
            self._finished = False

        def wait(self, timeout: float | None = None) -> int:
            self._finished = True
            return 0

        def terminate(self) -> None:
            return None

        def poll(self) -> int | None:
            return 0 if self._finished else None

    def fake_spawn(argv: list[str], env: dict[str, str]):
        captured.update(env)
        return FakeProcess()

    monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)

    task = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-control-env",
            "AUTOMATION_IDEMPOTENCY_REPLAY": "true",
        },
        requested_by="wave-c3-user",
    )
    terminal = _wait_for_terminal(task.task_id)
    assert terminal.status == "success"
    assert captured["BASE_URL"] == "https://example.com"
    assert "AUTOMATION_IDEMPOTENCY_KEY" not in captured
    assert "AUTOMATION_IDEMPOTENCY_REPLAY" not in captured


def test_run_command_coalesces_duplicate_inflight_submission(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)

    first = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-inflight",
        },
        requested_by="wave-c3-user",
    )
    second = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-inflight",
        },
        requested_by="wave-c3-user",
    )

    assert first.task_id == second.task_id
    with automation_service._lock:
        assert len(automation_service._tasks) == 1


def test_run_command_replay_creates_new_task_for_completed_duplicate(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(automation_service, "_run_task", lambda *args, **kwargs: None)
    first = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-replay",
        },
        requested_by="wave-c3-user",
    )

    with automation_service._lock:
        origin = automation_service._tasks[first.task_id]
        origin.status = "success"
        origin.finished_at = datetime.now(timezone.utc)
        origin.message = "completed"
        automation_service._save_task_locked(origin)

    duplicate = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-replay",
        },
        requested_by="wave-c3-user",
    )
    assert duplicate.task_id == first.task_id

    replay = automation_service.run_command(
        "script-pipeline-capture",
        {
            "BASE_URL": "https://example.com",
            "AUTOMATION_IDEMPOTENCY_KEY": "wave-c3-replay",
            "AUTOMATION_IDEMPOTENCY_REPLAY": "true",
        },
        requested_by="wave-c3-user",
    )
    assert replay.task_id != first.task_id
    with automation_service._lock:
        replay_task = automation_service._tasks[replay.task_id]
        assert replay_task.replay_of_task_id == first.task_id


def test_compute_retry_delay_applies_backoff_and_jitter(monkeypatch: MonkeyPatch) -> None:
    original_base = automation_service._retry_base_seconds
    original_max = automation_service._retry_max_seconds
    original_jitter = automation_service._retry_jitter_ratio
    try:
        automation_service._retry_base_seconds = 1.0
        automation_service._retry_max_seconds = 8.0
        automation_service._retry_jitter_ratio = 0.25
        monkeypatch.setattr(
            "backend.app.services.automation_service.random.uniform", lambda low, high: high
        )

        assert automation_service._compute_retry_delay_seconds(2) == pytest.approx(1.25)
        assert automation_service._compute_retry_delay_seconds(3) == pytest.approx(2.5)
        assert automation_service._compute_retry_delay_seconds(6) == pytest.approx(10.0)
    finally:
        automation_service._retry_base_seconds = original_base
        automation_service._retry_max_seconds = original_max
        automation_service._retry_jitter_ratio = original_jitter


def test_retry_path_uses_backoff_scheduler(monkeypatch: MonkeyPatch) -> None:
    call_count = {"value": 0}
    observed_retry_attempts: list[int] = []
    original_retries = automation_service._default_retries

    class FakeProcess:
        def __init__(self, exit_code: int) -> None:
            self.stdout = iter(["retry\n"])
            self._exit_code = exit_code
            self._finished = False

        def wait(self, timeout: float | None = None) -> int:
            self._finished = True
            return self._exit_code

        def terminate(self) -> None:
            return None

        def poll(self) -> int | None:
            return self._exit_code if self._finished else None

    def fake_spawn(argv: list[str], env: dict[str, str]):
        call_count["value"] += 1
        return FakeProcess(1 if call_count["value"] == 1 else 0)

    def fake_retry_delay(attempt: int) -> float:
        observed_retry_attempts.append(attempt)
        return 0.0

    try:
        automation_service._default_retries = 1
        monkeypatch.setattr(automation_service, "_spawn_process", fake_spawn)
        monkeypatch.setattr(automation_service, "_compute_retry_delay_seconds", fake_retry_delay)
        monkeypatch.setattr(automation_service, "_slot_limiter", nullcontext())
        monkeypatch.setattr(automation_service, "_long_slot_limiter", nullcontext())

        task = automation_service.run_command(
            "script-pipeline-capture", {"BASE_URL": "https://example.com"}, requested_by="wave-c3-user"
        )
        deadline = time.time() + 10.0
        while time.time() < deadline and call_count["value"] < 2:
            time.sleep(0.01)
        assert call_count["value"] == 2, "retry attempt did not execute before timeout"

        terminal = _wait_for_terminal(task.task_id, timeout_seconds=10.0)
        assert terminal.status == "success"
        assert terminal.attempt == 2
        assert call_count["value"] == 2
        assert observed_retry_attempts == [2]
    finally:
        automation_service._default_retries = original_retries


def test_prune_tasks_recycles_expired_completed_and_idempotency_records() -> None:
    original_ttl = automation_service._completed_task_ttl_seconds
    try:
        automation_service._completed_task_ttl_seconds = 60
        now = datetime.now(timezone.utc)
        expired = RunningTask(
            task_id="expired-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(minutes=10),
            finished_at=now - timedelta(minutes=10),
            idempotency_key="user:expired-key",
        )
        recent = RunningTask(
            task_id="recent-1",
            command_id="script-pipeline-capture",
            status="success",
            created_at=now - timedelta(seconds=5),
            finished_at=now - timedelta(seconds=5),
            idempotency_key="user:recent-key",
        )
        with automation_service._lock:
            automation_service._tasks[expired.task_id] = expired
            automation_service._tasks[recent.task_id] = recent
            automation_service._idempotency_records["user:expired-key"] = (
                expired.task_id,
                now - timedelta(minutes=10),
            )
            automation_service._idempotency_records["user:recent-key"] = (
                recent.task_id,
                now - timedelta(seconds=5),
            )
            automation_service._save_task_locked(expired)
            automation_service._save_task_locked(recent)
            automation_service._prune_tasks_locked()

            assert "expired-1" not in automation_service._tasks
            assert "recent-1" in automation_service._tasks
            assert "user:expired-key" not in automation_service._idempotency_records
            assert "user:recent-key" in automation_service._idempotency_records
    finally:
        automation_service._completed_task_ttl_seconds = original_ttl


def test_automation_lifecycle_script_builds_seed_and_isolated_dir() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    cycle_id = "wave-c3-script-test"
    script = repo_root / "scripts" / "automation-lifecycle.sh"
    seed_file = repo_root / ".runtime-cache" / "automation" / "lifecycle" / cycle_id / "seed.json"
    run_dir = seed_file.parent

    if run_dir.exists():
        shutil.rmtree(run_dir)

    result = subprocess.run(
        [str(script), "--cycle-id", cycle_id, "--ttl-hours", "1", "--dry-run"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "[automation-lifecycle] seeded:" in result.stdout
    assert seed_file.exists()

    payload = json.loads(seed_file.read_text(encoding="utf-8"))
    assert payload["cycleId"] == cycle_id
    assert payload["idempotencyKey"].startswith("wave-c3-")
