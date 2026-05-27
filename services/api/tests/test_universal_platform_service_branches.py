from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.universal_platform_service import UniversalPlatformService


def _new_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> UniversalPlatformService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    monkeypatch.setenv("UNIVERSAL_PLATFORM_DATA_DIR", str(runtime_root / "universal"))
    return UniversalPlatformService()


def test_get_validated_params_snapshot_missing_and_conflict_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)

    with pytest.raises(HTTPException) as missing:
        service._get_validated_params_snapshot("run-missing")
    assert missing.value.status_code == 404

    now = datetime.now(UTC).isoformat()
    service._runs_path.parent.mkdir(parents=True, exist_ok=True)
    service._runs_path.write_text(
        json.dumps(
            [
                {
                    "run_id": "run-no-snapshot",
                    "template_id": "tp-x",
                    "status": "queued",
                    "params": {},
                    "created_at": now,
                    "updated_at": now,
                }
            ]
        ),
        encoding="utf-8",
    )
    with pytest.raises(HTTPException) as missing_snapshot:
        service._get_validated_params_snapshot("run-no-snapshot")
    assert missing_snapshot.value.status_code == 409


def test_get_validated_params_snapshot_uses_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    now = datetime.now(UTC).isoformat()
    service._runs_path.parent.mkdir(parents=True, exist_ok=True)
    service._runs_path.write_text(
        json.dumps(
            [
                {
                    "run_id": "run-with-snapshot",
                    "template_id": "tp-y",
                    "status": "queued",
                    "params": {},
                    "created_at": now,
                    "updated_at": now,
                    service._LEGACY_VALIDATED_PARAMS_KEY: {"email": "u@example.com"},
                }
            ]
        ),
        encoding="utf-8",
    )

    first = service._get_validated_params_snapshot("run-with-snapshot")
    second = service._get_validated_params_snapshot("run-with-snapshot")
    assert first == {"email": "u@example.com"}
    assert second == {"email": "u@example.com"}


def test_validated_params_cache_prune_and_disable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    now_ts = datetime.now(UTC).timestamp()
    service._cache_ttl_seconds = 1
    service._cache_max_entries = 2
    service._validated_params_cache = {
        "a": (now_ts - 5, {"x": "1"}),
        "b": (now_ts - 4, {"x": "2"}),
        "c": (now_ts, {"x": "3"}),
    }
    service._prune_validated_params_cache_locked(now_ts=now_ts)
    assert set(service._validated_params_cache.keys()) == {"c"}

    service._cache_max_entries = 0
    service._cache_validated_params_snapshot("new", {"y": "1"})
    assert service._validated_params_cache == {}


def test_read_non_negative_int_env_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    monkeypatch.setenv("UIQ_CACHE_LIMIT", "not-int")
    assert service._read_non_negative_int_env("UIQ_CACHE_LIMIT", 7) == 7
    monkeypatch.setenv("UIQ_CACHE_LIMIT", "-11")
    assert service._read_non_negative_int_env("UIQ_CACHE_LIMIT", 7) == 0
    monkeypatch.setenv("UIQ_CACHE_LIMIT", "4")
    assert service._read_non_negative_int_env("UIQ_CACHE_LIMIT", 7) == 4


def test_upsert_session_from_import_owner_mismatch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _new_service(monkeypatch, tmp_path)
    now = datetime.now(UTC).isoformat()
    service._sessions_path.parent.mkdir(parents=True, exist_ok=True)
    service._sessions_path.write_text(
        json.dumps(
            [
                {
                    "session_id": "ss-owner",
                    "start_url": "https://example.com",
                    "mode": "manual",
                    "owner": "owner-a",
                    "started_at": now,
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(HTTPException) as mismatch:
        service._upsert_session_from_import(
            session_id="ss-owner", start_url="https://example.com", owner="owner-b"
        )
    assert mismatch.value.status_code == 403

    service._upsert_session_from_import(
        session_id="ss-owner", start_url="https://example.com", owner="owner-a"
    )
    sessions = json.loads(service._sessions_path.read_text(encoding="utf-8"))
    assert len(sessions) == 1
