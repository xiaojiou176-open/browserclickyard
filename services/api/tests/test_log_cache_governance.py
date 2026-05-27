from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

os.environ.setdefault("AUTOMATION_API_TOKEN", "test-token")

from app.models.run import MAX_RUN_LOG_ENTRIES, RunLogEntry, RunRecord
from app.services.universal_platform_service import UniversalPlatformService
from app.services.vonage_inbox import VonageInboxService


def _audit_series(path: Path) -> list[Path]:
    return sorted(path.parent.glob(f"{path.name}*"))


def test_universal_audit_rotates_with_cap(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runtime_root = tmp_path / "automation"
    universal_root = runtime_root / "universal"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("UNIVERSAL_PLATFORM_DATA_DIR", str(universal_root))
    monkeypatch.setenv("UNIVERSAL_AUDIT_MAX_BYTES", "320")
    monkeypatch.setenv("UNIVERSAL_AUDIT_BACKUP_COUNT", "2")
    monkeypatch.setenv("UNIVERSAL_AUDIT_RETENTION_DAYS", "30")

    service = UniversalPlatformService()
    for idx in range(20):
        service._audit("rotation.test", "tester", {"idx": idx, "payload": "x" * 80})

    audit_path = service._audit_path
    assert audit_path.exists()
    assert (audit_path.parent / f"{audit_path.name}.1").exists()
    assert not (audit_path.parent / f"{audit_path.name}.3").exists()
    assert len(_audit_series(audit_path)) <= 3


def test_universal_audit_write_failure_is_observable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    blocked = tmp_path / "blocked-runtime-cache-root"
    blocked.write_text("not-a-directory", encoding="utf-8")
    monkeypatch.setenv("UIQ_RUNTIME_CACHE_ROOT", str(blocked))

    service = UniversalPlatformService()
    service._audit("write.failure", "tester", {"sample": "payload"})

    captured = capsys.readouterr()
    assert "universal-audit" in captured.err
    assert "write failed" in captured.err


def test_vonage_audit_rotates_with_cap(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("VONAGE_AUDIT_MAX_BYTES", "280")
    monkeypatch.setenv("VONAGE_AUDIT_BACKUP_COUNT", "2")
    monkeypatch.setenv("VONAGE_AUDIT_RETENTION_DAYS", "30")

    service = VonageInboxService()
    for idx in range(24):
        service.append_audit(
            status="ok",
            reason=f"r-{idx}",
            payload={"messageId": f"mid-{idx}", "msisdn": "+15550001111", "to": "+15559990000"},
        )

    audit_path = service._audit_path
    assert audit_path.exists()
    assert (audit_path.parent / f"{audit_path.name}.1").exists()
    assert not (audit_path.parent / f"{audit_path.name}.3").exists()
    assert len(_audit_series(audit_path)) <= 3


def test_vonage_audit_write_failure_is_observable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    blocked_runtime = tmp_path / "blocked-runtime-cache-root"
    blocked_runtime.write_text("not-a-directory", encoding="utf-8")
    monkeypatch.setenv("UIQ_RUNTIME_CACHE_ROOT", str(blocked_runtime))

    service = VonageInboxService()
    service.append_audit(
        status="ok",
        reason="should-fail",
        payload={"messageId": "mid-fail", "msisdn": "+15550001111", "to": "+15559990000"},
    )

    captured = capsys.readouterr()
    assert "vonage-audit" in captured.err
    assert "write failed" in captured.err


def test_run_record_log_entries_are_capped() -> None:
    now = datetime.now(UTC)
    logs = [
        RunLogEntry(ts=now, level="info", message=f"log-{idx}")
        for idx in range(MAX_RUN_LOG_ENTRIES + 20)
    ]
    run = RunRecord(
        run_id="rn_cap",
        template_id="tp_cap",
        status="queued",
        created_at=now,
        updated_at=now,
        logs=logs,
    )
    assert len(run.logs) == MAX_RUN_LOG_ENTRIES
    assert run.logs[0].message == "log-20"
