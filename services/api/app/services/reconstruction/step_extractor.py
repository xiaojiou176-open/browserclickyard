from __future__ import annotations

from app.core.settings import env_str

import re
from typing import Any, Protocol
from urllib.parse import urlparse

from app.services.engine_adapters import GeminiAdapter
from app.services.engine_adapters.gemini_adapter import GeminiExtractionInput
from app.services.reconstruction.artifact_resolver import ResolvedArtifacts

_ENSEMBLE_EXPERIMENTAL_ENGINES = frozenset({"lavague", "uitars", "openadapt"})


class StepExtractorEngine(Protocol):
    def extract_steps(self, payload: GeminiExtractionInput) -> list[dict[str, Any]]: ...


def discover_start_url(har_entries: list[dict[str, Any]]) -> str | None:
    for entry in har_entries:
        url = str(entry.get("url") or "")
        if url.startswith("http"):
            return url
    return None


def pick_action_endpoint(har_entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not har_entries:
        return None
    latest_host: str | None = None
    for entry in reversed(har_entries):
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        latest_host = parsed.netloc
        break
    best: dict[str, Any] | None = None
    best_score = float("-inf")
    for entry in har_entries:
        method = str(entry.get("method") or "").upper()
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        path = parsed.path.lower()
        status = int(entry.get("status") or 0)
        score = 0
        if method in {"POST", "PUT", "PATCH", "DELETE"}:
            score += 60
        elif method == "GET":
            score += 5
        if latest_host and parsed.netloc == latest_host:
            score += 8
        if status in {0, 200, 201, 202, 204, 302, 303}:
            score += 10
        if re.search(r"register|signup|sign-up|create|submit|auth|account|user|graphql", path):
            score += 10
        if re.search(r"\.(png|jpg|jpeg|css|js|svg|woff2?)$", path):
            score -= 40
        if score > best_score:
            best_score = score
            best = {
                "method": method or "POST",
                "fullUrl": url,
                "path": parsed.path or "/",
                "contentType": entry.get("content_type"),
            }
    return best


def derive_bootstrap_sequence(
    har_entries: list[dict[str, Any]],
    action_endpoint: dict[str, Any] | None,
) -> list[dict[str, str]]:
    if not action_endpoint:
        return []
    action_url = str(action_endpoint.get("fullUrl") or "")
    action_method = str(action_endpoint.get("method") or "").upper()
    if not action_url:
        return []
    action_path = str(action_endpoint.get("path") or "")
    action_host = urlparse(action_url).netloc
    sequence: list[dict[str, str]] = []
    for entry in har_entries:
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.netloc != action_host:
            continue
        path = parsed.path
        method = str(entry.get("method") or "").upper()
        if path == action_path and method == action_method:
            continue
        reason = "context-bootstrap"
        if re.search(r"csrf|xsrf|token", path, flags=re.IGNORECASE):
            reason = "token-bootstrap"
        elif re.search(r"captcha|challenge|turnstile|verify|otp|mfa", path, flags=re.IGNORECASE):
            reason = "protection-bootstrap"
        elif method == "GET":
            reason = "context-bootstrap"
        else:
            continue
        sequence.append(
            {
                "method": method or "GET",
                "fullUrl": url,
                "path": path or "/",
                "reason": reason,
            }
        )
    return sequence[-3:]


def extract_steps(
    artifacts: ResolvedArtifacts,
    mode: str,
    strategy: str,
    *,
    gemini: GeminiAdapter,
    lavague: StepExtractorEngine,
    ui_tars: StepExtractorEngine,
    openadapt: StepExtractorEngine,
) -> list[dict[str, Any]]:
    main_engine = env_str("RECON_MAIN_ENGINE", "gemini").strip().lower() or "gemini"
    if main_engine != "gemini":
        main_engine = "gemini"
    main_payload = GeminiExtractionInput(
        start_url=artifacts.start_url,
        har_entries=artifacts.har_entries,
        html_content=artifacts.html_content,
        extractor_strategy=strategy,
    )
    main_steps = gemini.extract_steps(main_payload)
    if mode != "ensemble":
        return main_steps

    experimental = _ENSEMBLE_EXPERIMENTAL_ENGINES
    ensemble_sources = [(0.6, main_steps)]
    if "lavague" in experimental:
        ensemble_sources.append(
            (
                0.15,
                lavague.extract_steps(main_payload),
            )
        )
    if "uitars" in experimental or "ui_tars" in experimental:
        ensemble_sources.append(
            (
                0.15,
                ui_tars.extract_steps(main_payload),
            )
        )
    if "openadapt" in experimental:
        ensemble_sources.append(
            (
                0.1,
                openadapt.extract_steps(main_payload),
            )
        )

    merged: list[dict[str, Any]] = []
    max_len = max(len(steps) for _, steps in ensemble_sources)
    for index in range(max_len):
        winner: dict[str, Any] | None = None
        best_score = -1.0
        for weight, candidate_steps in ensemble_sources:
            if index >= len(candidate_steps):
                continue
            candidate = candidate_steps[index]
            confidence = float(candidate.get("confidence", 0.0))
            score = weight * confidence
            if score > best_score:
                winner = candidate
                best_score = score
        if winner is None:
            continue
        merged.append({**winner, "source_engine": str(winner.get("source_engine") or "ensemble")})
    return merged


def normalize_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for idx, step in enumerate(steps, start=1):
        normalized.append(
            {
                "step_id": str(step.get("step_id") or f"s{idx}"),
                "action": str(step.get("action") or "manual_gate"),
                "url": step.get("url"),
                "value_ref": step.get("value_ref"),
                "target": step.get("target") or {"selectors": []},
                "selected_selector_index": step.get("selected_selector_index"),
                "preconditions": step.get("preconditions") or [],
                "evidence_ref": step.get("evidence_ref"),
                "confidence": max(0.0, min(1.0, float(step.get("confidence", 0.0)))),
                "source_engine": str(step.get("source_engine") or "gemini"),
                "manual_handoff_required": bool(step.get("manual_handoff_required", False)),
                "unsupported_reason": step.get("unsupported_reason"),
            }
        )
    return normalized


def calculate_quality(steps: list[dict[str, Any]]) -> int:
    if not steps:
        return 0
    avg = sum(float(step.get("confidence", 0.0)) for step in steps) / len(steps)
    return int(round(avg * 100))
