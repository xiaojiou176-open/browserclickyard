from __future__ import annotations

import logging
import os
import importlib
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

yaml: Any = importlib.import_module("yaml")


_TRUE_SET = {"1", "true", "yes", "on"}
_PROD_LIKE_ENV_NAMES = {"production", "staging"}
_REQUIRED_IN_PROD_FALLBACK = frozenset(
    {
        "AUTOMATION_API_TOKEN",
    }
)
_PLACEHOLDER_VALUES = frozenset({"replace-with-strong-token"})


def _load_required_in_prod_keys() -> frozenset[str]:
    contract_path = Path(__file__).resolve().parents[4] / "configs" / "env" / "contract.yaml"
    try:
        parsed = yaml.safe_load(contract_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return _REQUIRED_IN_PROD_FALLBACK

    keys: set[str] = set()
    variables = parsed.get("variables")
    if not isinstance(variables, list):
        return _REQUIRED_IN_PROD_FALLBACK
    for item in variables:
        if not isinstance(item, dict):
            continue
        if item.get("required") is not True:
            continue
        name = str(item.get("name", "")).strip()
        if name:
            keys.add(name)
    return frozenset(keys) if keys else _REQUIRED_IN_PROD_FALLBACK


_REQUIRED_IN_PROD_KEYS = _load_required_in_prod_keys()


def normalize_app_env(value: str | None, default: str = "development") -> str:
    raw = (value or default).strip().lower()
    return raw


def is_production_like_env(value: str | None, default: str = "development") -> bool:
    return normalize_app_env(value, default) in _PROD_LIKE_ENV_NAMES


class RuntimeSettings(BaseSettings):
    """Central runtime settings loader for backend services.

    Environment variables are the source of truth. Local `.env` and `.env.local`
    are optional development overlays.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="DEBUG", alias="LOG_LEVEL")
    log_max_bytes: int = Field(default=5 * 1_048_576, alias="LOG_MAX_BYTES")
    log_backup_count: int = Field(default=5, alias="LOG_BACKUP_COUNT")

    cors_allowed_origins: str = Field(
        default="http://127.0.0.1:17373,http://localhost:17373", alias="CORS_ALLOWED_ORIGINS"
    )
    trusted_hosts: str = Field(default="127.0.0.1,localhost,testserver", alias="TRUSTED_HOSTS")

    cookie_secure: bool = Field(default=True, alias="COOKIE_SECURE")
    csrf_ttl_seconds: int = Field(default=900, alias="CSRF_TTL_SECONDS")
    frontend_register_url: str = Field(default="", alias="FRONTEND_REGISTER_URL")

    automation_api_token: SecretStr | None = Field(
        default_factory=lambda: SecretStr("replace-with-strong-token"), alias="AUTOMATION_API_TOKEN"
    )
    automation_require_token: bool = Field(default=True, alias="AUTOMATION_REQUIRE_TOKEN")
    automation_allow_local_no_token: bool = Field(
        default=False, alias="AUTOMATION_ALLOW_LOCAL_NO_TOKEN"
    )
    automation_emergency_kill_switch: bool = Field(
        default=False, alias="AUTOMATION_EMERGENCY_KILL_SWITCH"
    )
    automation_rate_limit_per_minute: int = Field(
        default=120, alias="AUTOMATION_RATE_LIMIT_PER_MINUTE"
    )
    automation_max_rate_buckets: int = Field(default=2000, alias="AUTOMATION_MAX_RATE_BUCKETS")
    automation_failure_alert_threshold: float = Field(
        default=0.2, alias="AUTOMATION_FAILURE_ALERT_THRESHOLD"
    )

    automation_max_tasks: int = Field(default=300, alias="AUTOMATION_MAX_TASKS")
    automation_max_parallel: int = Field(default=6, alias="AUTOMATION_MAX_PARALLEL")
    automation_max_parallel_long: int = Field(default=1, alias="AUTOMATION_MAX_PARALLEL_LONG")
    automation_default_retries: int = Field(default=1, alias="AUTOMATION_DEFAULT_RETRIES")
    automation_command_timeout_seconds: int = Field(
        default=1800, alias="AUTOMATION_COMMAND_TIMEOUT_SECONDS"
    )

    gemini_api_key: SecretStr | None = Field(default=None, alias="GEMINI_API_KEY")
    gemini_primary_model: str = Field(default="models/gemini-3.1-pro-preview", alias="GEMINI_MODEL")
    gemini_fast_model: str = Field(default="models/gemini-3.0-flash", alias="GEMINI_FAST_MODEL")
    gemini_embedding_model: str = Field(
        default="gemini-embedding-001", alias="GEMINI_EMBEDDING_MODEL"
    )
    gemini_thinking_level: str = Field(default="high", alias="GEMINI_THINKING_LEVEL")
    gemini_include_thoughts: str = Field(default="true", alias="GEMINI_INCLUDE_THOUGHTS")
    gemini_media_resolution_default: str = Field(
        default="high", alias="GEMINI_MEDIA_RESOLUTION_DEFAULT"
    )

    database_url: str = Field(
        default="postgresql+pg8000://automation:automation@postgres:5432/automation",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://redis:6379/0", alias="REDIS_URL")

    universal_automation_runtime_dir: str = Field(
        default="", alias="UNIVERSAL_AUTOMATION_RUNTIME_DIR"
    )
    universal_platform_data_dir: str = Field(default="", alias="UNIVERSAL_PLATFORM_DATA_DIR")

    vonage_inbound_token: SecretStr | None = Field(default=None, alias="VONAGE_INBOUND_TOKEN")
    vonage_inbound_token_header_enabled: bool = Field(
        default=False, alias="VONAGE_INBOUND_TOKEN_HEADER_ENABLED"
    )
    vonage_otp_to_number: str = Field(default="", alias="VONAGE_OTP_TO_NUMBER")
    vonage_signature_secret: SecretStr | None = Field(default=None, alias="VONAGE_SIGNATURE_SECRET")
    vonage_signature_algo: str = Field(default="sha256", alias="VONAGE_SIGNATURE_ALGO")
    vonage_signature_max_skew_seconds: int = Field(
        default=600, alias="VONAGE_SIGNATURE_MAX_SKEW_SECONDS"
    )
    vonage_message_id_ttl_seconds: int = Field(default=86400, alias="VONAGE_MESSAGE_ID_TTL_SECONDS")

    otp_dedupe_redis_prefix: str = Field(
        default="otp:vonage:dedupe", alias="OTP_DEDUPE_REDIS_PREFIX"
    )
    otp_dedupe_strict: bool = Field(default=False, alias="OTP_DEDUPE_STRICT")

    gmail_imap_user: str = Field(default="", alias="GMAIL_IMAP_USER")
    gmail_imap_password: SecretStr | None = Field(default=None, alias="GMAIL_IMAP_PASSWORD")
    imap_host: str = Field(default="", alias="IMAP_HOST")
    imap_user: str = Field(default="", alias="IMAP_USER")
    imap_password: SecretStr | None = Field(default=None, alias="IMAP_PASSWORD")

    recon_main_engine: str = Field(default="gemini", alias="RECON_MAIN_ENGINE")
    reconstruction_artifact_max_bytes: int = Field(
        default=16 * 1024 * 1024, alias="RECONSTRUCTION_ARTIFACT_MAX_BYTES"
    )

    @model_validator(mode="after")
    def _validate_required_in_prod(self) -> "RuntimeSettings":
        normalized_env = normalize_app_env(self.app_env)
        if self.app_env != normalized_env:
            self.app_env = normalized_env

        if not is_production_like_env(self.app_env):
            self._warn_placeholder_in_non_prod()
            return self
        missing = _collect_missing_required_in_prod(self)
        if missing:
            raise ValueError(f"Missing required prod env vars: {', '.join(missing)}")
        return self

    def _warn_placeholder_in_non_prod(self) -> None:
        """Emit a WARNING when a required-in-prod key still holds its placeholder
        value in a non-production environment, so the issue is surfaced early
        rather than only on the first production deployment."""
        _logger = logging.getLogger(__name__)
        for key in sorted(_REQUIRED_IN_PROD_KEYS):
            # _ALIAS_MAP is defined at module level after the class; safe to
            # reference here because model validators run at instance creation
            # time, after full module initialisation.
            field_name = _ALIAS_MAP.get(key)
            if field_name:
                value = _as_string(getattr(self, field_name, None), "").strip()
            else:
                value = (os.environ.get(key) or "").strip()
            if _is_placeholder_value(key, value):
                _logger.warning(
                    "Security warning: %s is still set to its placeholder value "
                    "('%s'). Replace it before deploying to production.",
                    key,
                    value,
                )


@lru_cache(maxsize=1)
def _cached_settings() -> RuntimeSettings:
    return RuntimeSettings()


def get_settings() -> RuntimeSettings:
    """Return cached settings in normal runtime, fresh settings during pytest."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return RuntimeSettings()
    return _cached_settings()


def refresh_settings_cache() -> None:
    _cached_settings.cache_clear()


def _settings_without_env_file() -> RuntimeSettings:
    kwargs: dict[str, Any] = {"_env_file": None}
    return RuntimeSettings(**kwargs)


def _alias_to_field() -> dict[str, str]:
    mapping: dict[str, str] = {}
    for field_name, field_info in RuntimeSettings.model_fields.items():
        alias = field_info.alias or field_name
        mapping[alias] = field_name
    return mapping


_ALIAS_MAP = _alias_to_field()


def _as_string(value: Any, default: str) -> str:
    if value is None:
        return default
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    return str(value)


def _is_placeholder_value(key: str, value: str) -> bool:
    if key not in _REQUIRED_IN_PROD_KEYS:
        return False
    return value.strip() in _PLACEHOLDER_VALUES


def _collect_missing_required_in_prod(settings: RuntimeSettings) -> list[str]:
    missing: list[str] = []
    for key in sorted(_REQUIRED_IN_PROD_KEYS):
        field_name = _ALIAS_MAP.get(key)
        if field_name:
            value = _as_string(getattr(settings, field_name), "").strip()
            if value and not _is_placeholder_value(key, value):
                continue
        else:
            fallback = (os.environ.get(key) or "").strip()
            if fallback and not _is_placeholder_value(key, fallback):
                continue
        missing.append(key)
    return missing


def env_str(key: str, default: str = "") -> str:
    field_name = _ALIAS_MAP.get(key)
    if os.environ.get("PYTEST_CURRENT_TEST"):
        # Under pytest we need strict env isolation so monkeypatch.delenv/setenv
        # behaves deterministically and is not overridden by `.env` files.
        # Keep RuntimeSettings defaults by disabling only env-file loading.
        try:
            if field_name:
                value = getattr(_settings_without_env_file(), field_name)
                resolved = _as_string(value, default)
                if _is_placeholder_value(key, resolved):
                    return default
                return resolved
        except Exception:
            pass
        fallback = os.environ.get(key)
        if fallback is None or _is_placeholder_value(key, fallback):
            return default
        return fallback

    try:
        if field_name:
            value = getattr(get_settings(), field_name)
            resolved = _as_string(value, default)
            if _is_placeholder_value(key, resolved):
                return default
            return resolved
    except Exception:
        # Keep env helpers resilient even when settings validation fails under test monkeypatches.
        pass
    fallback = os.environ.get(key)
    if fallback is None or _is_placeholder_value(key, fallback):
        return default
    return fallback


def env_int(key: str, default: int) -> int:
    raw = env_str(key, str(default)).strip()
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def env_float(key: str, default: float) -> float:
    raw = env_str(key, str(default)).strip()
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def env_bool(key: str, default: bool = False) -> bool:
    raw = env_str(key, "1" if default else "0").strip().lower()
    return raw in _TRUE_SET


def env_csv(key: str, default: str = "") -> list[str]:
    raw = env_str(key, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def env_app_env(default: str = "development") -> str:
    return normalize_app_env(env_str("APP_ENV", default), default)


def env_is_production_like(default: str = "development") -> bool:
    return is_production_like_env(env_app_env(default), default)
