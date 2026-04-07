from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.services.engine_adapters.gemini_adapter import GeminiAdapter, GeminiExtractionInput
from app.models.automation import (
    ReconstructionArtifactsRequest,
    ReconstructionPreviewRequest,
)
from app.services.video_reconstruction_service import (
    ResolvedArtifacts,
    VideoReconstructionService,
)


def _new_video_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> VideoReconstructionService:
    runtime_root = tmp_path / "automation"
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(runtime_root))
    return VideoReconstructionService()


def _resolved_artifacts(service: VideoReconstructionService) -> ResolvedArtifacts:
    session_dir = service._runtime_root / "session-cache"
    session_dir.mkdir(parents=True, exist_ok=True)
    video_path = session_dir / "session.mp4"
    video_path.write_bytes(b"video")
    return ResolvedArtifacts(
        start_url="https://example.com",
        session_dir=session_dir,
        video_path=video_path,
        har_path=None,
        html_path=None,
        html_content="<html><body>capture</body></html>",
        har_entries=[
            {
                "method": "POST",
                "url": "https://example.com/api/register",
                "status": 201,
            }
        ],
    )


def test_context_cache_hit_and_ttl_expiry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)

    call_count = {"count": 0}

    def _fake_extract(payload: object) -> list[dict[str, object]]:
        call_count["count"] += 1
        return [
            {
                "step_id": "s1",
                "action": "navigate",
                "url": "https://example.com",
                "confidence": 0.95,
                "source_engine": "gemini",
                "evidence_ref": "video:entry",
            }
        ]

    monkeypatch.setattr(service._gemini, "extract_steps", _fake_extract)

    policy = {"screenshot": "high", "video": "native", "pdf": "medium"}
    first = service._extract_steps(
        artifacts, "gemini", "balanced", media_resolution_by_input=policy
    )
    second = service._extract_steps(
        artifacts, "gemini", "balanced", media_resolution_by_input=policy
    )

    assert call_count["count"] == 1
    assert first == second
    assert service._last_context_cache_event["status"] == "hit"
    assert service._last_context_cache_event["mode"] == "memory"
    assert service._last_context_cache_event["hit"] is True
    assert service._last_context_cache_event["fallback"] is None
    cache_key = str(service._last_context_cache_event["key"])

    with service._context_cache_lock:
        service._context_cache[cache_key].expires_at = datetime.now(UTC) - timedelta(seconds=1)

    service._extract_steps(artifacts, "gemini", "balanced", media_resolution_by_input=policy)
    assert call_count["count"] == 2
    assert service._last_context_cache_event["status"] == "expired_refill"
    assert service._last_context_cache_event["mode"] == "memory"
    assert service._last_context_cache_event["hit"] is False
    assert service._context_cache_stats["expired"] >= 1


def test_context_cache_lru_eviction_respects_max_entries(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_MAX_ENTRIES", "2")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)

    call_count = {"count": 0}

    def _fake_extract(payload: object) -> list[dict[str, object]]:
        call_count["count"] += 1
        return [
            {
                "step_id": "s1",
                "action": "navigate",
                "url": "https://example.com",
                "confidence": 0.95,
                "source_engine": "gemini",
                "evidence_ref": "video:entry",
            }
        ]

    monkeypatch.setattr(service._gemini, "extract_steps", _fake_extract)

    policy = {"video": "native"}
    service._extract_steps(artifacts, "gemini", "balanced", media_resolution_by_input=policy)
    first_key = str(service._last_context_cache_event["key"])
    service._extract_steps(artifacts, "gemini", "strict", media_resolution_by_input=policy)
    second_key = str(service._last_context_cache_event["key"])

    service._extract_steps(artifacts, "gemini", "balanced", media_resolution_by_input=policy)
    assert service._last_context_cache_event["status"] == "hit"

    service._extract_steps(artifacts, "gemini", "fast", media_resolution_by_input=policy)
    third_key = str(service._last_context_cache_event["key"])

    assert first_key in service._context_cache
    assert second_key not in service._context_cache
    assert third_key in service._context_cache
    assert len(service._context_cache) == 2
    assert service._context_cache_stats["evictions"] >= 1

    service._extract_steps(artifacts, "gemini", "strict", media_resolution_by_input=policy)
    assert service._last_context_cache_event["status"] == "miss"
    assert call_count["count"] == 4
    assert len(service._context_cache) == 2


def test_context_cache_max_entries_prevents_unbounded_growth(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_MAX_ENTRIES", "3")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)

    monkeypatch.setattr(
        service._gemini,
        "extract_steps",
        lambda _payload: [
            {
                "step_id": "s1",
                "action": "navigate",
                "url": "https://example.com",
                "confidence": 0.9,
                "source_engine": "gemini",
                "evidence_ref": "video:entry",
            }
        ],
    )

    for index in range(12):
        service._extract_steps(
            artifacts, "gemini", f"strategy-{index}", media_resolution_by_input={"video": "high"}
        )

    assert len(service._context_cache) == 3
    assert service._context_cache_stats["evictions"] >= 9


def test_preview_passes_media_resolution_by_input_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_MEDIA_RESOLUTION_DEFAULT", "medium")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)
    monkeypatch.setattr(service, "_resolve_artifacts", lambda _: artifacts)

    captured: dict[str, object] = {}

    def _capture_extract_steps(
        resolved: ResolvedArtifacts,
        mode: str,
        strategy: str,
        *,
        media_resolution_by_input: dict[str, str] | None = None,
    ) -> list[dict[str, object]]:
        captured["mode"] = mode
        captured["strategy"] = strategy
        captured["policy"] = dict(media_resolution_by_input or {})
        return [
            {
                "step_id": "s1",
                "action": "navigate",
                "url": resolved.start_url,
                "confidence": 0.9,
                "source_engine": "gemini",
                "evidence_ref": "video:entry",
            }
        ]

    monkeypatch.setattr(service, "_extract_steps", _capture_extract_steps)

    payload = ReconstructionPreviewRequest(
        artifacts=ReconstructionArtifactsRequest(
            video_path="session.mp4",
            metadata={
                "media_resolution": {"default": "low", "screenshot": "high", "video": "native"},
                "media_resolution_pdf": "medium",
                "screenshot_before_path": "shots/before.png",
                "document_path": "docs/guide.pdf",
            },
        ),
        video_analysis_mode="gemini",
        extractor_strategy="balanced",
        auto_refine_iterations=1,
    )

    preview = service.preview(payload)
    assert captured["policy"] == {"screenshot": "high", "video": "native", "pdf": "medium"}
    policy = preview.flow_draft["media_resolution_policy"]
    assert policy["by_input_type"] == {"screenshot": "high", "video": "native", "pdf": "medium"}
    assert set(policy["detected_input_types"]) == {"screenshot", "video", "pdf"}
    assert preview.flow_draft["steps"][0]["media_resolution"] == "native"


def test_preview_exposes_context_cache_observability(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)
    monkeypatch.setattr(service, "_resolve_artifacts", lambda _: artifacts)

    call_count = {"count": 0}

    def _fake_extract(payload: object) -> list[dict[str, object]]:
        call_count["count"] += 1
        return [
            {
                "step_id": "s1",
                "action": "navigate",
                "url": "https://example.com",
                "confidence": 0.9,
                "source_engine": "gemini",
                "evidence_ref": "video:entry",
            }
        ]

    monkeypatch.setattr(service._gemini, "extract_steps", _fake_extract)

    payload = ReconstructionPreviewRequest(
        artifacts=ReconstructionArtifactsRequest(
            metadata={"media_resolution": {"video": "high"}},
        ),
        video_analysis_mode="gemini",
        extractor_strategy="strict",
        auto_refine_iterations=1,
    )

    first = service.preview(payload)
    second = service.preview(payload)

    assert call_count["count"] == 1
    assert first.flow_draft["context_cache"]["status"] == "miss"
    assert first.flow_draft["context_cache"]["mode"] == "memory"
    assert first.flow_draft["context_cache"]["hit"] is False
    assert first.flow_draft["context_cache"]["fallback"] is None
    assert second.flow_draft["context_cache"]["status"] == "hit"
    assert second.flow_draft["context_cache"]["mode"] == "memory"
    assert second.flow_draft["context_cache"]["hit"] is True
    assert second.flow_draft["context_cache"]["fallback"] is None
    assert second.flow_draft["context_cache"]["stats"]["hits"] >= 1


def test_context_cache_api_mode_uses_adapter_cache(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_MODE", "api")
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)

    call_count = {"count": 0}

    def _fake_extract(payload: object) -> tuple[list[dict[str, object]], dict[str, object]]:
        call_count["count"] += 1
        return (
            [
                {
                    "step_id": "s1",
                    "action": "navigate",
                    "url": "https://example.com",
                    "confidence": 0.88,
                    "source_engine": "gemini",
                    "evidence_ref": "video:entry",
                }
            ],
            {
                "strategy": "heuristic",
                "fallback": {
                    "from": "strong",
                    "to": "heuristic",
                    "reason": "gemini_api_key_missing",
                },
            },
        )

    monkeypatch.setattr(service._gemini, "_extract_steps_main", _fake_extract)

    policy = {"screenshot": "high", "video": "native", "pdf": "medium"}
    first = service._extract_steps(
        artifacts, "gemini", "balanced", media_resolution_by_input=policy
    )
    first_event = dict(service._last_context_cache_event)
    second = service._extract_steps(
        artifacts, "gemini", "balanced", media_resolution_by_input=policy
    )

    assert first == second
    assert call_count["count"] == 1
    assert first_event["status"] == "api_miss"
    assert first_event["mode"] == "api"
    assert first_event["hit"] is False
    assert service._last_context_cache_event["status"] == "api_hit"
    assert service._last_context_cache_event["mode"] == "api"
    assert service._last_context_cache_event["hit"] is True
    assert service._last_context_cache_event["fallback"] is None


def test_context_cache_api_mode_exposes_fallback_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_MODE", "api")
    monkeypatch.setenv("GEMINI_CONTEXT_CACHE_TTL_SECONDS", "120")
    service = _new_video_service(monkeypatch, tmp_path)
    artifacts = _resolved_artifacts(service)

    def _fake_extract_with_context_cache(*args: object, **kwargs: object) -> dict[str, object]:
        return {
            "steps": [
                {
                    "step_id": "s1",
                    "action": "navigate",
                    "url": "https://example.com",
                    "confidence": 0.88,
                    "source_engine": "gemini",
                    "evidence_ref": "video:entry",
                }
            ],
            "status": "api_miss",
            "hit": False,
            "fallback": {
                "from": "strong",
                "to": "heuristic",
                "reason": "gemini_api_key_missing",
            },
            "reason": "gemini_api_key_missing",
        }

    monkeypatch.setattr(
        service._gemini, "extract_steps_with_context_cache", _fake_extract_with_context_cache
    )

    policy = {"screenshot": "high", "video": "native", "pdf": "medium"}
    service._extract_steps(artifacts, "gemini", "balanced", media_resolution_by_input=policy)
    event = service._last_context_cache_event
    assert event["status"] == "api_miss"
    assert event["mode"] == "api"
    assert event["hit"] is False
    assert event["fallback"] == {
        "from": "strong",
        "to": "heuristic",
        "reason": "gemini_api_key_missing",
    }


def test_gemini_adapter_prefers_strong_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = GeminiAdapter()
    payload = GeminiExtractionInput(
        start_url="https://example.com",
        har_entries=[],
        html_content="<html/>",
        extractor_strategy="balanced",
    )

    monkeypatch.setattr(
        adapter,
        "_try_extract_steps_strong",
        lambda _: (
            [
                {
                    "action": "navigate",
                    "url": "https://example.com",
                    "confidence": 0.99,
                    "source_engine": "gemini",
                    "evidence_ref": "strong:llm",
                },
                {
                    "action": "click",
                    "confidence": 0.9,
                    "source_engine": "gemini",
                    "evidence_ref": "strong:llm:submit",
                },
            ],
            None,
        ),
    )
    monkeypatch.setattr(
        adapter, "_extract_steps_heuristic", lambda _: pytest.fail("heuristic should not be used")
    )

    steps = adapter.extract_steps(payload)
    assert steps[0]["evidence_ref"] == "strong:llm"


def test_gemini_adapter_strong_response_prefers_function_call_args() -> None:
    adapter = GeminiAdapter()

    class _FunctionCall:
        def __init__(self, name: str, args: dict[str, object]) -> None:
            self.name = name
            self.args = args

    class _Response:
        def __init__(self) -> None:
            self.function_calls = [
                _FunctionCall(
                    "emit_reconstruction_steps",
                    {
                        "steps": [
                            {
                                "action": "click",
                                "confidence": 0.91,
                                "evidence_ref": "strong:function:submit",
                            }
                        ]
                    },
                )
            ]
            self.text = (
                '{"steps":[{"action":"assert","confidence":0.12,'
                '"evidence_ref":"strong:text:fallback"}]}'
            )

    parsed = adapter._parse_strong_response(_Response(), "https://example.com")
    assert parsed["path"] == "function_call"
    assert parsed["parser"] == "function_args"
    assert parsed["steps"][0]["action"] == "navigate"
    assert parsed["steps"][1]["evidence_ref"] == "strong:function:submit"


def test_gemini_adapter_strong_response_falls_back_to_text_json() -> None:
    adapter = GeminiAdapter()

    class _FunctionCall:
        def __init__(self, name: str, args: str) -> None:
            self.name = name
            self.args = args

    class _Response:
        def __init__(self) -> None:
            self.function_calls = [_FunctionCall("other_function", '{"steps": []}')]
            self.text = (
                '{"steps":[{"action":"click","confidence":0.88,'
                '"evidence_ref":"strong:text:submit"}]}'
            )

    parsed = adapter._parse_strong_response(_Response(), "https://example.com")
    assert parsed["path"] == "text_json_fallback"
    assert parsed["parser"] == "response_text"
    assert parsed["steps"][1]["evidence_ref"] == "strong:text:submit"


def test_gemini_adapter_falls_back_to_heuristic_when_strong_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = GeminiAdapter()
    payload = GeminiExtractionInput(
        start_url="https://example.com",
        har_entries=[
            {
                "method": "POST",
                "url": "https://example.com/api/register",
                "status": 201,
            }
        ],
        html_content="<html/>",
        extractor_strategy="balanced",
    )

    monkeypatch.setattr(
        adapter, "_try_extract_steps_strong", lambda _: (None, "gemini_api_key_missing")
    )

    response = adapter.extract_steps_with_context_cache(
        payload,
        cache_key="cache-key",
        ttl_seconds=30,
        media_resolution_by_input={"video": "high"},
    )
    assert response["status"] == "api_miss"
    assert response["hit"] is False
    assert response["fallback"] == {
        "from": "strong",
        "to": "heuristic",
        "reason": "gemini_api_key_missing",
    }
    assert response["meta"]["strategy"] == "heuristic"
    assert response["meta"]["strong_mode"]["path"] == "none"
    assert response["meta"]["strong_mode"]["outcome"] == "fallback"
    assert isinstance(response["steps"], list)
    assert response["steps"][0]["action"] == "navigate"
