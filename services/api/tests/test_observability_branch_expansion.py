from __future__ import annotations

import logging
import sys
import types

import pytest

import app.core.observability as observability


def test_redact_helpers_cover_empty_key_list_tuple_and_passthrough() -> None:
    assert observability._is_sensitive_key("   ") is False

    redacted_list = observability._redact_value(
        [
            "token=abc123",
            {"api_key": "sk-test-secret", "safe": "visible"},  # pragma: allowlist secret
        ]
    )
    assert isinstance(redacted_list, list)
    assert redacted_list[0] == "token=***REDACTED***"
    assert redacted_list[1]["api_key"] == "***REDACTED***"
    assert redacted_list[1]["safe"] == "visible"

    redacted_tuple = observability._redact_value(("password=plain-text",))
    assert isinstance(redacted_tuple, tuple)
    assert redacted_tuple[0] == "password=***REDACTED***"

    assert observability._redact_value(123) == 123


def test_configure_logging_flush_callback_closes_handler_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callbacks: list[object] = []

    def _capture_register(func: object) -> object:
        callbacks.append(func)
        return func

    monkeypatch.setattr(observability.atexit, "register", _capture_register)
    observability.configure_logging()

    class _ClosableHandler(logging.Handler):
        def __init__(self) -> None:
            super().__init__()
            self.flush_called = False
            self.close_called = False

        def emit(self, record: logging.LogRecord) -> None:
            return

        def flush(self) -> None:
            self.flush_called = True

        def close(self) -> None:
            self.close_called = True
            super().close()

    handler = _ClosableHandler()
    root_logger = logging.getLogger()
    original_handlers = list(root_logger.handlers)
    root_logger.handlers = [handler]
    assert callbacks
    flush_callback = callbacks[-1]
    assert callable(flush_callback)
    flush_callback()
    root_logger.handlers = original_handlers

    assert handler.flush_called is True
    assert handler.close_called is True


def test_configure_tracing_otlp_without_endpoint_and_headers(
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
    monkeypatch.setenv("TRACING_SERVICE_NAME", "svc-branch")
    monkeypatch.setenv("TRACING_OTLP_ENDPOINT", "")
    monkeypatch.setenv("TRACING_OTLP_HEADERS", " ")

    assert observability.configure_tracing() is True
    assert isinstance(dummy_trace.provider, _DummyProvider)
    processor = dummy_trace.provider.processors[-1]
    assert isinstance(processor, _DummyBatchProcessor)
    assert isinstance(processor.exporter, _DummyOTLPExporter)  # type: ignore[attr-defined]
    assert processor.exporter.kwargs == {}  # type: ignore[attr-defined]
