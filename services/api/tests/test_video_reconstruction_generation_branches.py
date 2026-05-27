from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.engine_adapters.gemini_adapter import GeminiExtractionInput
from app.services.video_reconstruction.generation import (
    build_generated_api,
    build_generated_playwright,
    calculate_quality,
    derive_bootstrap_sequence,
    extract_steps,
    normalize_codegen_steps,
    pick_action_endpoint,
)
from app.services.video_reconstruction.types import ResolvedArtifacts


class _FakeGeminiAdapter:
    def __init__(self) -> None:
        self.captured: GeminiExtractionInput | None = None

    def extract_steps(self, payload: GeminiExtractionInput) -> list[dict[str, Any]]:
        self.captured = payload
        return [{"step_id": "from-adapter"}]


def test_pick_action_endpoint_handles_empty_inputs_and_method_fallback() -> None:
    assert pick_action_endpoint([]) is None

    endpoint = pick_action_endpoint(
        [
            {"method": "GET", "url": "", "status": 200},
            {"url": "https://api.example.com/graphql", "status": 201},
            {"method": "GET", "url": "", "status": 200},
        ]
    )

    assert endpoint is not None
    assert endpoint["method"] == "POST"
    assert endpoint["path"] == "/graphql"
    assert endpoint["fullUrl"] == "https://api.example.com/graphql"


def test_derive_bootstrap_sequence_covers_filters_reasons_and_limit() -> None:
    entries = [
        {"method": "GET", "url": "https://other.example.com/api/csrf"},
        {"method": "POST", "url": "https://example.com/api/register"},
        {"method": "GET", "url": "https://example.com/api/csrf-token"},
        {"method": "GET", "url": "https://example.com/api/challenge"},
        {"method": "POST", "url": "https://example.com/api/profile"},
        {"method": "GET", "url": "https://example.com/api/context"},
        {"method": "GET", "url": "https://example.com/api/extra"},
    ]

    action_endpoint = {
        "method": "POST",
        "fullUrl": "https://example.com/api/register",
        "path": "/api/register",
    }
    sequence = derive_bootstrap_sequence(entries, action_endpoint)
    assert [item["reason"] for item in sequence] == [
        "protection-bootstrap",
        "context-bootstrap",
        "context-bootstrap",
    ]
    assert all(item["method"] == "GET" for item in sequence)
    assert derive_bootstrap_sequence(entries, None) == []
    assert (
        derive_bootstrap_sequence(
            entries, {"method": "POST", "fullUrl": "", "path": "/api/register"}
        )
        == []
    )


def test_extract_steps_delegates_to_adapter_with_structured_input(tmp_path: Path) -> None:
    artifacts = ResolvedArtifacts(
        start_url="https://example.com/register",
        session_dir=tmp_path,
        video_path=None,
        har_path=None,
        html_path=None,
        html_content="<html></html>",
        har_entries=[{"method": "GET", "url": "https://example.com"}],
    )
    adapter = _FakeGeminiAdapter()

    extracted = extract_steps(artifacts=artifacts, strategy="strict", gemini=adapter)  # type: ignore[arg-type]

    assert extracted == [{"step_id": "from-adapter"}]
    assert adapter.captured is not None
    assert adapter.captured.start_url == artifacts.start_url
    assert adapter.captured.har_entries == artifacts.har_entries
    assert adapter.captured.html_content == artifacts.html_content
    assert adapter.captured.extractor_strategy == "strict"


def test_calculate_quality_and_normalize_codegen_steps_branches() -> None:
    assert calculate_quality([]) == 0
    assert calculate_quality([{"confidence": 0.34}, {"confidence": 0.36}]) == 35
    assert normalize_codegen_steps("not-a-list") == []

    normalized = normalize_codegen_steps(
        [
            "skip-me",
            {
                "step_id": "s-empty",
                "action": "click",
                "target": {"selectors": "not-a-list"},
                "preconditions": "not-a-list",
            },
            {
                "step_id": "s-rich",
                "action": "type",
                "target": {
                    "selectors": [
                        {"kind": " css ", "value": " #submit "},
                        {"kind": "", "value": "x"},
                        {"kind": "role", "value": ""},
                        "bad-selector-shape",
                        {"kind": "xpath", "value": "//button[@id='go']"},
                    ]
                },
                "selected_selector_index": 1,
                "preconditions": ["ready", 1],
            },
        ]
    )

    assert len(normalized) == 2
    assert normalized[0]["selectors"] == []
    assert normalized[0]["preconditions"] == []
    assert normalized[1]["selectors"] == [
        {"kind": "css", "value": "#submit"},
        {"kind": "xpath", "value": "//button[@id='go']"},
    ]
    assert normalized[1]["selected_selector_index"] == 1
    assert normalized[1]["preconditions"] == ["ready", "1"]


def test_build_generated_templates_cover_default_action_endpoint() -> None:
    flow = {
        "start_url": "https://example.com/signup",
        "steps": [
            {
                "step_id": "s1",
                "action": "click",
                "target": {"selectors": [{"kind": "css", "value": "#signup"}]},
                "preconditions": [],
            }
        ],
    }
    generated_playwright = build_generated_playwright(flow)
    assert "__START_URL__" not in generated_playwright
    assert "__FLOW_STEPS__" not in generated_playwright
    assert 'const START_URL: string = "https://example.com/signup";' in generated_playwright
    assert "generated reconstruction flow" in generated_playwright

    generated_api = build_generated_api(
        {
            "start_url": "relative-path-only",
            "bootstrap_sequence": {"invalid": "shape"},
        }
    )
    assert 'const BASE_ORIGIN = "https://example.com";' in generated_api
    assert '"/api/register"' in generated_api
    assert "cross-origin replay endpoint is not allowed" in generated_api
