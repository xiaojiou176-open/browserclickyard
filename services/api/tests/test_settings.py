from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

from pydantic import ValidationError
import pytest
from pytest import MonkeyPatch

from app.core.app_settings import _resolve_app_env
from app.core.settings import RuntimeSettings, env_bool, env_csv, env_int, env_str

yaml: Any = importlib.import_module("yaml")


def test_env_helpers_read_typed_values(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_MAX_TASKS", "321")
    monkeypatch.setenv("COOKIE_SECURE", "true")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://a.test, http://b.test")

    assert env_int("AUTOMATION_MAX_TASKS", 1) == 321
    assert env_bool("COOKIE_SECURE", False) is True
    assert env_csv("CORS_ALLOWED_ORIGINS", "") == ["http://a.test", "http://b.test"]


def test_env_str_reads_secret_and_unknown_fallback(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "secret-token")
    monkeypatch.setenv("CUSTOM_UNDECLARED_ENV", "custom")

    assert env_str("AUTOMATION_API_TOKEN", "") == "secret-token"
    assert env_str("CUSTOM_UNDECLARED_ENV", "") == "custom"
    assert env_str("MISSING_ENV", "fallback") == "fallback"


def test_runtime_settings_invalid_int_raises(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_MAX_TASKS", "not-an-int")
    with pytest.raises(ValidationError):
        RuntimeSettings()


def test_runtime_settings_defaults_align_with_contract(monkeypatch: MonkeyPatch) -> None:
    contract_path = Path(__file__).resolve().parents[3] / "configs" / "env" / "contract.yaml"
    contract = yaml.safe_load(contract_path.read_text(encoding="utf-8"))
    defaults = {
        str(item["name"]): item.get("default") for item in contract["variables"] if "name" in item
    }

    for field_name, field_info in RuntimeSettings.model_fields.items():
        alias = field_info.alias or field_name
        monkeypatch.delenv(alias, raising=False)

    settings = RuntimeSettings(_env_file=None)  # type: ignore[call-arg]
    missing_in_contract: list[str] = []
    mismatches: list[tuple[str, str, str]] = []
    allowed_contract_overrides = {
        # License-hardening migration: runtime default moves from psycopg to pg8000.
        "DATABASE_URL": "postgresql+pg8000://automation:automation@postgres:5432/automation",
    }

    for field_name, field_info in RuntimeSettings.model_fields.items():
        alias = field_info.alias or field_name
        if alias not in defaults:
            missing_in_contract.append(alias)
            continue
        actual = getattr(settings, field_name)
        if hasattr(actual, "get_secret_value"):
            actual = actual.get_secret_value()

        actual_str = _to_contract_string(actual)
        expected_str = _to_contract_string(defaults[alias])
        expected_override = allowed_contract_overrides.get(alias)
        if expected_override is not None:
            expected_str = expected_override
        if actual_str != expected_str:
            mismatches.append((alias, actual_str, expected_str))

    assert missing_in_contract == []
    assert mismatches == []


def test_required_prod_env_rejects_placeholder_token(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "replace-with-strong-token")
    with pytest.raises(ValidationError):
        RuntimeSettings()


def test_required_prod_like_env_rejects_placeholder_token_in_staging(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "replace-with-strong-token")
    with pytest.raises(ValidationError):
        RuntimeSettings()


def test_config_settings_default_app_env_matches_contract(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    assert _resolve_app_env() == "development"


def test_config_settings_app_env_requires_canonical_names(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "prod")
    assert _resolve_app_env() == "prod"


def _to_contract_string(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
