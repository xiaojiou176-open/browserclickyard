from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.vonage_inbox import VonageInboundMessage, VonageInboxService


def _service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> VonageInboxService:
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(tmp_path / "automation"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("OTP_DEDUPE_STRICT", raising=False)
    return VonageInboxService()


def test_positive_int_env_and_from_payload_variants(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VONAGE_AUDIT_MAX_BYTES", "oops")
    monkeypatch.setenv("VONAGE_AUDIT_BACKUP_COUNT", "0")
    monkeypatch.setenv("VONAGE_AUDIT_RETENTION_DAYS", "-4")
    service = _service(tmp_path, monkeypatch)
    assert service._audit_max_bytes == 2 * 1024 * 1024
    assert service._audit_backup_count == 1
    assert service._audit_retention_days == 1

    message = VonageInboxService.from_payload(
        {
            "from": "  +15550001111 ",
            "to_number": " 5550002222 ",
            "message": "  code 123456 ",
            "message_uuid": " uuid-1 ",
        }
    )
    assert message == VonageInboundMessage(
        provider="vonage",
        from_number="+15550001111",
        to_number="5550002222",
        text="code 123456",
        message_id="uuid-1",
        received_at=message.received_at,
        raw={
            "from": "  +15550001111 ",
            "to_number": " 5550002222 ",
            "message": "  code 123456 ",
            "message_uuid": " uuid-1 ",
        },
    )


def test_append_message_reports_write_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)

    original_open = Path.open

    def broken_open(
        self: Path,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ):
        if self == service._inbox_path:
            raise OSError("cannot write inbox")
        return original_open(
            self,
            mode=mode,
            buffering=buffering,
            encoding=encoding,
            errors=errors,
            newline=newline,
        )

    monkeypatch.setattr(Path, "open", broken_open)

    with pytest.raises(OSError, match="cannot write inbox"):
        service.append_message(
            VonageInboundMessage(
                provider="vonage",
                from_number="+15550001111",
                to_number="+15559990000",
                text="code 123456",
                message_id="m-1",
                received_at="2026-01-01T00:00:00+00:00",
                raw={},
            )
        )

    assert service._write_failures["inbox"] == 1


def test_register_message_id_uses_redis_and_degrades_to_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://cache/0")

    class FakeRedisClient:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, bool, int]] = []

        def set(self, key: str, value: str, *, nx: bool, ex: int) -> object:
            self.calls.append((key, value, nx, ex))
            return "OK"

    def return_client(redis_url: str) -> FakeRedisClient:
        _ = redis_url
        return client

    def raise_redis_down(redis_url: str) -> object:
        _ = redis_url
        raise RuntimeError("redis down")

    def return_none_client(redis_url: str) -> None:
        _ = redis_url
        return None

    client = FakeRedisClient()
    monkeypatch.setattr(service, "_create_redis_client", return_client)
    assert service.register_message_id("msg-1", 60) is True
    assert service.last_dedupe_mode == "redis"
    assert client.calls[0][0].endswith(":msg-1")

    degraded = _service(tmp_path, monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://cache/0")
    monkeypatch.setattr(degraded, "_create_redis_client", raise_redis_down)
    assert degraded.register_message_id("msg-2", 60) is True
    assert degraded.last_dedupe_mode == "degraded"
    assert degraded._dedupe_path.exists()

    strict_service = _service(tmp_path, monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://cache/0")
    monkeypatch.setenv("OTP_DEDUPE_STRICT", "true")
    monkeypatch.setattr(strict_service, "_create_redis_client", raise_redis_down)
    with pytest.raises(RuntimeError, match="strict mode"):
        strict_service.register_message_id("msg-3", 60)

    none_client_service = _service(tmp_path, monkeypatch)
    monkeypatch.setenv("REDIS_URL", "redis://cache/0")
    monkeypatch.setattr(none_client_service, "_create_redis_client", return_none_client)
    assert none_client_service.register_message_id("msg-4", 60) is True
    assert none_client_service.last_dedupe_mode == "degraded"


def test_register_message_id_file_backend_handles_invalid_json_and_write_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)
    service._dedupe_path.parent.mkdir(parents=True, exist_ok=True)
    service._dedupe_path.write_text("{broken", encoding="utf-8")
    assert service.register_message_id("msg-file-1", 60) is True
    assert service.register_message_id("msg-file-1", 60) is False

    original_write_text = Path.write_text

    def broken_write_text(
        self: Path, data: str, encoding: str | None = None, errors: str | None = None
    ) -> int:
        if self == service._dedupe_path:
            raise OSError("cannot write dedupe")
        return original_write_text(self, data, encoding=encoding, errors=errors)

    monkeypatch.setattr(Path, "write_text", broken_write_text)
    with pytest.raises(OSError):
        service._register_message_id_via_file("msg-file-2", 60)
    assert service._write_failures["dedupe"] == 1

    monkeypatch.undo()
    service = _service(tmp_path, monkeypatch)
    service._dedupe_path.parent.mkdir(parents=True, exist_ok=True)
    service._dedupe_path.write_text(json.dumps({"bad": "oops", "stale": 1}), encoding="utf-8")
    assert service._register_message_id_via_file("msg-file-3", 60) is True


def test_latest_otp_handles_invalid_regex_filters_and_full_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)
    service._inbox_path.parent.mkdir(parents=True, exist_ok=True)
    service._inbox_path.write_text(
        "\n".join(
            [
                "",
                "{broken",
                json.dumps(
                    {
                        "from_number": "+15550001111",
                        "to_number": "+15559990000",
                        "text": "ignore this",
                    }
                ),
                json.dumps(
                    {
                        "from_number": "+15550001111",
                        "to_number": "+15559990000",
                        "text": "OTP 654321",
                    }
                ),
                json.dumps(
                    {
                        "from_number": "+15551112222",
                        "to_number": "15559990000",
                        "text": "CODE-777777",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    assert service.latest_otp(regex="[") is None
    assert (
        service.latest_otp(
            regex=r"\b(\d{6})\b", to_number="+1 (555) 999-0000", sender_filter="1112222"
        )
        == "777777"
    )
    assert service.latest_otp(regex=r"CODE-\d{6}", to_number="15559990000") == "CODE-777777"


def test_latest_otp_skips_invalid_lines_and_filter_mismatches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)
    service._inbox_path.parent.mkdir(parents=True, exist_ok=True)
    service._inbox_path.write_text(
        "\n".join(
            [
                "",
                "{broken",
                json.dumps(
                    {
                        "from_number": "+15550001111",
                        "to_number": "+15559990001",
                        "text": "OTP 111111",
                    }
                ),
                json.dumps(
                    {
                        "from_number": "+15550002222",
                        "to_number": "+15559990000",
                        "text": "no code here",
                    }
                ),
                json.dumps(
                    {
                        "from_number": "+15550003333",
                        "to_number": "+15559990000",
                        "text": "OTP 222222",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    assert (
        service.latest_otp(regex=r"\b(\d{6})\b", to_number="+15559990000", sender_filter="9999")
        is None
    )


def test_rotate_and_prune_helpers_cover_rollover_and_retention(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, monkeypatch)
    path = service._audit_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("current\n", encoding="utf-8")
    archived = path.with_name(f"{path.name}.1")
    archived.write_text("old\n", encoding="utf-8")

    service._rotate_jsonl_if_needed(path, incoming_bytes=10_000, max_bytes=1, backup_count=1)
    assert archived.exists()

    stale = path.with_name(f"{path.name}.2")
    stale.write_text("stale\n", encoding="utf-8")
    old_ts = 1_000_000_000
    os.utime(archived, (old_ts, old_ts))
    os.utime(stale, (old_ts, old_ts))
    service._prune_jsonl_history(path, backup_count=2, retention_days=1)
    assert not archived.exists()
    assert not stale.exists()


def test_phone_normalization_and_same_number_helpers() -> None:
    assert VonageInboxService._normalize_phone_number("+1 (555) 000-1111") == "5550001111"
    assert VonageInboxService._normalize_phone_number("5550001111") == "5550001111"
    assert VonageInboxService._normalize_phone_number(None) == ""
    assert VonageInboxService._same_phone_number("+1 555 000 1111", "5550001111") is True
    assert VonageInboxService._same_phone_number("5550001111", "5550002222") is False


def test_create_redis_client_uses_redis_from_url(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeRedisModule:
        class Redis:
            @staticmethod
            def from_url(url: str, decode_responses: bool = False) -> object:
                captured["url"] = url
                captured["decode_responses"] = decode_responses
                return SimpleNamespace(url=url)

    monkeypatch.setitem(__import__("sys").modules, "redis", FakeRedisModule)
    client = VonageInboxService._create_redis_client("redis://cache/9")
    assert captured == {"url": "redis://cache/9", "decode_responses": True}
    assert getattr(client, "url", None) == "redis://cache/9"
