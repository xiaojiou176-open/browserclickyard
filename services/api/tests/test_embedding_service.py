from __future__ import annotations

import importlib

import pytest

from app.services.embedding_service import EmbeddingService, EmbeddingServiceError

embedding_service_module = importlib.import_module("backend.app.services.embedding_service")


def test_embed_texts_uses_default_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("GEMINI_EMBEDDING_MODEL", raising=False)
    service = EmbeddingService()

    captured: dict[str, object] = {}

    class FakeModels:
        def embed_content(
            self, *, model: str, contents: list[str], config: object | None = None
        ) -> object:
            captured["model"] = model
            captured["contents"] = contents
            captured["config"] = config
            return embedding_service_module.genai_types.EmbedContentResponse(
                embeddings=[
                    embedding_service_module.genai_types.ContentEmbedding(values=[0.1, 0.2, 0.3]),
                    embedding_service_module.genai_types.ContentEmbedding(values=[0.4, 0.5, 0.6]),
                ]
            )

    class FakeClient:
        def __init__(self, *, api_key: str, http_options: object | None = None) -> None:
            captured["api_key"] = api_key
            captured["http_options"] = http_options
            self.models = FakeModels()

    monkeypatch.setattr(embedding_service_module.genai, "Client", FakeClient)

    result = service.embed_texts(["alpha", "beta"])

    assert captured["model"] == "models/gemini-embedding-001"
    assert captured["api_key"] == "test-key"
    assert captured["contents"] == ["alpha", "beta"]
    assert result.model == "gemini-embedding-001"
    assert result.dimension == 3
    assert result.vectors == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]


def test_embed_texts_uses_env_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_EMBEDDING_MODEL", "models/gemini-embedding-001")
    service = EmbeddingService()

    captured: dict[str, object] = {}

    class FakeModels:
        def embed_content(
            self, *, model: str, contents: list[str], config: object | None = None
        ) -> object:
            captured["model"] = model
            captured["contents"] = contents
            return embedding_service_module.genai_types.EmbedContentResponse(
                embeddings=[
                    embedding_service_module.genai_types.ContentEmbedding(values=[0.1, 0.2])
                ]
            )

    class FakeClient:
        def __init__(self, *, api_key: str, http_options: object | None = None) -> None:
            captured["api_key"] = api_key
            self.models = FakeModels()

    monkeypatch.setattr(embedding_service_module.genai, "Client", FakeClient)

    result = service.embed_texts(["hello world"])
    assert captured["model"] == "models/gemini-embedding-001"
    assert captured["contents"] == ["hello world"]
    assert captured["api_key"] == "test-key"
    assert result.model == "gemini-embedding-001"
    assert result.dimension == 2


def test_embed_texts_rejects_non_gemini_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service.embed_texts(["hello"], model="text-embedding-3-small")

    assert exc.value.status_code == 422
    assert "only Gemini embedding models are supported" in str(exc.value)


def test_embed_texts_requires_gemini_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "")
    service = EmbeddingService()

    with pytest.raises(EmbeddingServiceError) as exc:
        service.embed_texts(["hello"])

    assert exc.value.status_code == 503
    assert "gemini api key not configured" in str(exc.value)


def test_embed_texts_maps_sdk_error_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    service = EmbeddingService()

    class FakeModels:
        def embed_content(
            self, *, model: str, contents: list[str], config: object | None = None
        ) -> object:
            raise embedding_service_module.genai_errors.ClientError(
                400,
                {"error": {"message": "bad request"}},
            )

    class FakeClient:
        def __init__(self, *, api_key: str, http_options: object | None = None) -> None:
            self.models = FakeModels()

    monkeypatch.setattr(embedding_service_module.genai, "Client", FakeClient)

    with pytest.raises(EmbeddingServiceError) as exc:
        service.embed_texts(["hello"])

    assert exc.value.status_code == 502
