from __future__ import annotations

import importlib

import pytest

from app.services.embedding_service import EmbeddingService, EmbeddingServiceError

embedding_service_module = importlib.import_module("backend.app.services.embedding_service")


@pytest.mark.parametrize(
    ("texts", "expected_fragment"),
    [
        ([], "texts must include at least one item"),
        (["ok", "   "], "texts[1] must be a non-empty string"),
        (["x"] * 129, "texts batch size exceeds 128"),
    ],
)
def test_normalize_texts_rejects_invalid_input(texts: list[str], expected_fragment: str) -> None:
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service._normalize_texts(texts)

    assert exc.value.status_code == 422
    assert expected_fragment in str(exc.value)


def test_embed_texts_rejects_response_vector_count_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    service = EmbeddingService()
    monkeypatch.setattr(
        service,
        "_embed_batch",
        lambda _model, _texts, _api_key: {"embeddings": [{"values": [0.1, 0.2]}]},
    )

    with pytest.raises(EmbeddingServiceError) as exc:
        service.embed_texts(["alpha", "beta"])

    assert exc.value.status_code == 502
    assert "gemini response vector count mismatch" in str(exc.value)


@pytest.mark.parametrize("payload", [{}, {"embeddings": []}, object()])
def test_parse_vectors_rejects_missing_or_empty_embeddings(payload: object) -> None:
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service._parse_vectors(payload)

    assert exc.value.status_code == 502
    assert "gemini embeddings missing vectors" in str(exc.value)


@pytest.mark.parametrize(
    ("payload", "expected_fragment"),
    [
        (
            {"embeddings": [{"values": []}]},
            "gemini embedding at index 0 is empty",
        ),
        (
            {"embeddings": [{"values": [1.0, 2.0]}, {"embedding": {"values": [3.0]}}]},
            "gemini embeddings returned inconsistent dimensions",
        ),
    ],
)
def test_parse_vectors_rejects_empty_or_inconsistent_dimensions(
    payload: dict[str, object], expected_fragment: str
) -> None:
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service._parse_vectors(payload)

    assert exc.value.status_code == 502
    assert expected_fragment in str(exc.value)


@pytest.mark.parametrize(
    ("item", "expected_fragment"),
    [
        ({"embedding": {}}, "gemini embedding values are missing"),
        ({"values": [1.0, "oops"]}, "gemini embedding values must be numeric"),
        ({"values": [float("nan")]}, "gemini embedding values must be finite"),
        ({"values": [float("inf")]}, "gemini embedding values must be finite"),
    ],
)
def test_extract_values_rejects_invalid_values(
    item: dict[str, object], expected_fragment: str
) -> None:
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service._extract_values(item)

    assert exc.value.status_code == 502
    assert expected_fragment in str(exc.value)


@pytest.mark.parametrize(
    "sdk_error",
    [TypeError("type boom"), OSError("os boom"), ValueError("value boom")],
)
def test_embed_batch_maps_type_os_and_value_errors_to_502(
    monkeypatch: pytest.MonkeyPatch, sdk_error: Exception
) -> None:
    service = EmbeddingService()

    class ExplodingClient:
        def __init__(self, *, api_key: str, http_options: object | None = None) -> None:
            raise sdk_error

    monkeypatch.setattr(embedding_service_module.genai, "Client", ExplodingClient)

    with pytest.raises(EmbeddingServiceError) as exc:
        service._embed_batch("gemini-embedding-001", ["hello"], "test-key")

    assert exc.value.status_code == 502
    assert "gemini embeddings request failed:" in str(exc.value)
    assert str(sdk_error) in str(exc.value)


def test_extract_sdk_error_message_prefers_message_then_fallback_and_unknown() -> None:
    service = EmbeddingService()

    class ErrorWithMessage(Exception):
        def __init__(self) -> None:
            super().__init__("ignored")
            self.message = "  from sdk message  "

        def __str__(self) -> str:
            return "from __str__"

    class ErrorWithFallback(Exception):
        def __init__(self) -> None:
            super().__init__("fallback text")
            self.message = None

    class ErrorWithoutAnyText(Exception):
        def __init__(self) -> None:
            super().__init__(" ")
            self.message = " "

    assert service._extract_sdk_error_message(ErrorWithMessage()) == "from sdk message"
    assert service._extract_sdk_error_message(ErrorWithFallback()) == "fallback text"
    assert service._extract_sdk_error_message(ErrorWithoutAnyText()) == "unknown error"
