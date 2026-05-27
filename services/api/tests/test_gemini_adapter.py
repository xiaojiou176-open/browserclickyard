from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

import app.services.engine_adapters.gemini_adapter as gemini_module
from app.services.engine_adapters.gemini_adapter import GeminiAdapter, GeminiExtractionInput


def _payload(*, event_summary: str = "") -> GeminiExtractionInput:
    return GeminiExtractionInput(
        start_url="https://example.com/register",
        har_entries=[
            {
                "method": "POST",
                "url": "https://example.com/api/register",
                "status": 201,
            }
        ],
        html_content="<form><input name='email'><input name='password'></form>",
        extractor_strategy="balanced",
        event_summary_text=event_summary,
    )


def test_gemini_adapter_uses_sdk_generation(monkeypatch) -> None:
    calls: dict[str, object] = {}

    class FakeModels:
        def generate_content(self, *, model: str, contents: list[str], config: object) -> object:
            calls["model"] = model
            calls["contents"] = contents
            calls["config"] = config
            return SimpleNamespace(
                parsed={
                    "steps": [
                        {
                            "action": "click",
                            "confidence": 0.92,
                            "evidence_ref": "model:submit",
                        }
                    ]
                }
            )

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            calls["api_key"] = api_key
            self.models = FakeModels()

    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("RECON_GEMINI_MODEL", raising=False)
    monkeypatch.delenv("RECON_GEMINI_THINKING_LEVEL", raising=False)
    monkeypatch.setattr(gemini_module, "_genai", SimpleNamespace(Client=FakeClient))
    monkeypatch.setattr(gemini_module, "_genai_types", None)

    steps = GeminiAdapter().extract_steps(_payload(event_summary="typed email then submitted"))

    assert calls["api_key"] == "test-gemini-key"
    assert calls["model"] == "models/gemini-3.1-pro-preview"
    assert "typed email then submitted" in str(calls["contents"])
    assert isinstance(calls["config"], dict)
    assert calls["config"]["response_schema"]["type"] == "object"
    assert calls["config"]["thinking_config"]["thinking_level"] == "high"
    assert steps[0]["action"] == "navigate"
    assert steps[1]["action"] == "click"
    assert steps[1]["source_engine"] == "gemini"


def test_gemini_adapter_fallbacks_with_ai_reason_code(monkeypatch) -> None:
    class FailingModels:
        def generate_content(self, *, model: str, contents: list[str], config: object) -> object:
            raise RuntimeError("boom")

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            self.models = FailingModels()

    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(gemini_module, "_genai", SimpleNamespace(Client=FakeClient))
    monkeypatch.setattr(gemini_module, "_genai_types", None)

    payload = GeminiExtractionInput(
        start_url="https://example.com/register",
        har_entries=[],
        html_content="<html></html>",
        extractor_strategy="strict",
    )

    steps = GeminiAdapter().extract_steps(payload)

    manual_step = next(step for step in steps if step.get("action") == "manual_gate")
    assert manual_step["unsupported_reason"] == "ai.gemini.request_failed"
    assert manual_step["reason_code"] == "ai.gemini.request_failed"


def test_gemini_adapter_keeps_heuristic_steps_without_api_key(monkeypatch) -> None:
    monkeypatch.delenv("RECON_GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    steps = GeminiAdapter().extract_steps(_payload())

    assert steps[0]["action"] == "navigate"
    assert any(step.get("action") == "type" for step in steps)
    assert all(step.get("action") != "manual_gate" for step in steps)


def test_gemini_adapter_invalid_action_schema_returns_reason_code(monkeypatch) -> None:
    class InvalidActionModels:
        def generate_content(self, *, model: str, contents: list[str], config: object) -> object:
            return SimpleNamespace(
                parsed={
                    "steps": [
                        {
                            "action": "drag",
                            "confidence": 0.8,
                            "evidence_ref": "model:drag",
                        }
                    ]
                }
            )

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            self.models = InvalidActionModels()

    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(gemini_module, "_genai", SimpleNamespace(Client=FakeClient))
    monkeypatch.setattr(gemini_module, "_genai_types", None)

    payload = GeminiExtractionInput(
        start_url="https://example.com/register",
        har_entries=[],
        html_content="<html></html>",
        extractor_strategy="balanced",
    )

    steps = GeminiAdapter().extract_steps(payload)
    manual_step = next(step for step in steps if step.get("action") == "manual_gate")
    assert manual_step["unsupported_reason"] == "ai.gemini.invalid_action_schema"
    assert manual_step["reason_code"] == "ai.gemini.invalid_action_schema"


def test_extract_steps_with_context_cache_hit_and_miss(monkeypatch) -> None:
    adapter = GeminiAdapter()
    calls = {"count": 0}

    def _fake_extract_steps_main(payload: GeminiExtractionInput):
        calls["count"] += 1
        return ([{"action": "navigate", "url": payload.start_url}], {"strategy": "strong"})

    monkeypatch.setattr(adapter, "_extract_steps_main", _fake_extract_steps_main)

    miss = adapter.extract_steps_with_context_cache(_payload(), cache_key="k1", ttl_seconds=30)
    hit = adapter.extract_steps_with_context_cache(_payload(), cache_key="k1", ttl_seconds=30)

    assert miss["status"] == "api_miss"
    assert hit["status"] == "api_hit"
    assert hit["hit"] is True
    assert calls["count"] == 1


def test_extract_steps_with_sdk_sdk_unavailable(monkeypatch) -> None:
    adapter = GeminiAdapter()
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(gemini_module, "_genai", None)
    steps, reason = adapter._extract_steps_with_sdk(_payload())
    assert steps is None
    assert reason == "ai.gemini.sdk_unavailable"


def test_extract_steps_with_sdk_invalid_response(monkeypatch) -> None:
    class InvalidResponseModels:
        def generate_content(self, *, model: str, contents: list[str], config: object) -> object:
            return SimpleNamespace(parsed={"steps": []})

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            self.models = InvalidResponseModels()

    adapter = GeminiAdapter()
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(gemini_module, "_genai", SimpleNamespace(Client=FakeClient))
    monkeypatch.setattr(gemini_module, "_genai_types", None)

    steps, reason = adapter._extract_steps_with_sdk(_payload())
    assert steps is None
    assert reason == "ai.gemini.invalid_response"


def test_parse_strong_response_prefers_function_call() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(
        function_calls=[
            SimpleNamespace(
                name="emit_reconstruction_steps",
                args={
                    "steps": [
                        {
                            "action": "click",
                            "confidence": 0.9,
                            "evidence_ref": "fn:click",
                        }
                    ]
                },
            )
        ]
    )
    parsed = adapter._parse_strong_response(response, "https://example.com/register")
    assert parsed["path"] == "function_call"
    assert parsed["steps"][0]["action"] == "navigate"
    assert parsed["steps"][1]["action"] == "click"


def test_parse_strong_response_falls_back_to_text_json() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(
        text='{"steps":[{"action":"click","confidence":0.8,"evidence_ref":"x"}]}'
    )
    parsed = adapter._parse_strong_response(response, "https://example.com/register")
    assert parsed["path"] == "text_json_fallback"
    assert parsed["steps"][0]["action"] == "navigate"


def test_parse_strong_response_returns_none_path_when_no_steps() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(text="{}")
    parsed = adapter._parse_strong_response(response, "https://example.com/register")
    assert parsed["path"] == "none"
    assert parsed["steps"] == []


def test_build_generate_config_uses_sdk_types_when_available(monkeypatch) -> None:
    class FakeThinkingLevel:
        HIGH = "HIGH"
        LOW = "LOW"

    class FakeThinkingConfig(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    class FakeGenerateContentConfig(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    fake_types = SimpleNamespace(
        ThinkingLevel=FakeThinkingLevel,
        ThinkingConfig=FakeThinkingConfig,
        GenerateContentConfig=FakeGenerateContentConfig,
    )
    adapter = GeminiAdapter()
    monkeypatch.setattr(gemini_module, "_genai_types", fake_types)
    monkeypatch.setenv("RECON_GEMINI_THINKING_LEVEL", "low")
    monkeypatch.setenv("RECON_GEMINI_INCLUDE_THOUGHTS", "false")

    config = adapter._build_generate_config()

    assert isinstance(config, FakeGenerateContentConfig)
    assert config["thinking_config"]["thinking_level"] == "LOW"
    assert config["thinking_config"]["include_thoughts"] is False


def test_build_generate_config_falls_back_when_sdk_lacks_thinking_level_enum(monkeypatch) -> None:
    class FakeThinkingConfig(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    class FakeGenerateContentConfig(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    fake_types = SimpleNamespace(
        ThinkingConfig=FakeThinkingConfig,
        GenerateContentConfig=FakeGenerateContentConfig,
    )
    adapter = GeminiAdapter()
    monkeypatch.setattr(gemini_module, "_genai_types", fake_types)
    monkeypatch.setenv("RECON_GEMINI_THINKING_LEVEL", "medium")
    monkeypatch.setenv("RECON_GEMINI_INCLUDE_THOUGHTS", "true")

    config = adapter._build_generate_config()

    assert isinstance(config, FakeGenerateContentConfig)
    assert config["thinking_config"]["thinking_level"] == "medium"
    assert config["thinking_config"]["include_thoughts"] is True


def test_build_generate_config_uses_thinking_budget_when_sdk_exposes_budget_only(
    monkeypatch,
) -> None:
    class FakeThinkingConfig(dict):
        model_fields = {"include_thoughts": object(), "thinking_budget": object()}

        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    class FakeGenerateContentConfig(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    fake_types = SimpleNamespace(
        ThinkingConfig=FakeThinkingConfig,
        GenerateContentConfig=FakeGenerateContentConfig,
    )
    adapter = GeminiAdapter()
    monkeypatch.setattr(gemini_module, "_genai_types", fake_types)
    monkeypatch.setenv("RECON_GEMINI_THINKING_LEVEL", "high")
    monkeypatch.setenv("RECON_GEMINI_INCLUDE_THOUGHTS", "true")

    config = adapter._build_generate_config()

    assert isinstance(config, FakeGenerateContentConfig)
    assert config["thinking_config"]["include_thoughts"] is True
    assert config["thinking_config"]["thinking_budget"] == 24576


def test_resolve_thinking_level_invalid_falls_back_to_default(monkeypatch) -> None:
    adapter = GeminiAdapter()
    monkeypatch.setenv("RECON_GEMINI_THINKING_LEVEL", "invalid-level")
    assert adapter._resolve_thinking_level() == "high"


def test_resolve_include_thoughts_handles_falsey_values(monkeypatch) -> None:
    adapter = GeminiAdapter()
    monkeypatch.setenv("RECON_GEMINI_INCLUDE_THOUGHTS", "off")
    assert adapter._resolve_include_thoughts() is False


def test_extract_steps_heuristic_missing_register_adds_manual_gate() -> None:
    adapter = GeminiAdapter()
    payload = GeminiExtractionInput(
        start_url="https://example.com/register",
        har_entries=[],
        html_content="<html/>",
        extractor_strategy="aggressive",
    )
    steps = adapter._extract_steps_heuristic(payload)
    assert steps[0]["action"] == "navigate"
    assert steps[1]["action"] == "manual_gate"
    assert steps[1]["unsupported_reason"] == "ai.gemini.missing_register_entry"


def test_extract_steps_heuristic_aggressive_adds_extract_step() -> None:
    adapter = GeminiAdapter()
    payload = GeminiExtractionInput(
        start_url="https://example.com/register",
        har_entries=[{"method": "POST", "url": "https://example.com/signup", "status": 201}],
        html_content="<html/>",
        extractor_strategy="aggressive",
    )
    steps = adapter._extract_steps_heuristic(payload)
    assert any(step.get("action") == "extract" for step in steps)


def test_try_parse_json_accepts_fenced_json() -> None:
    adapter = GeminiAdapter()
    parsed = adapter._try_parse_json(
        """
```json
{"steps":[{"action":"click","confidence":0.7,"evidence_ref":"fenced"}]}
```
""".strip()
    )
    assert isinstance(parsed, dict)
    assert parsed["steps"][0]["action"] == "click"


def test_parse_response_steps_supports_list_payload() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(
        parsed=[
            {
                "action": "click",
                "confidence": 0.8,
                "evidence_ref": "list-payload",
            }
        ]
    )
    steps, invalid = adapter._parse_response_steps(response, "https://example.com/register")
    assert invalid is False
    assert steps[0]["action"] == "navigate"
    assert steps[1]["action"] == "click"


def test_normalize_model_step_manual_gate_normalizes_reason_and_confidence() -> None:
    adapter = GeminiAdapter()
    parsed = adapter._normalize_model_step(
        {
            "action": "manual_gate",
            "confidence": 9.2,
            "unsupported_reason": "not-prefixed",
        }
    )
    assert isinstance(parsed, dict)
    assert parsed["confidence"] == 1.0
    assert parsed["unsupported_reason"] == "ai.gemini.model_manual_gate"
    assert parsed["reason_code"] == "ai.gemini.model_manual_gate"


def test_normalize_model_step_invalid_action_returns_marker() -> None:
    adapter = GeminiAdapter()
    parsed = adapter._normalize_model_step(
        {
            "action": "unsupported-action",
            "confidence": 0.3,
        }
    )
    assert parsed == "__invalid_action_schema__"


def test_ensure_navigate_step_when_navigate_exists() -> None:
    adapter = GeminiAdapter()
    steps = [{"action": "click", "confidence": 0.7}, {"action": "navigate", "confidence": 0.9}]
    normalized = adapter._ensure_navigate_step(steps, "https://example.com/register")
    assert normalized == steps


def test_attach_failure_reason_updates_manual_gate_only() -> None:
    adapter = GeminiAdapter()
    steps = [
        {"action": "navigate", "confidence": 0.9},
        {"action": "manual_gate", "confidence": 0.8},
    ]
    normalized = adapter._attach_failure_reason(steps, "ai.gemini.request_failed")
    assert normalized[1]["reason_code"] == "ai.gemini.request_failed"
    assert normalized[1]["manual_handoff_required"] is True


def test_find_register_entry_accepts_signup_path() -> None:
    adapter = GeminiAdapter()
    found = adapter._find_register_entry(
        [
            {"method": "GET", "url": "https://example.com/register"},
            {"request": {"method": "POST", "url": "https://example.com/api/signup"}},
        ]
    )
    assert found is not None


def test_allowed_actions_raises_for_invalid_schema_file(monkeypatch, tmp_path) -> None:
    schema_path = tmp_path / "invalid-action-schema.json"
    schema_path.write_text(json.dumps({"actions": ["click", 1]}), encoding="utf-8")
    monkeypatch.setattr(GeminiAdapter, "_allowed_actions_cache", None)
    monkeypatch.setattr(GeminiAdapter, "_ACTION_SCHEMA_PATH", schema_path)
    with pytest.raises(ValueError, match="invalid action schema"):
        GeminiAdapter._allowed_actions()


def test_parse_strong_response_skips_invalid_function_call_args() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(
        function_calls=[
            SimpleNamespace(name="other_call", args={"steps": []}),
            SimpleNamespace(name="emit_reconstruction_steps", args="{not-json"),
            SimpleNamespace(name="emit_reconstruction_steps", args={"steps": "invalid"}),
        ]
    )
    parsed = adapter._parse_strong_response(response, "https://example.com/register")
    assert parsed["path"] == "none"


def test_extract_steps_main_without_failure_reason_uses_plain_heuristic(monkeypatch) -> None:
    adapter = GeminiAdapter()
    monkeypatch.setattr(adapter, "_try_extract_steps_strong", lambda payload: (None, None))
    monkeypatch.setattr(
        adapter, "_extract_steps_heuristic", lambda payload: [{"action": "navigate"}]
    )

    steps, meta = adapter._extract_steps_main(_payload())

    assert steps == [{"action": "navigate"}]
    assert meta["fallback"]["reason"] == "strong_unavailable"
    assert meta["strong_mode"]["reason"] is None


def test_extract_steps_with_context_cache_handles_expired_item(monkeypatch) -> None:
    adapter = GeminiAdapter()
    adapter._context_cache["expired"] = {
        "steps": [{"action": "navigate"}],
        "meta": {"strategy": "strong"},
        "expires_at": "not-datetime",
    }
    monkeypatch.setattr(adapter, "_extract_steps_main", lambda payload: ([{"action": "click"}], {}))
    result = adapter.extract_steps_with_context_cache(
        _payload(), cache_key="expired", ttl_seconds=5
    )
    assert result["status"] == "api_miss"
    assert result["steps"][0]["action"] == "click"


def test_extract_steps_with_sdk_reuses_existing_client(monkeypatch) -> None:
    class ExistingClient:
        class Models:
            @staticmethod
            def generate_content(*, model: str, contents: list[str], config: object):
                return SimpleNamespace(
                    parsed={
                        "steps": [{"action": "click", "confidence": 0.9, "evidence_ref": "reuse"}]
                    }
                )

        def __init__(self) -> None:
            self.models = ExistingClient.Models()

    adapter = GeminiAdapter()
    adapter._client = ExistingClient()
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setattr(gemini_module, "_genai", SimpleNamespace(Client=lambda **kwargs: None))
    monkeypatch.setattr(gemini_module, "_genai_types", None)

    steps, reason = adapter._extract_steps_with_sdk(_payload())
    assert reason is None
    assert steps is not None
    assert steps[0]["action"] == "navigate"
    assert steps[1]["action"] == "click"


def test_summarize_events_handles_protection_and_empty_paths() -> None:
    adapter = GeminiAdapter()
    summary = adapter._summarize_events(
        [
            {"method": "GET", "url": ""},
            {"method": "POST", "url": "https://example.com/verify/otp", "status": 202},
        ]
    )
    assert "protection-checkpoint" in summary


def test_summarize_har_truncates_and_skips_empty_path() -> None:
    adapter = GeminiAdapter()
    entries: list[dict[str, object]] = [{"method": "GET", "url": ""}]
    entries.extend(
        [
            {"method": "GET", "url": f"https://example.com/path/{idx}", "status": 200}
            for idx in range(26)
        ]
    )
    summary = adapter._summarize_har(entries)
    assert "truncated" in summary


def test_entry_method_path_status_falls_back_to_raw_url() -> None:
    adapter = GeminiAdapter()
    method, path, status = adapter._entry_method_path_status(
        {"request": {"method": "get", "url": "https://example.com"}, "response": {"status": 200}}
    )
    assert method == "GET"
    assert path == "https://example.com"
    assert status == 200


def test_parse_response_steps_returns_empty_when_no_text_payload() -> None:
    adapter = GeminiAdapter()
    steps, invalid = adapter._parse_response_steps(
        SimpleNamespace(text="   "), "https://example.com"
    )
    assert steps == []
    assert invalid is False


def test_parse_response_steps_returns_empty_for_invalid_raw_payload_shape() -> None:
    adapter = GeminiAdapter()
    steps, invalid = adapter._parse_response_steps(
        SimpleNamespace(parsed="invalid"), "https://example.com"
    )
    assert steps == []
    assert invalid is False


def test_parse_response_steps_returns_empty_when_steps_not_dict() -> None:
    adapter = GeminiAdapter()
    response = SimpleNamespace(parsed={"steps": ["not-a-dict"]})
    steps, invalid = adapter._parse_response_steps(response, "https://example.com")
    assert steps == []
    assert invalid is False


def test_extract_text_returns_empty_for_non_string() -> None:
    adapter = GeminiAdapter()
    assert adapter._extract_text(SimpleNamespace(text=123)) == ""


def test_try_parse_json_invalid_returns_none() -> None:
    adapter = GeminiAdapter()
    assert adapter._try_parse_json("{bad-json") is None


def test_normalize_model_step_returns_none_for_invalid_input_shapes() -> None:
    adapter = GeminiAdapter()
    assert adapter._normalize_model_step("not-dict") is None
    assert adapter._normalize_model_step({"action": ""}) is None


def test_ensure_navigate_step_noop_when_navigate_first() -> None:
    adapter = GeminiAdapter()
    steps = [{"action": "navigate", "url": "https://example.com"}]
    assert adapter._ensure_navigate_step(steps, "https://example.com") == steps


def test_normalize_reason_keeps_prefixed_reason() -> None:
    adapter = GeminiAdapter()
    assert adapter._normalize_reason("ai.gemini.custom_reason") == "ai.gemini.custom_reason"


def test_clamp_confidence_handles_non_numeric_input() -> None:
    assert GeminiAdapter._clamp_confidence("not-a-number") == 0.0


def test_find_register_entry_returns_none_for_non_register_post() -> None:
    adapter = GeminiAdapter()
    found = adapter._find_register_entry(
        [
            {"method": "POST", "url": "https://example.com/api/profile"},
            {"method": "GET", "url": "https://example.com/register"},
        ]
    )
    assert found is None
