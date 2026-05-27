from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

import pytest

import app.core.task_store as task_store_module
from app.core.task_store import (
    FileTaskStore,
    SqlTaskStore,
    TaskStore,
    build_task_store,
)
from app.models.automation import TaskSnapshot, TaskStatus


def _snapshot(task_id: str, status: TaskStatus = "queued") -> TaskSnapshot:
    now = datetime.now(timezone.utc)
    return TaskSnapshot(
        task_id=task_id,
        command_id="script-pipeline-capture",
        status=status,
        created_at=now,
        updated_at=now,
        output_tail="",
        message=f"task-{task_id}",
    )


def test_task_store_base_contract_and_file_store_delete_summary(tmp_path: Path) -> None:
    base = TaskStore()
    with pytest.raises(NotImplementedError):
        _ = base.kind
    with pytest.raises(NotImplementedError):
        base.load()
    with pytest.raises(NotImplementedError):
        base.upsert(_snapshot("base"))
    with pytest.raises(NotImplementedError):
        base.delete("base")
    with pytest.raises(NotImplementedError):
        base.summary()
    base.close()

    store = FileTaskStore(tmp_path / "tasks.json")
    first = _snapshot("queued-1", "queued")
    second = _snapshot("failed-1", "failed")
    store.upsert(first)
    store.upsert(second)
    store.delete(first.task_id)

    summary = store.summary()
    assert summary == {
        "total": 1,
        "queued": 0,
        "running": 0,
        "success": 0,
        "failed": 1,
        "cancelled": 0,
        "completed": 1,
        "failed_completed": 1,
    }


def test_file_store_lock_without_fcntl_and_save_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FileTaskStore(tmp_path / "tasks.json")
    monkeypatch.setattr(task_store_module, "fcntl", None)
    store.upsert(_snapshot("no-fcntl"))
    assert [task.task_id for task in store.load()] == ["no-fcntl"]

    temp_path = tmp_path / "leftover.tmp"

    class FakeTempFile:
        name = str(temp_path)

        def __enter__(self) -> "FakeTempFile":
            temp_path.write_text("", encoding="utf-8")
            return self

        def __exit__(self, exc_type, exc, tb) -> Literal[False]:
            return False

        def write(self, payload: str) -> None:
            temp_path.write_text(payload, encoding="utf-8")

    def fake_named_tempfile(**_: object) -> FakeTempFile:
        return FakeTempFile()

    monkeypatch.setattr(task_store_module.tempfile, "NamedTemporaryFile", fake_named_tempfile)
    monkeypatch.setattr(
        Path, "replace", lambda self, target: (_ for _ in ()).throw(OSError("replace failed"))
    )

    with pytest.raises(OSError):
        store._save_all([_snapshot("cleanup-target")])
    assert not temp_path.exists()


def test_sql_store_runtime_error_schema_paths_and_summary_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(task_store_module, "create_engine", None)
    with pytest.raises(RuntimeError, match="sqlalchemy is not available"):
        SqlTaskStore("sqlite+pysqlite:///ignored.db")

    class FakeInspector:
        def __init__(self, has_table: bool) -> None:
            self._has_table = has_table

        def has_table(self, _name: str) -> bool:
            return self._has_table

    class FakeConnection:
        def __init__(self, row: object = None) -> None:
            self._row = row
            self.executed: list[object] = []

        def __enter__(self) -> "FakeConnection":
            return self

        def __exit__(self, exc_type, exc, tb) -> Literal[False]:
            return False

        def execute(self, statement: object, params: object = None) -> object:
            self.executed.append((statement, params))
            if self._row == "mappings_all":
                return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: []))
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: self._row))

    class FakeEngine:
        def __init__(self, dialect_name: str, row: object = None) -> None:
            self.dialect = SimpleNamespace(name=dialect_name)
            self._row = row
            self.disposed = False
            self.begin_calls = 0

        def begin(self) -> FakeConnection:
            self.begin_calls += 1
            return FakeConnection()

        def connect(self) -> FakeConnection:
            return FakeConnection(self._row)

        def dispose(self) -> None:
            self.disposed = True

    monkeypatch.setattr(
        task_store_module, "create_engine", lambda *args, **kwargs: FakeEngine("postgresql")
    )
    monkeypatch.setattr(task_store_module, "inspect", lambda engine: FakeInspector(False))
    monkeypatch.setattr(task_store_module, "text", lambda sql: sql)
    with pytest.raises(RuntimeError, match="database schema is not ready"):
        SqlTaskStore("postgresql://example")

    sqlite_engine = FakeEngine("sqlite", row=None)
    monkeypatch.setattr(task_store_module, "create_engine", lambda *args, **kwargs: sqlite_engine)
    store = SqlTaskStore(f"sqlite+pysqlite:///{tmp_path / 'tasks.db'}")
    assert sqlite_engine.begin_calls == 1
    assert store.summary() == {
        "total": 0,
        "queued": 0,
        "running": 0,
        "success": 0,
        "failed": 0,
        "cancelled": 0,
        "completed": 0,
        "failed_completed": 0,
    }
    store.close()
    assert sqlite_engine.disposed is True


def test_build_task_store_prefers_sql_when_database_url_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("UIQ_RUNTIME_CACHE_ROOT", raising=False)
    monkeypatch.delenv("RUNTIME_ROOT", raising=False)
    sentinel_store = object()
    monkeypatch.setenv("DATABASE_URL", "sqlite+pysqlite:///priority.db")
    monkeypatch.setattr(
        task_store_module, "SqlTaskStore", lambda database_url: (sentinel_store, database_url)
    )
    built = build_task_store(tmp_path)
    assert built == (sentinel_store, "sqlite+pysqlite:///priority.db")

    monkeypatch.delenv("DATABASE_URL", raising=False)
    file_store = build_task_store(tmp_path)
    assert isinstance(file_store, FileTaskStore)
    assert file_store.kind == "file"
    assert file_store._state_path == tmp_path / ".runtime-cache" / "automation" / "tasks.json"
