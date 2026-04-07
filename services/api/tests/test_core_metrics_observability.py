from __future__ import annotations

import json
import logging
import sys
import types
from pathlib import Path

import pytest

import app.core.observability as observability
from app.core.metrics import RuntimeMetrics


def test_runtime_metrics_request_and_rum_snapshot(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._rum_summary_path = tmp_path / "rum" / "summary.json"
    metrics._runtime_logs_dir = tmp_path / "logs"
    metrics._runtime_cache_dir = tmp_path / "cache"
    metrics._runtime_gc_state_path = tmp_path / "metrics" / "runtime-gc-state.json"

    # request counters and histogram buckets
    metrics.record_request(200, 0.02)
    metrics.record_request(503, 12.0)
    metrics.record_request(204, -1)  # ignored duration branch
    metrics.record_request(201, float("inf"))  # ignored duration branch
    metrics.increment_active_requests()
    metrics.decrement_active_requests()
    metrics.decrement_active_requests()  # must not go below zero

    # automation and error counters
    metrics.record_automation_run()
    metrics.record_automation_failure()
    metrics.record_automation_cancellation()
    metrics.record_rate_limited()
    metrics.record_rate_limit_redis_error()
    metrics.record_task_store_decode_error()

    # invalid rum inputs should be ignored
    metrics.record_rum_metric("", 10.0)
    metrics.record_rum_metric("lcp", -1.0)
    metrics.record_rum_metric("lcp", float("nan"))
    metrics.record_rum_metric("unknown-metric", 10.0)
    metrics.record_rum_metric(" lcp ", 123.456)

    summary = json.loads(metrics._rum_summary_path.read_text(encoding="utf-8"))
    assert summary["samples_total"] == 1
    assert summary["metrics"]["LCP"]["samples"] == 1
    assert summary["metrics"]["LCP"]["latest"] == 123.456

    snapshot = metrics.snapshot()
    assert snapshot["requests_total"] == 4  # type: ignore[index]
    assert snapshot["request_errors_total"] == 1  # type: ignore[index]
    assert snapshot["active_requests"] == 0  # type: ignore[index]
    assert snapshot["request_latency"]["count"] == 2  # type: ignore[index]
    assert snapshot["automation_runs"] == 1  # type: ignore[index]
    assert snapshot["automation_failures"] == 1  # type: ignore[index]
    assert snapshot["automation_cancellations"] == 1  # type: ignore[index]
    assert snapshot["rate_limited"] == 1  # type: ignore[index]
    assert snapshot["rate_limit_redis_errors"] == 1  # type: ignore[index]
    assert snapshot["task_store_decode_errors"] == 1  # type: ignore[index]


def test_runtime_metrics_prometheus_and_gc_state(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._runtime_logs_dir = tmp_path / "logs"
    metrics._runtime_cache_dir = tmp_path / "cache"
    metrics._runtime_gc_state_path = tmp_path / "metrics" / "runtime-gc-state.json"

    metrics._runtime_logs_dir.mkdir(parents=True, exist_ok=True)
    metrics._runtime_cache_dir.mkdir(parents=True, exist_ok=True)
    (metrics._runtime_logs_dir / "app.log").write_text("x" * 10, encoding="utf-8")
    (metrics._runtime_cache_dir / "cache.bin").write_bytes(b"12345")

    # symlink should be ignored by directory_size_bytes
    (metrics._runtime_logs_dir / "sym.log").symlink_to(metrics._runtime_logs_dir / "app.log")

    gc_state = {
        "last_run_at": "2026-02-28T00:00:00Z",
        "duration_seconds": "2.5",
        "deleted": {"logs": "2", "runs": 1, "cache": 3},
        "errors": 1,
        "bytes_freed": "64",
    }
    metrics._runtime_gc_state_path.parent.mkdir(parents=True, exist_ok=True)
    metrics._runtime_gc_state_path.write_text(json.dumps(gc_state), encoding="utf-8")

    metrics.record_request(200, 0.01)
    metrics.record_rum_metric("cls", 0.12)

    text = metrics.render_prometheus_text(
        automation_summary={"queued": 1, "running": 2, "success": 3, "failed": 4, "total": 10}
    )
    assert 'uiq_http_requests_total{code_class="2xx"} 1' in text
    assert "uiq_http_request_duration_seconds_count 1" in text
    assert 'uiq_automation_tasks{status="running"} 2' in text
    assert 'uiq_rum_metric_samples_total{metric="CLS"} 1' in text
    assert "uiq_runtime_gc_last_duration_seconds 2.5" in text
    assert 'uiq_runtime_gc_deleted_items{scope="logs"} 2' in text


def test_runtime_metrics_gc_state_and_coercion_guards(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._runtime_gc_state_path = tmp_path / "gc.json"

    # missing file
    missing = metrics._load_runtime_gc_state()
    assert missing["total_deleted"] == 0

    # invalid json
    metrics._runtime_gc_state_path.write_text("{broken", encoding="utf-8")
    invalid = metrics._load_runtime_gc_state()
    assert invalid["error_total"] == 0

    # non-dict payload
    metrics._runtime_gc_state_path.write_text("[]", encoding="utf-8")
    non_dict = metrics._load_runtime_gc_state()
    assert non_dict["bytes_freed_total"] == 0

    # valid payload with fallbacks
    metrics._runtime_gc_state_path.write_text(
        json.dumps(
            {
                "last_run_at": "invalid-ts",
                "duration_seconds": "bad",
                "logs_deleted": 4,
                "runs_deleted": 5,
                "cache_deleted": 6,
                "errors": True,
                "error_total": 0,
                "bytes_freed": 7,
                "bytes_freed_total": 0,
            }
        ),
        encoding="utf-8",
    )
    loaded = metrics._load_runtime_gc_state()
    assert loaded["total_deleted"] == 15
    assert loaded["error_total"] == 1
    assert loaded["bytes_freed_total"] == 7

    assert metrics._coerce_non_negative_int(True) == 1
    assert metrics._coerce_non_negative_int(-3) == 0
    assert metrics._coerce_non_negative_int("8") == 8
    assert metrics._coerce_non_negative_int("oops") == 0

    assert metrics._coerce_non_negative_float(True) == 1.0
    assert metrics._coerce_non_negative_float(-1.2) == 0.0
    assert metrics._coerce_non_negative_float("2.75") == 2.75
    assert metrics._coerce_non_negative_float("oops") == 0.0

    assert metrics._to_unix_timestamp(123) == 0.0
    assert metrics._to_unix_timestamp("  ") == 0.0
    assert metrics._to_unix_timestamp("not-a-date") == 0.0
    assert metrics._to_unix_timestamp("2026-01-01T00:00:00Z") > 0


def test_json_formatter_and_error_context(monkeypatch: pytest.MonkeyPatch) -> None:
    observability.REQUEST_ID_CTX.set("ctx-req")
    observability.TRACE_ID_CTX.set("ctx-trace")
    observability.USER_ID_CTX.set("ctx-user")

    formatter = observability.JsonFormatter()
    record = logging.LogRecord(
        name="backend.test",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="boom",
        args=(),
        exc_info=None,
    )
    record.request_id = "extra-req"
    record.trace_id = "extra-trace"
    record.user_id = "extra-user"
    record.path = "/api/x"
    record.method = "POST"
    record.client_ip = "127.0.0.1"
    record.user_agent = "pytest"
    record.status_code = 500
    record.duration_ms = 12
    record.error = "boom"
    record.error_type = "RuntimeError"
    record.error_context = {"k": "v"}
    record.error_stack = "stack"
    record.task_id = "task-1"
    record.state_path = "state.json"
    record.quarantine_path = "quarantine.json"
    record.runtime_policy = {"retention": 7}

    payload = json.loads(formatter.format(record))
    assert payload["request_id"] == "extra-req"
    assert payload["trace_id"] == "extra-trace"
    assert payload["user_id"] == "extra-user"
    assert payload["path"] == "/api/x"
    assert payload["status_code"] == 500
    assert payload["client_ip"] == "127.0.0.1"
    assert payload["user_agent"] == "pytest"
    assert payload["duration_ms"] == 12
    assert payload["error_type"] == "RuntimeError"
    assert payload["task_id"] == "task-1"

    try:
        raise RuntimeError("bad")
    except RuntimeError as exc:
        context = observability.build_error_context(exc)
        record_exc = logging.LogRecord(
            name="backend.test",
            level=logging.ERROR,
            pathname=__file__,
            lineno=2,
            msg="with-exc",
            args=(),
            exc_info=(type(exc), exc, exc.__traceback__),
        )
    rendered_exc = json.loads(formatter.format(record_exc))
    assert "RuntimeError: bad" in rendered_exc["error_stack"]
    assert context["error_type"] == "RuntimeError"
    assert context["error_message"] == "bad"
    assert "RuntimeError" in context["error_stack"]

    monkeypatch.setenv("TRACING_ENABLED", "false")
    assert observability.configure_tracing() is False


def test_error_context_and_formatter_redact_sensitive_values() -> None:
    formatter = observability.JsonFormatter()
    record = logging.LogRecord(
        name="backend.test.redaction",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="failed with token=abc123 and password=secret123",
        args=(),
        exc_info=None,
    )
    record.error = "authorization: bearer top-secret-token"
    record.error_context = {
        "api_key": "sk-test-123",  # pragma: allowlist secret
        "nested": {"cookie": "sessionid=abcdef"},
        "signal": "keep-visible",
        "design": "keep-visible-too",
    }
    rendered = json.loads(formatter.format(record))
    assert "***REDACTED***" in rendered["message"]
    assert "abc123" not in rendered["message"]
    assert "secret123" not in rendered["message"]
    assert rendered["error"] == "authorization: bearer ***REDACTED***"
    assert rendered["error_context"]["api_key"] == "***REDACTED***"
    assert rendered["error_context"]["nested"]["cookie"] == "***REDACTED***"
    assert rendered["error_context"]["signal"] == "keep-visible"
    assert rendered["error_context"]["design"] == "keep-visible-too"

    exception_record = logging.LogRecord(
        name="backend.test.redaction.exception",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="exception payload",
        args=(),
        exc_info=None,
    )
    exception_record.error = RuntimeError("authorization: bearer should-not-leak")
    exception_rendered = json.loads(formatter.format(exception_record))
    assert exception_rendered["error"] == "authorization: bearer ***REDACTED***"

    try:
        raise RuntimeError(
            "db=postgresql://user:plainpass@localhost:5432/app token=abc"  # pragma: allowlist secret
        )
    except RuntimeError as exc:
        context = observability.build_error_context(exc)
    assert "***REDACTED***" in context["error_message"]
    assert "plainpass" not in context["error_message"]
    assert "token=abc" not in context["error_message"]


def test_runtime_policy_and_env_parsers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runtime_root = tmp_path / "runtime"
    monkeypatch.delenv("UIQ_RUNTIME_CACHE_ROOT", raising=False)
    monkeypatch.setenv("RUNTIME_ROOT", str(runtime_root))
    monkeypatch.setenv("RUNTIME_GC_RETENTION_DAYS", "9")
    monkeypatch.setenv("CACHE_TTL_SECONDS", "bad")
    monkeypatch.setenv("CACHE_MAX_ENTRIES", "120")
    monkeypatch.setenv("RUNTIME_GC_SCOPE", " ")
    monkeypatch.setenv("LOG_MAX_BYTES", "")
    monkeypatch.setenv("LOG_BACKUP_COUNT", "2")

    policy = observability._runtime_policy_snapshot()
    assert policy["runtime_gc_retention_days"] == 9
    assert policy["cache_ttl_seconds"] == 900
    assert policy["cache_max_entries"] == 120
    assert policy["runtime_gc_scope"] == "all"
    assert str(runtime_root / "logs") in str(policy["runtime_logs_dir"])
    override_root = tmp_path / "override-runtime-cache"
    monkeypatch.setenv("UIQ_RUNTIME_CACHE_ROOT", str(override_root))
    override_policy = observability._runtime_policy_snapshot()
    assert str(override_root / "logs") in str(override_policy["runtime_logs_dir"])

    monkeypatch.setenv("INT_TEST_VAL", "")
    assert observability._read_non_negative_int_env("INT_TEST_VAL", 7) == 7
    monkeypatch.setenv("INT_TEST_VAL", "-2")
    assert observability._read_non_negative_int_env("INT_TEST_VAL", 7) == 0
    monkeypatch.setenv("INT_TEST_VAL", "x")
    assert observability._read_non_negative_int_env("INT_TEST_VAL", 7) == 7

    monkeypatch.setenv("BOOL_TEST_VAL", "")
    assert observability._read_bool_env("BOOL_TEST_VAL", True) is True
    monkeypatch.setenv("BOOL_TEST_VAL", "off")
    assert observability._read_bool_env("BOOL_TEST_VAL", True) is False
    monkeypatch.setenv("BOOL_TEST_VAL", "yes")
    assert observability._read_bool_env("BOOL_TEST_VAL", False) is True


def test_configure_logging_sets_handlers() -> None:
    observability.configure_logging()
    root_logger = logging.getLogger()
    assert len(root_logger.handlers) >= 2
    assert any(isinstance(handler, logging.StreamHandler) for handler in root_logger.handlers)


def test_configure_logging_flush_callback_tolerates_handler_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callbacks: list[object] = []

    def _capture_register(func: object) -> object:
        callbacks.append(func)
        return func

    monkeypatch.setattr(observability.atexit, "register", _capture_register)
    observability.configure_logging()

    class _FailingHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            pass

        def flush(self) -> None:
            raise RuntimeError("flush-failed")

        def close(self) -> None:
            raise RuntimeError("close-failed")

    root_logger = logging.getLogger()
    original_handlers = list(root_logger.handlers)
    root_logger.handlers = [_FailingHandler()]
    assert callbacks, "configure_logging must register an atexit flush callback"
    flush_callback = callbacks[-1]
    assert callable(flush_callback)
    flush_callback()
    root_logger.handlers = original_handlers


def test_configure_tracing_with_fake_opentelemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _DummyProvider:
        def __init__(self, resource: object) -> None:
            self.resource = resource
            self.processors: list[object] = []

        def add_span_processor(self, processor: object) -> None:
            self.processors.append(processor)

    class _DummyTrace:
        def __init__(self) -> None:
            self.provider: object | None = None

        def set_tracer_provider(self, provider: object) -> None:
            self.provider = provider

    class _DummyResource:
        @staticmethod
        def create(payload: dict[str, str]) -> dict[str, str]:
            return payload

    class _DummyBatchProcessor:
        def __init__(self, exporter: object) -> None:
            self.exporter = exporter

    class _DummyConsoleExporter:
        pass

    dummy_trace = _DummyTrace()

    opentelemetry_mod = types.ModuleType("opentelemetry")
    opentelemetry_mod.trace = dummy_trace  # type: ignore[attr-defined]
    sdk_resources_mod = types.ModuleType("opentelemetry.sdk.resources")
    sdk_resources_mod.Resource = _DummyResource  # type: ignore[attr-defined]
    sdk_trace_mod = types.ModuleType("opentelemetry.sdk.trace")
    sdk_trace_mod.TracerProvider = _DummyProvider  # type: ignore[attr-defined]
    sdk_export_mod = types.ModuleType("opentelemetry.sdk.trace.export")
    sdk_export_mod.BatchSpanProcessor = _DummyBatchProcessor  # type: ignore[attr-defined]
    sdk_export_mod.ConsoleSpanExporter = _DummyConsoleExporter  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "opentelemetry", opentelemetry_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.resources", sdk_resources_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", sdk_trace_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace.export", sdk_export_mod)
    monkeypatch.delitem(
        sys.modules, "opentelemetry.exporter.otlp.proto.http.trace_exporter", raising=False
    )

    monkeypatch.setenv("TRACING_ENABLED", "true")
    monkeypatch.setenv("TRACING_EXPORTER", "otlp")
    monkeypatch.setenv("TRACING_SERVICE_NAME", "svc-a")
    monkeypatch.setenv("TRACING_OTLP_ENDPOINT", "http://otel.example")
    monkeypatch.setenv("TRACING_OTLP_HEADERS", "x=1")

    assert observability.configure_tracing() is True
    assert isinstance(dummy_trace.provider, _DummyProvider)


def test_configure_tracing_otlp_exporter_success_and_console_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _DummyProvider:
        def __init__(self, resource: object) -> None:
            self.resource = resource
            self.processors: list[object] = []

        def add_span_processor(self, processor: object) -> None:
            self.processors.append(processor)

    class _DummyTrace:
        def __init__(self) -> None:
            self.provider: object | None = None

        def set_tracer_provider(self, provider: object) -> None:
            self.provider = provider

    class _DummyResource:
        @staticmethod
        def create(payload: dict[str, str]) -> dict[str, str]:
            return payload

    class _DummyBatchProcessor:
        def __init__(self, exporter: object) -> None:
            self.exporter = exporter

    class _DummyConsoleExporter:
        pass

    class _DummyOTLPExporter:
        def __init__(self, **kwargs: str) -> None:
            self.kwargs = kwargs

    dummy_trace = _DummyTrace()
    opentelemetry_mod = types.ModuleType("opentelemetry")
    opentelemetry_mod.trace = dummy_trace  # type: ignore[attr-defined]

    sdk_resources_mod = types.ModuleType("opentelemetry.sdk.resources")
    sdk_resources_mod.Resource = _DummyResource  # type: ignore[attr-defined]
    sdk_trace_mod = types.ModuleType("opentelemetry.sdk.trace")
    sdk_trace_mod.TracerProvider = _DummyProvider  # type: ignore[attr-defined]
    sdk_export_mod = types.ModuleType("opentelemetry.sdk.trace.export")
    sdk_export_mod.BatchSpanProcessor = _DummyBatchProcessor  # type: ignore[attr-defined]
    sdk_export_mod.ConsoleSpanExporter = _DummyConsoleExporter  # type: ignore[attr-defined]
    otlp_exporter_mod = types.ModuleType("opentelemetry.exporter.otlp.proto.http.trace_exporter")
    otlp_exporter_mod.OTLPSpanExporter = _DummyOTLPExporter  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "opentelemetry", opentelemetry_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.resources", sdk_resources_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", sdk_trace_mod)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace.export", sdk_export_mod)
    monkeypatch.setitem(
        sys.modules,
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        otlp_exporter_mod,
    )

    monkeypatch.setenv("TRACING_ENABLED", "true")
    monkeypatch.setenv("TRACING_EXPORTER", "otlp")
    monkeypatch.setenv("TRACING_SERVICE_NAME", "svc-b")
    monkeypatch.setenv("TRACING_OTLP_ENDPOINT", "http://collector.internal")
    monkeypatch.setenv("TRACING_OTLP_HEADERS", "k=v")
    assert observability.configure_tracing() is True
    assert isinstance(dummy_trace.provider, _DummyProvider)
    otlp_processor = dummy_trace.provider.processors[-1]
    assert isinstance(otlp_processor, _DummyBatchProcessor)
    assert isinstance(otlp_processor.exporter, _DummyOTLPExporter)  # type: ignore[attr-defined]
    assert otlp_processor.exporter.kwargs == {  # type: ignore[attr-defined]
        "endpoint": "http://collector.internal",
        "headers": "k=v",
    }

    monkeypatch.setenv("TRACING_EXPORTER", "console")
    assert observability.configure_tracing() is True
    console_processor = dummy_trace.provider.processors[-1]
    assert isinstance(console_processor.exporter, _DummyConsoleExporter)  # type: ignore[attr-defined]
