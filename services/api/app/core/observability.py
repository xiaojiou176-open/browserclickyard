from __future__ import annotations

from app.core.settings import env_str
from app.core.runtime_paths import repo_root, runtime_cache_root, runtime_logs_path, runtime_logs_root

import os
import json
import logging
import re
import time
import atexit
import traceback
from datetime import datetime, timezone
from contextvars import ContextVar
from logging.handlers import RotatingFileHandler
from typing import Any

STARTED_AT = time.time()
REQUEST_ID_CTX: ContextVar[str] = ContextVar("request_id", default="-")
TRACE_ID_CTX: ContextVar[str] = ContextVar("trace_id", default="-")
USER_ID_CTX: ContextVar[str] = ContextVar("user_id", default="-")

_REDACTED = "***REDACTED***"
_SENSITIVE_EXACT_KEYS = {
    "token",
    "access_token",
    "refresh_token",
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "set_cookie",
    "signature",
    "sig",
    "key",
}
_SENSITIVE_KEY_SUFFIXES = (
    "_token",
    "_password",
    "_secret",
    "_api_key",
    "_apikey",
    "_signature",
)
_SENSITIVE_REPLACERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(authorization\s*[:=]\s*basic\s+)([^\s,;]+)", re.IGNORECASE),
        rf"\1{_REDACTED}",
    ),
    (
        re.compile(r"(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)", re.IGNORECASE),
        rf"\1{_REDACTED}",
    ),
    (
        re.compile(
            r"((?:x-automation-token|x-auth-token|x-api-key|cookie|set-cookie)\s*[:=]\s*)([^\r\n]+)",
            re.IGNORECASE,
        ),
        rf"\1{_REDACTED}",
    ),
    (
        re.compile(
            r"(postgres(?:ql)?://[^:\s/]+:)([^@/\s]+)(@)",
            re.IGNORECASE,
        ),
        rf"\1{_REDACTED}\3",
    ),
    (
        re.compile(
            r"((?:^|[?&]|[\s,{])(?:token|access_token|refresh_token|password|passwd|secret|api_key|apikey|key|sig|signature)\s*(?:=|:)\s*)([^&\s,;\"}]+)",
            re.IGNORECASE,
        ),
        rf"\1{_REDACTED}",
    ),
    (
        re.compile(
            r"(\"?(?:token|accessToken|refreshToken|password|passwd|secret|apiKey|api_key|key|sig|signature)\"?\s*:\s*\")([^\"]*)(\")",
            re.IGNORECASE,
        ),
        rf"\1{_REDACTED}\3",
    ),
    (
        re.compile(r"((?:^|\s)[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)\s*=\s*)([^\s]+)"),
        rf"\1{_REDACTED}",
    ),
)


def _redact_sensitive_text(value: str) -> str:
    redacted = value
    for pattern, replacement in _SENSITIVE_REPLACERS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def _is_sensitive_key(key: str) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    if not normalized:
        return False
    if normalized in _SENSITIVE_EXACT_KEYS:
        return True
    return any(normalized.endswith(suffix) for suffix in _SENSITIVE_KEY_SUFFIXES)


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return _redact_sensitive_text(value)
    if isinstance(value, BaseException):
        return _redact_sensitive_text(str(value))
    if isinstance(value, dict):
        redacted: dict[Any, Any] = {}
        for key, child in value.items():
            if isinstance(key, str) and _is_sensitive_key(key):
                redacted[key] = _REDACTED
            else:
                redacted[key] = _redact_value(child)
        return redacted
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "severity": str(getattr(record, "severity", record.levelname.lower())),
            "component": str(getattr(record, "component", f"backend.{record.name}")),
            "evidenceClass": str(getattr(record, "evidenceClass", "log")),
            "event": str(getattr(record, "event", record.getMessage())),
            "logger": record.name,
            "message": _redact_sensitive_text(record.getMessage()),
            "request_id": REQUEST_ID_CTX.get(),
            "trace_id": TRACE_ID_CTX.get(),
            "user_id": USER_ID_CTX.get(),
        }
        if hasattr(record, "request_id"):
            payload["request_id"] = record.request_id
        if hasattr(record, "trace_id"):
            payload["trace_id"] = record.trace_id
        if hasattr(record, "user_id"):
            payload["user_id"] = record.user_id
        if hasattr(record, "path"):
            payload["path"] = record.path
        if hasattr(record, "method"):
            payload["method"] = record.method
        if hasattr(record, "client_ip"):
            payload["client_ip"] = record.client_ip
        if hasattr(record, "user_agent"):
            payload["user_agent"] = record.user_agent
        if hasattr(record, "status_code"):
            payload["status_code"] = record.status_code
        if hasattr(record, "duration_ms"):
            payload["duration_ms"] = record.duration_ms
        if hasattr(record, "error"):
            payload["error"] = _redact_value(record.error)
        if hasattr(record, "error_type"):
            payload["error_type"] = record.error_type
        if hasattr(record, "error_context"):
            payload["error_context"] = _redact_value(record.error_context)
        if hasattr(record, "error_stack"):
            payload["error_stack"] = _redact_value(record.error_stack)
        if record.exc_info and "error_stack" not in payload:
            payload["error_stack"] = _redact_sensitive_text(
                "".join(traceback.format_exception(*record.exc_info)).strip()
            )
        if hasattr(record, "task_id"):
            payload["task_id"] = record.task_id
        if hasattr(record, "state_path"):
            payload["state_path"] = record.state_path
        if hasattr(record, "quarantine_path"):
            payload["quarantine_path"] = record.quarantine_path
        if hasattr(record, "runtime_policy"):
            payload["runtime_policy"] = record.runtime_policy
        return json.dumps(payload, ensure_ascii=False)


def build_error_context(error: Exception) -> dict[str, Any]:
    stack = "".join(traceback.format_exception(type(error), error, error.__traceback__)).strip()
    return {
        "error_type": error.__class__.__name__,
        "error_message": _redact_sensitive_text(str(error)),
        "error_stack": _redact_sensitive_text(stack),
    }


def configure_logging() -> None:
    log_level = env_str("LOG_LEVEL", "DEBUG").upper()
    runtime_log_dir = runtime_logs_path("runtime", root=repo_root())
    runtime_log_dir.mkdir(parents=True, exist_ok=True)
    log_file = runtime_log_dir / "service-api.app.jsonl"
    max_bytes = max(1_048_576, int(env_str("LOG_MAX_BYTES", str(5 * 1_048_576))))
    backup_count = max(2, int(env_str("LOG_BACKUP_COUNT", "5")))

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(JsonFormatter())
    file_handler = RotatingFileHandler(
        log_file, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
    )
    file_handler.setFormatter(JsonFormatter())
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)
    root_logger.setLevel(log_level)
    runtime_policy = _runtime_policy_snapshot()
    logging.getLogger("observability").info(
        "runtime storage policy initialized",
        extra={
            "runtime_policy": runtime_policy,
            "component": "backend.runtime",
            "evidenceClass": "log",
            "event": "runtime.storage_policy.initialized",
        },
    )

    @atexit.register
    def _flush_logs() -> None:
        for handler in root_logger.handlers:
            try:
                handler.flush()
                handler.close()
            except Exception:
                continue


def _runtime_policy_snapshot() -> dict[str, Any]:
    base_root = repo_root()
    runtime_root = runtime_cache_root(base_root)
    runtime_gc_retention_days = _read_non_negative_int_env(
        "RUNTIME_GC_RETENTION_DAYS",
        7,
    )
    return {
        "runtime_gc_retention_days": runtime_gc_retention_days,
        "cache_ttl_seconds": _read_non_negative_int_env("CACHE_TTL_SECONDS", 900),
        "cache_max_entries": _read_non_negative_int_env("CACHE_MAX_ENTRIES", 500),
        "runtime_gc_max_log_size_mb": _read_non_negative_int_env("RUNTIME_GC_MAX_LOG_SIZE_MB", 64),
        "runtime_gc_log_tail_lines": _read_non_negative_int_env("RUNTIME_GC_LOG_TAIL_LINES", 4000),
        "runtime_gc_scope": os.getenv("RUNTIME_GC_SCOPE", "all").strip() or "all",
        "runtime_gc_keep_runs": _read_non_negative_int_env("RUNTIME_GC_KEEP_RUNS", 50),
        "runtime_gc_max_delete_per_run": _read_non_negative_int_env(
            "RUNTIME_GC_MAX_DELETE_PER_RUN", 500
        ),
        "runtime_gc_fail_on_error": _read_bool_env("RUNTIME_GC_FAIL_ON_ERROR", False),
        "runtime_rotating_log_max_bytes": _read_non_negative_int_env(
            "LOG_MAX_BYTES", 5 * 1_048_576
        ),
        "runtime_rotating_log_backup_count": _read_non_negative_int_env("LOG_BACKUP_COUNT", 5),
        "runtime_logs_dir": str(runtime_logs_root(base_root)),
        "runtime_cache_dir": os.getenv("RUNTIME_CACHE_DIR", str(runtime_root / "cache")).strip()
        or str(runtime_root / "cache"),
        "runtime_gc_state_path": os.getenv(
            "RUNTIME_GC_STATE_PATH", str(runtime_root / "metrics" / "runtime-gc-state.json")
        ).strip()
        or str(runtime_root / "metrics" / "runtime-gc-state.json"),
    }


def _read_non_negative_int_env(key: str, default: int) -> int:
    raw = os.getenv(key, str(default)).strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(0, value)


def _read_bool_env(key: str, default: bool) -> bool:
    raw = os.getenv(key, "true" if default else "false").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def configure_tracing() -> bool:
    enabled = os.getenv("TRACING_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return False

    tracer_logger = logging.getLogger("tracing")
    exporter = os.getenv("TRACING_EXPORTER", "console").strip().lower() or "console"
    service_name = os.getenv("TRACING_SERVICE_NAME", "uiq-backend").strip() or "uiq-backend"

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
    except Exception as exc:  # pragma: no cover - optional dependency branch
        tracer_logger.warning(
            "tracing enabled but opentelemetry packages are unavailable", extra={"error": str(exc)}
        )
        return False

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    if exporter == "otlp":
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            exporter_kwargs: dict[str, str] = {}
            endpoint = os.getenv("TRACING_OTLP_ENDPOINT", "").strip()
            headers = os.getenv("TRACING_OTLP_HEADERS", "").strip()
            if endpoint:
                exporter_kwargs["endpoint"] = endpoint
            if headers:
                exporter_kwargs["headers"] = headers
            span_exporter = OTLPSpanExporter(**exporter_kwargs)
        except Exception as exc:  # pragma: no cover - optional dependency branch
            tracer_logger.warning(
                "otlp exporter unavailable, fallback to console exporter",
                extra={"error": str(exc)},
            )
            span_exporter = ConsoleSpanExporter()
    else:
        span_exporter = ConsoleSpanExporter()

    provider.add_span_processor(BatchSpanProcessor(span_exporter))
    trace.set_tracer_provider(provider)
    tracer_logger.info(
        "tracing initialized", extra={"exporter": exporter, "service_name": service_name}
    )
    return True
