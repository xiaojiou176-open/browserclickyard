from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from app.core.metrics import runtime_metrics
from app.core.task_store import FileTaskStore
from app.services.automation_service import AutomationService, RunningTask


def test_sqlite_task_store_persists_across_service_restart(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "automation_tasks.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")

    first = AutomationService()
    try:
        with first._lock:
            task = RunningTask(
                task_id="t-1",
                command_id="script-pipeline-full",
                status="success",
                created_at=datetime.now(timezone.utc),
                message="done",
            )
            first._tasks[task.task_id] = task
            first._save_task_locked(task)

        second = AutomationService()
        persisted_task = second.get_task("t-1")
        assert persisted_task.task_id == "t-1"
        assert persisted_task.status == "success"
        assert persisted_task.message == "done"
    finally:
        first.close()
        if "second" in locals():
            second.close()


def test_sqlite_task_summary_uses_persisted_rows(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "automation_tasks.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")

    service = AutomationService()
    try:
        now = datetime.now(timezone.utc)
        with service._lock:
            service._tasks["t-1"] = RunningTask(
                task_id="t-1", command_id="script-pipeline-full", status="failed", created_at=now
            )
            service._tasks["t-2"] = RunningTask(
                task_id="t-2", command_id="script-pipeline-full", status="success", created_at=now
            )
            service._tasks["t-3"] = RunningTask(
                task_id="t-3", command_id="script-pipeline-full", status="running", created_at=now
            )
            service._save_task_locked(service._tasks["t-1"])
            service._save_task_locked(service._tasks["t-2"])
            service._save_task_locked(service._tasks["t-3"])

        summary = service.task_summary()
        assert summary["total"] == 3
        assert summary["failed"] == 1
        assert summary["success"] == 1
        assert summary["running"] == 1
        assert summary["completed"] == 2
        assert summary["failed_completed"] == 1
    finally:
        service.close()


def test_sqlite_restart_recovers_running_task_and_persists_failed_status(
    monkeypatch, tmp_path
) -> None:
    db_path = tmp_path / "automation_tasks.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")

    first = AutomationService()
    try:
        with first._lock:
            task = RunningTask(
                task_id="t-running",
                command_id="script-pipeline-full",
                status="running",
                created_at=datetime.now(timezone.utc),
                message="running",
            )
            first._tasks[task.task_id] = task
            first._save_task_locked(task)

        restarted = AutomationService()
        recovered = restarted.get_task("t-running")
        assert recovered.status == "failed"
        assert recovered.message == "interrupted by service restart"

        summary = restarted.task_summary()
        assert summary["running"] == 0
        assert summary["failed"] == 1
        assert summary["failed_completed"] == 1
    finally:
        first.close()
        if "restarted" in locals():
            restarted.close()


def test_file_task_store_records_decode_error_metric(tmp_path) -> None:
    state_path = tmp_path / "tasks.json"
    now = datetime.now(timezone.utc).isoformat()
    state_path.write_text(
        json.dumps(
            {
                "tasks": [
                    {
                        "task_id": "ok-1",
                        "command_id": "script-pipeline-full",
                        "status": "success",
                        "created_at": now,
                        "output_tail": "",
                    },
                    {
                        "task_id": "bad-1",
                        "command_id": "script-pipeline-full",
                        "status": "not-a-valid-status",
                        "created_at": now,
                        "output_tail": "",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    store = FileTaskStore(state_path)
    before = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    tasks = store.load()
    after = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    assert len(tasks) == 1
    assert tasks[0].task_id == "ok-1"
    assert after == before + 1


def test_file_task_store_quarantines_corrupt_json_and_records_metric(tmp_path) -> None:
    state_path = tmp_path / "tasks.json"
    state_path.write_text("{ invalid json", encoding="utf-8")
    store = FileTaskStore(state_path)
    before = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    tasks = store.load()
    after = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    assert tasks == []
    assert after == before + 1
    assert not state_path.exists()
    assert state_path.with_suffix(".json.corrupt").exists()


def test_file_task_store_keeps_original_when_quarantine_move_fails(monkeypatch, tmp_path) -> None:
    state_path = tmp_path / "tasks.json"
    state_path.write_text("{ invalid json", encoding="utf-8")
    store = FileTaskStore(state_path)

    original_replace = Path.replace

    def broken_replace(self: Path, target: Path) -> Path:
        if self == state_path:
            raise OSError("disk error")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", broken_replace)
    before = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    tasks = store.load()
    after = cast(int, runtime_metrics.snapshot()["task_store_decode_errors"])
    assert tasks == []
    assert after == before + 1
    assert state_path.exists()
    assert not state_path.with_suffix(".json.corrupt").exists()


def test_file_task_store_concurrent_upsert_keeps_all_records(tmp_path) -> None:
    store = FileTaskStore(tmp_path / "tasks.json")
    workers = 20
    rounds = 3
    barrier = threading.Barrier(workers)
    now = datetime.now(timezone.utc)

    def worker(worker_id: int) -> None:
        barrier.wait()
        for idx in range(rounds):
            task = RunningTask(
                task_id=f"w{worker_id}-r{idx}",
                command_id="script-pipeline-capture",
                status="success",
                created_at=now,
                message=f"worker-{worker_id}-round-{idx}",
            ).snapshot()
            store.upsert(task)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    loaded = store.load()
    assert len(loaded) == workers * rounds
    assert {task.task_id for task in loaded} == {
        f"w{i}-r{j}" for i in range(workers) for j in range(rounds)
    }


def test_idempotency_lookup_survives_restart_via_deterministic_task_id(
    monkeypatch, tmp_path
) -> None:
    db_path = tmp_path / "automation_tasks.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db_path}")

    first = AutomationService()
    try:
        env = {"START_URL": "https://example.com", "FLOW_INPUT": "alice"}
        key = first._resolve_idempotency_key("automation-replay-flow", env, "owner-a", env)
        task_id = first._task_id_for_idempotency_key(key)
        now = datetime.now(timezone.utc)
        with first._lock:
            task = RunningTask(
                task_id=task_id,
                command_id="automation-replay-flow",
                status="queued",
                created_at=now,
                requested_by="owner-a",
                idempotency_key=key,
            )
            first._tasks[task.task_id] = task
            first._save_task_locked(task)

        restarted = AutomationService()
        with restarted._lock:
            found = restarted._find_task_by_idempotency_key_locked(key)
        assert found is not None
        assert found.task_id == task_id
    finally:
        first.close()
        if "restarted" in locals():
            restarted.close()
