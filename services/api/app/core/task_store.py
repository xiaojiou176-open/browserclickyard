from __future__ import annotations

import json
import importlib
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager
from typing import Any

from app.core.metrics import runtime_metrics
from app.core.runtime_paths import automation_runtime_root
from app.models.automation import TaskSnapshot

create_engine: Any
inspect: Any
text: Any
Engine: Any
try:  # pragma: no cover - import guard for minimal environments
    from sqlalchemy import create_engine as _create_engine, inspect as _inspect, text as _text
    from sqlalchemy.engine import Engine as _Engine

    create_engine = _create_engine
    inspect = _inspect
    text = _text
    Engine = _Engine
except ImportError:  # pragma: no cover
    create_engine = None
    inspect = None
    text = None
    Engine = object

fcntl: Any
try:  # pragma: no cover - non-posix environments
    fcntl = importlib.import_module("fcntl")
except ImportError:  # pragma: no cover
    fcntl = None


class TaskStore:
    @property
    def kind(self) -> str:
        raise NotImplementedError

    def load(self) -> list[TaskSnapshot]:
        raise NotImplementedError

    def upsert(self, task: TaskSnapshot) -> None:
        raise NotImplementedError

    def delete(self, task_id: str) -> None:
        raise NotImplementedError

    def summary(self) -> dict[str, int]:
        raise NotImplementedError

    def close(self) -> None:
        return None


class FileTaskStore(TaskStore):
    def __init__(self, state_path: Path) -> None:
        self._state_path = state_path
        self._state_dir = state_path.parent
        self._lock_path = self._state_path.with_suffix(".lock")
        self._io_lock = threading.Lock()

    @property
    def kind(self) -> str:
        return "file"

    def _save_all(self, tasks: list[TaskSnapshot]) -> None:
        self._state_dir.mkdir(parents=True, exist_ok=True)
        data = {
            "tasks": [task.model_dump(mode="json") for task in tasks],
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._state_dir,
                prefix=f"{self._state_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_file.write(json.dumps(data, ensure_ascii=False, indent=2))
                temp_path = Path(temp_file.name)
            temp_path.replace(self._state_path)
        finally:
            if temp_path and temp_path.exists():
                temp_path.unlink(missing_ok=True)

    @contextmanager
    def _exclusive_lock(self):
        self._state_dir.mkdir(parents=True, exist_ok=True)
        with self._io_lock:
            if fcntl is None:
                yield
                return
            with self._lock_path.open("a+", encoding="utf-8") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load_unlocked(self) -> list[TaskSnapshot]:
        if not self._state_path.exists():
            return []
        logger = logging.getLogger("storage")
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            runtime_metrics.record_task_store_decode_error()
            corrupt_path = self._state_path.with_suffix(".json.corrupt")
            try:
                self._state_path.replace(corrupt_path)
            except OSError as move_exc:
                logger.warning(
                    "task store quarantine move failed; keep original state file",
                    extra={
                        "error": str(move_exc),
                        "state_path": str(self._state_path),
                        "quarantine_path": str(corrupt_path),
                    },
                )
            logger.warning(
                "task store json decode error; state file moved to quarantine",
                extra={
                    "error": str(exc),
                    "state_path": str(self._state_path),
                    "quarantine_path": str(corrupt_path),
                },
            )
            return []
        tasks = raw.get("tasks", [])
        result: list[TaskSnapshot] = []
        for item in tasks:
            try:
                result.append(TaskSnapshot.model_validate(item))
            except (TypeError, ValueError) as exc:
                runtime_metrics.record_task_store_decode_error()
                logger.warning(
                    "task store decode error; skip invalid task record",
                    extra={
                        "task_id": item.get("task_id") if isinstance(item, dict) else None,
                        "error": str(exc),
                    },
                )
                continue
        return result

    def load(self) -> list[TaskSnapshot]:
        with self._exclusive_lock():
            return self._load_unlocked()

    def upsert(self, task: TaskSnapshot) -> None:
        with self._exclusive_lock():
            tasks = {item.task_id: item for item in self._load_unlocked()}
            tasks[task.task_id] = task
            self._save_all(list(tasks.values()))

    def delete(self, task_id: str) -> None:
        with self._exclusive_lock():
            tasks = {item.task_id: item for item in self._load_unlocked()}
            tasks.pop(task_id, None)
            self._save_all(list(tasks.values()))

    def summary(self) -> dict[str, int]:
        tasks = self.load()
        counts = {"queued": 0, "running": 0, "success": 0, "failed": 0, "cancelled": 0}
        completed = 0
        failed = 0
        for task in tasks:
            counts[task.status] += 1
            if task.status in {"success", "failed", "cancelled"}:
                completed += 1
            if task.status == "failed":
                failed += 1
        return {
            "total": len(tasks),
            "queued": counts["queued"],
            "running": counts["running"],
            "success": counts["success"],
            "failed": counts["failed"],
            "cancelled": counts["cancelled"],
            "completed": completed,
            "failed_completed": failed,
        }


class SqlTaskStore(TaskStore):
    def __init__(self, database_url: str) -> None:
        if create_engine is None or inspect is None or text is None:
            raise RuntimeError("sqlalchemy is not available")
        self._engine: Engine = create_engine(database_url, future=True, pool_pre_ping=True)
        self._assert_schema_ready()

    @property
    def kind(self) -> str:
        return "sql"

    def _assert_schema_ready(self) -> None:
        inspector = inspect(self._engine)
        if inspector.has_table("automation_tasks"):
            return
        if self._engine.dialect.name == "sqlite":
            self._bootstrap_sqlite_schema()
            return
        raise RuntimeError(
            "database schema is not ready: missing table 'automation_tasks'. "
            "Run `uv run alembic upgrade head` with the target DATABASE_URL before starting the backend."
        )

    def _bootstrap_sqlite_schema(self) -> None:
        create_table_sql = text(
            """
            CREATE TABLE IF NOT EXISTS automation_tasks (
              task_id TEXT PRIMARY KEY NOT NULL,
              command_id TEXT NOT NULL,
              status TEXT NOT NULL,
              requested_by TEXT,
              attempt INTEGER NOT NULL,
              max_attempts INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              exit_code INTEGER,
              message TEXT,
              output_tail TEXT NOT NULL
            )
            """
        )
        with self._engine.begin() as conn:
            conn.execute(create_table_sql)

    def upsert(self, task: TaskSnapshot) -> None:
        upsert_sql = text(
            """
            INSERT INTO automation_tasks (
              task_id, command_id, status, requested_by, attempt, max_attempts,
              created_at, started_at, finished_at, exit_code, message, output_tail
            ) VALUES (
              :task_id, :command_id, :status, :requested_by, :attempt, :max_attempts,
              :created_at, :started_at, :finished_at, :exit_code, :message, :output_tail
            )
            ON CONFLICT(task_id) DO UPDATE SET
              command_id=excluded.command_id,
              status=excluded.status,
              requested_by=excluded.requested_by,
              attempt=excluded.attempt,
              max_attempts=excluded.max_attempts,
              created_at=excluded.created_at,
              started_at=excluded.started_at,
              finished_at=excluded.finished_at,
              exit_code=excluded.exit_code,
              message=excluded.message,
              output_tail=excluded.output_tail
            """
        )
        payload = task.model_dump(mode="json")
        with self._engine.begin() as conn:
            conn.execute(upsert_sql, payload)

    def delete(self, task_id: str) -> None:
        with self._engine.begin() as conn:
            conn.execute(
                text("DELETE FROM automation_tasks WHERE task_id = :task_id"), {"task_id": task_id}
            )

    def load(self) -> list[TaskSnapshot]:
        query = text(
            """
            SELECT
              task_id, command_id, status, requested_by, attempt, max_attempts,
              created_at, started_at, finished_at, exit_code, message, output_tail
            FROM automation_tasks
            ORDER BY created_at DESC
            """
        )
        with self._engine.connect() as conn:
            rows = conn.execute(query).mappings().all()
        return [TaskSnapshot.model_validate(dict(row)) for row in rows]

    def summary(self) -> dict[str, int]:
        query = text(
            """
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN status IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_completed
            FROM automation_tasks
            """
        )
        with self._engine.connect() as conn:
            row = conn.execute(query).mappings().first()
        if row is None:
            return {
                "total": 0,
                "queued": 0,
                "running": 0,
                "success": 0,
                "failed": 0,
                "cancelled": 0,
                "completed": 0,
                "failed_completed": 0,
            }
        return {
            "total": int(row["total"] or 0),
            "queued": int(row["queued"] or 0),
            "running": int(row["running"] or 0),
            "success": int(row["success"] or 0),
            "failed": int(row["failed"] or 0),
            "cancelled": int(row["cancelled"] or 0),
            "completed": int(row["completed"] or 0),
            "failed_completed": int(row["failed_completed"] or 0),
        }

    def close(self) -> None:
        self._engine.dispose()


def build_task_store(root: Path) -> TaskStore:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url:
        return SqlTaskStore(database_url)
    state_path = automation_runtime_root(root) / "tasks.json"
    return FileTaskStore(state_path)
