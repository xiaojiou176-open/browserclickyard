from __future__ import annotations

from app.services.video_reconstruction.generation import (
    build_generated_api,
    normalize_codegen_steps,
    normalize_steps,
    pick_action_endpoint,
)


def test_pick_action_endpoint_tolerates_non_numeric_status() -> None:
    endpoint = pick_action_endpoint(
        [
            {"method": "GET", "url": "https://example.com/assets/app.js", "status": "ok"},
            {"method": "POST", "url": "https://example.com/api/register", "status": "not-a-number"},
        ]
    )

    assert endpoint is not None
    assert endpoint["method"] == "POST"
    assert endpoint["path"] == "/api/register"


def test_normalize_steps_clamps_and_defaults_confidence() -> None:
    normalized = normalize_steps(
        [
            {"step_id": "a", "action": "click", "confidence": "oops"},
            {"step_id": "b", "action": "input", "confidence": 1.7},
            {"step_id": "c", "action": "navigate", "confidence": -0.3},
        ]
    )

    assert [step["confidence"] for step in normalized] == [0.0, 1.0, 0.0]


def test_normalize_codegen_steps_discards_out_of_range_selected_selector_index() -> None:
    normalized = normalize_codegen_steps(
        [
            {
                "step_id": "s1",
                "action": "click",
                "selected_selector_index": 9,
                "target": {"selectors": [{"kind": "css", "value": "#submit"}]},
            }
        ]
    )

    assert len(normalized) == 1
    assert normalized[0]["selected_selector_index"] is None


def test_build_generated_api_includes_cross_origin_guard() -> None:
    generated = build_generated_api(
        {
            "start_url": "https://example.com/register",
            "steps": [],
            "action_endpoint": {
                "method": "POST",
                "fullUrl": "https://evil.example.net/api/register",
                "path": "/api/register",
                "contentType": "application/json",
            },
        }
    )

    assert "cross-origin replay endpoint is not allowed" in generated
