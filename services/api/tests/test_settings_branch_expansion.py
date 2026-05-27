from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import SecretStr

import app.core.settings as settings_module
from app.core.settings import (
    RuntimeSettings,
    _as_string,
    _collect_missing_required_in_prod,
    _load_required_in_prod_keys,
    _settings_without_env_file,
    env_app_env,
    env_float,
    env_is_production_like,
    env_str,
    get_settings,
    is_production_like_env,
    normalize_app_env,
    refresh_settings_cache,
)


def test_load_required_in_prod_keys_falls_back_on_read_and_parse_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract_path = Path(__file__).resolve().parents[3] / "configs" / "env" / "contract.yaml"
    original_read_text = Path.read_text

    def raising_read_text(
        self: Path, encoding: str | None = None, errors: str | None = None
    ) -> str:
        if self == contract_path:
            raise OSError("missing contract")
        return original_read_text(self, encoding=encoding, errors=errors)

    monkeypatch.setattr(Path, "read_text", raising_read_text)
    assert _load_required_in_prod_keys() == settings_module._REQUIRED_IN_PROD_FALLBACK

    def invalid_yaml(_content: str) -> object:
        raise settings_module.yaml.YAMLError("bad yaml")

    monkeypatch.setattr(Path, "read_text", lambda self, *args, **kwargs: "variables: [")
    monkeypatch.setattr(settings_module.yaml, "safe_load", invalid_yaml)
    assert _load_required_in_prod_keys() == settings_module._REQUIRED_IN_PROD_FALLBACK


def test_load_required_in_prod_keys_handles_non_list_and_extracts_required_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(Path, "read_text", lambda self, *args, **kwargs: "variables: []")
    monkeypatch.setattr(
        settings_module.yaml, "safe_load", lambda _content: {"variables": "not-a-list"}
    )
    assert _load_required_in_prod_keys() == settings_module._REQUIRED_IN_PROD_FALLBACK

    monkeypatch.setattr(
        settings_module.yaml,
        "safe_load",
        lambda _content: {
            "variables": [
                {"name": "AUTOMATION_API_TOKEN", "required": True},
                {"name": "IGNORED_OPTIONAL", "required": False},
                {"required": True},
                "bad-entry",
            ]
        },
    )
    assert _load_required_in_prod_keys() == frozenset({"AUTOMATION_API_TOKEN"})


def test_runtime_settings_warns_placeholder_in_non_prod_and_keeps_canonical_env_only(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "real-token")
    prod_settings = _settings_without_env_file()
    assert prod_settings.app_env == "production"

    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "replace-with-strong-token")
    caplog.clear()
    with caplog.at_level("WARNING"):
        settings = _settings_without_env_file()
    assert settings.app_env == "development"
    assert "placeholder value" in caplog.text


def test_normalize_and_production_helpers_cover_canonical_values_and_defaults() -> None:
    assert normalize_app_env(" production ") == "production"
    assert normalize_app_env(" staging ") == "staging"
    assert normalize_app_env(None, "development") == "development"
    assert is_production_like_env("staging") is True
    assert is_production_like_env("qa") is False


def test_get_settings_and_refresh_cache_cover_pytest_and_cached_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    refresh_settings_cache()

    sentinel = object()
    marker = {"cleared": False}

    class CachedSettingsStub:
        def __call__(self) -> object:
            return sentinel

        def cache_clear(self) -> None:
            marker["cleared"] = True

    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(settings_module, "_cached_settings", CachedSettingsStub())
    assert get_settings() is sentinel

    monkeypatch.setenv("PYTEST_CURRENT_TEST", "case::test")
    fresh = get_settings()
    assert isinstance(fresh, RuntimeSettings)

    refresh_settings_cache()
    assert marker["cleared"] is True


def test_settings_without_env_file_and_env_str_fallback_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "replace-with-strong-token")
    isolated = _settings_without_env_file()
    assert isinstance(isolated, RuntimeSettings)

    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("CUSTOM_UNDECLARED_ENV", "custom-value")
    monkeypatch.setattr(
        settings_module, "get_settings", lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    assert env_str("CUSTOM_UNDECLARED_ENV", "fallback") == "custom-value"
    assert env_str("AUTOMATION_API_TOKEN", "fallback") == "fallback"


def test_collect_missing_required_keys_and_scalar_helpers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings_module,
        "_REQUIRED_IN_PROD_KEYS",
        frozenset({"AUTOMATION_API_TOKEN", "EXTERNAL_ONLY"}),
    )
    monkeypatch.setattr(
        settings_module,
        "_ALIAS_MAP",
        {"AUTOMATION_API_TOKEN": "automation_api_token"},
    )
    monkeypatch.setenv("EXTERNAL_ONLY", "configured")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "real-token")
    settings = _settings_without_env_file()
    assert _collect_missing_required_in_prod(settings) == []

    monkeypatch.delenv("EXTERNAL_ONLY", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTOMATION_API_TOKEN", "real-token")
    settings = _settings_without_env_file()
    assert _collect_missing_required_in_prod(settings) == ["EXTERNAL_ONLY"]

    assert _as_string(SecretStr("secret"), "fallback") == "secret"
    assert _as_string(None, "fallback") == "fallback"
    monkeypatch.setenv("FLOAT_VALUE", "3.14")
    monkeypatch.setenv("APP_ENV", "staging")
    assert env_float("FLOAT_VALUE", 1.0) == 3.14
    monkeypatch.setenv("FLOAT_VALUE", "nope")
    assert env_float("FLOAT_VALUE", 1.0) == 1.0
    assert env_app_env() == "staging"
    assert env_is_production_like() is True
