from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException
from pytest import MonkeyPatch

import app.services.automation_service as automation_module
from app.services.automation_service import RunningTask, automation_service


@pytest.fixture(autouse=True)
def reset_automation_state() -> None:
    with automation_service._lock:
        task_ids = list(automation_service._tasks.keys())
        automation_service._tasks.clear()
        automation_service._idempotency_records.clear()
        for task_id in task_ids:
            automation_service._delete_task_locked(task_id)


def _mk_task(
    task_id: str, status: str, *, created_at: datetime, requested_by: str | None = None
) -> RunningTask:
    return RunningTask(
        task_id=task_id,
        command_id="script-pipeline-capture",
        status=status,  # type: ignore[arg-type]
        created_at=created_at,
        requested_by=requested_by,
    )


def test_task_summary_counts_in_memory_tasks(monkeypatch: MonkeyPatch) -> None:
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks = {
            "q": _mk_task("q", "queued", created_at=now),
            "r": _mk_task("r", "running", created_at=now),
            "s": _mk_task("s", "success", created_at=now),
            "f": _mk_task("f", "failed", created_at=now),
            "c": _mk_task("c", "cancelled", created_at=now),
        }
    monkeypatch.setattr(automation_service, "_task_store", SimpleNamespace(kind="memory"))

    summary = automation_service.task_summary()

    assert summary["total"] == 5
    assert summary["queued"] == 1
    assert summary["running"] == 1
    assert summary["success"] == 1
    assert summary["failed"] == 1
    assert summary["cancelled"] == 1
    assert summary["completed"] == 3
    assert summary["failed_completed"] == 1


def test_list_tasks_applies_filters_and_safe_limit(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_service, "_sync_from_store_locked", lambda: None)
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks = {
            "old": _mk_task(
                "old", "queued", created_at=now - timedelta(minutes=10), requested_by="owner-a"
            ),
            "new": _mk_task("new", "running", created_at=now, requested_by="owner-a"),
            "mid": _mk_task(
                "mid", "failed", created_at=now - timedelta(minutes=5), requested_by="owner-b"
            ),
        }

    limited = automation_service.list_tasks(limit=0)
    assert len(limited) == 1
    assert limited[0].task_id == "new"

    owner_tasks = automation_service.list_tasks(requested_by="owner-a")
    assert [item.task_id for item in owner_tasks] == ["new", "old"]

    failed = automation_service.list_tasks(status="failed")
    assert [item.task_id for item in failed] == ["mid"]


def test_get_task_raises_404_and_403(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(automation_service, "_sync_from_store_locked", lambda: None)
    with pytest.raises(HTTPException) as missing:
        automation_service.get_task("missing-task")
    assert missing.value.status_code == 404

    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["owned"] = _mk_task(
            "owned", "queued", created_at=now, requested_by="owner-a"
        )
    with pytest.raises(HTTPException) as forbidden:
        automation_service.get_task("owned", requested_by="owner-b")
    assert forbidden.value.status_code == 403


def test_enforce_timeout_marks_task_failed(monkeypatch: MonkeyPatch) -> None:
    class FakeProcess:
        def poll(self) -> None:
            return None

        def wait(self, timeout: float | None = None) -> int:
            raise automation_module.subprocess.TimeoutExpired("fake", timeout or 1)

    process = FakeProcess()
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._tasks["timeout"] = _mk_task("timeout", "running", created_at=now)

    monkeypatch.setattr(automation_service, "_terminate_process", lambda _p: True)
    automation_service._enforce_timeout("timeout", cast(Any, process), timeout_seconds=0)

    with automation_service._lock:
        task = automation_service._tasks["timeout"]
    assert task.status == "failed"
    assert task.message is not None and "timeout after 0s (force-killed)" in task.message


def test_terminate_process_handles_sigterm_error(monkeypatch: MonkeyPatch) -> None:
    class FakeProcess:
        pid = 123

        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            raise OSError()

        def wait(self, timeout: float | None = None) -> int:
            return 0

    force_killed = automation_service._terminate_process(FakeProcess())  # type: ignore[arg-type]
    assert force_killed is False


def test_find_task_by_idempotency_key_cleans_stale_and_uses_hash_fallback() -> None:
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._idempotency_records["stale-key"] = ("missing-task", now)

    with automation_service._lock:
        stale = automation_service._find_task_by_idempotency_key_locked("stale-key")
    assert stale is None
    with automation_service._lock:
        assert "stale-key" not in automation_service._idempotency_records

    fallback_key = "fallback-key"
    fallback_task_id = automation_service._task_id_for_idempotency_key(fallback_key)
    with automation_service._lock:
        automation_service._tasks[fallback_task_id] = _mk_task(
            fallback_task_id, "queued", created_at=now
        )
        resolved = automation_service._find_task_by_idempotency_key_locked(fallback_key)
        cached_task_id, _ = automation_service._idempotency_records[fallback_key]
    assert resolved is not None and resolved.task_id == fallback_task_id
    assert cached_task_id == fallback_task_id


def test_gc_idempotency_prunes_expired_and_missing_records() -> None:
    now = datetime.now(timezone.utc)
    with automation_service._lock:
        automation_service._idempotency_ttl_seconds = 60
        automation_service._tasks["active"] = _mk_task("active", "queued", created_at=now)
        automation_service._idempotency_records.update(
            {
                "missing": ("gone", now - timedelta(hours=1)),
                "expired": ("active", now - timedelta(hours=1)),
                "fresh": ("active", now),
            }
        )
        automation_service._gc_idempotency_records_locked(now=now)
        keys = set(automation_service._idempotency_records.keys())
    assert keys == {"fresh"}
