from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from app.core.settings import env_str


_DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001"
_MAX_BATCH_SIZE = 128
_DEFAULT_TIMEOUT_SECONDS = 30
_SUPPORTED_EMBEDDING_MODELS = frozenset({"gemini-embedding-001"})


class EmbeddingServiceError(RuntimeError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class EmbeddingBatchResult:
    model: str
    dimension: int
    vectors: list[list[float]]


class EmbeddingService:
    def embed_texts(self, texts: list[str], model: str | None = None) -> EmbeddingBatchResult:
        normalized_texts = self._normalize_texts(texts)
        api_key = env_str("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise EmbeddingServiceError("gemini api key not configured", status_code=503)

        resolved_model = self._resolve_model(model)
        raw_response = self._embed_batch(resolved_model, normalized_texts, api_key)
        vectors = self._parse_vectors(raw_response)
        if len(vectors) != len(normalized_texts):
            raise EmbeddingServiceError("gemini response vector count mismatch", status_code=502)
        dimension = len(vectors[0]) if vectors else 0
        return EmbeddingBatchResult(model=resolved_model, dimension=dimension, vectors=vectors)

    def _normalize_texts(self, texts: list[str]) -> list[str]:
        if not texts:
            raise EmbeddingServiceError("texts must include at least one item", status_code=422)
        if len(texts) > _MAX_BATCH_SIZE:
            raise EmbeddingServiceError(
                f"texts batch size exceeds {_MAX_BATCH_SIZE}", status_code=422
            )

        normalized: list[str] = []
        for index, raw_text in enumerate(texts):
            text = str(raw_text).strip()
            if not text:
                raise EmbeddingServiceError(
                    f"texts[{index}] must be a non-empty string", status_code=422
                )
            normalized.append(text)
        return normalized

    def _resolve_model(self, model: str | None) -> str:
        configured = model if model is not None else env_str("GEMINI_EMBEDDING_MODEL", "")
        candidate = configured.strip() if configured else ""
        if candidate.startswith("models/"):
            candidate = candidate.removeprefix("models/")
        resolved = candidate or _DEFAULT_GEMINI_EMBEDDING_MODEL
        if resolved not in _SUPPORTED_EMBEDDING_MODELS:
            raise EmbeddingServiceError(
                "only Gemini embedding models are supported", status_code=422
            )
        return resolved

    def _embed_batch(self, model: str, texts: list[str], api_key: str) -> Any:
        timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
        try:
            client = genai.Client(
                api_key=api_key,
                http_options=genai_types.HttpOptions(timeout=timeout_seconds * 1000),
            )
            return client.models.embed_content(model=f"models/{model}", contents=texts)
        except genai_errors.APIError as exc:
            detail = self._extract_sdk_error_message(exc)
            upstream_status = getattr(exc, "status", "unknown")
            raise EmbeddingServiceError(
                f"gemini embeddings request failed with status {upstream_status}: {detail}",
                status_code=502,
            )
        except (ValueError, OSError, TypeError) as exc:
            raise EmbeddingServiceError(
                f"gemini embeddings request failed: {exc}", status_code=502
            ) from exc

    def _parse_vectors(self, payload: Any) -> list[list[float]]:
        embeddings: Any
        if isinstance(payload, dict):
            embeddings = payload.get("embeddings")
        else:
            embeddings = getattr(payload, "embeddings", None)
        if not isinstance(embeddings, list) or not embeddings:
            raise EmbeddingServiceError("gemini embeddings missing vectors", status_code=502)

        vectors: list[list[float]] = []
        expected_dimension: int | None = None
        for idx, item in enumerate(embeddings):
            values = self._extract_values(item)
            if not values:
                raise EmbeddingServiceError(
                    f"gemini embedding at index {idx} is empty", status_code=502
                )
            if expected_dimension is None:
                expected_dimension = len(values)
            elif len(values) != expected_dimension:
                raise EmbeddingServiceError(
                    "gemini embeddings returned inconsistent dimensions", status_code=502
                )
            vectors.append(values)
        return vectors

    def _extract_values(self, item: Any) -> list[float]:
        raw_values: Any = (
            item.get("values") if isinstance(item, dict) else getattr(item, "values", None)
        )
        if not isinstance(raw_values, list):
            nested = (
                item.get("embedding")
                if isinstance(item, dict)
                else getattr(item, "embedding", None)
            )
            raw_values = (
                nested.get("values")
                if isinstance(nested, dict)
                else getattr(nested, "values", None)
            )
        if not isinstance(raw_values, list):
            raise EmbeddingServiceError("gemini embedding values are missing", status_code=502)

        values: list[float] = []
        for raw in raw_values:
            try:
                value = float(raw)
            except (TypeError, ValueError) as exc:
                raise EmbeddingServiceError(
                    "gemini embedding values must be numeric", status_code=502
                ) from exc
            if not isfinite(value):
                raise EmbeddingServiceError(
                    "gemini embedding values must be finite", status_code=502
                )
            values.append(value)
        return values

    def _extract_sdk_error_message(self, error: Exception) -> str:
        message = getattr(error, "message", None)
        if isinstance(message, str) and message.strip():
            return message.strip()
        fallback = str(error).strip()
        return fallback or "unknown error"


embedding_service = EmbeddingService()

__all__ = [
    "EmbeddingBatchResult",
    "EmbeddingService",
    "EmbeddingServiceError",
    "embedding_service",
]
