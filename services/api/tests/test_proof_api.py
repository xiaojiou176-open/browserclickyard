from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.main import app
from app.services.embedding_service import EmbeddingBatchResult, embedding_service
from app.services.proof_service import proof_service
from app.services.universal_platform_service import universal_platform_service

TEST_AUTOMATION_TOKEN = "test-token-0123456789"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-proof",
    },
)


@pytest.fixture(autouse=True)
def reset_proof_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    access_control.reset_for_tests()
    runtime_root = Path(os.environ.get("RUNTIME_ROOT", "")).resolve()
    proof_root = runtime_root / "artifacts" / "proof-campaigns"
    runs_root = runtime_root / "artifacts" / "runs"
    universal_runtime = Path(os.environ.get("UNIVERSAL_AUTOMATION_RUNTIME_DIR", "")).resolve()
    ledger_path = universal_runtime / "universal" / "proof-campaigns.json"
    if proof_root.exists():
        shutil.rmtree(proof_root)
    if runs_root.exists():
        shutil.rmtree(runs_root)
    if ledger_path.exists():
        ledger_path.unlink()


def _write_run_manifest(
    run_id: str,
    *,
    gate_status: str = "passed",
    checks: list[dict[str, object]] | None = None,
    summary: dict[str, object] | None = None,
    reports: dict[str, str] | None = None,
) -> Path:
    runtime_root = Path(os.environ.get("RUNTIME_ROOT", "")).resolve()
    run_root = runtime_root / "artifacts" / "runs" / run_id
    (run_root / "reports").mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": "1.1",
        "runId": run_id,
        "target": {"type": "web", "name": "web.local"},
        "profile": "pr",
        "git": {"branch": "main", "commit": "deadbeef", "dirty": False},
        "timing": {
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "durationMs": 1000,
        },
        "execution": {"maxParallelTasks": 1, "stagesMs": {}, "criticalPath": []},
        "states": [],
        "evidenceIndex": [],
        "reports": reports or {"report": "reports/summary.json"},
        "summary": {
            "consoleError": 0,
            "pageError": 0,
            "http5xx": 0,
            **(summary or {}),
        },
        "gateResults": {
            "status": gate_status,
            "checks": checks or [],
        },
    }
    (run_root / "manifest.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (run_root / "reports" / "summary.json").write_text(
        json.dumps({"status": gate_status, "checks": checks or []}, indent=2),
        encoding="utf-8",
    )
    return run_root


def test_proof_campaign_create_and_list() -> None:
    _write_run_manifest("run-a")
    _write_run_manifest(
        "run-b",
        gate_status="failed",
        checks=[
            {
                "id": "perf.lcp_ms_max",
                "status": "failed",
                "reasonCode": "gate.perf_lcp_ms_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"perfLcpMs": 4200},
    )

    created = client.post(
        "/api/proof/campaigns",
        json={"model": "models/gemini-3.1-pro-preview", "run_ids": ["run-a", "run-b"]},
    )
    assert created.status_code == 200
    created_payload = created.json()
    assert created_payload["campaign"]["campaign_id"].startswith("pc_")
    assert created_payload["campaign"]["model"] == "models/gemini-3.1-pro-preview"
    assert created_payload["campaign"]["run_ids"] == ["run-a", "run-b"]

    listed = client.get("/api/proof/campaigns")
    assert listed.status_code == 200
    assert listed.json()["campaigns"][0]["campaign_id"] == created_payload["campaign"]["campaign_id"]


def test_proof_run_compare_and_ai_review_projection(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get_run(run_id: str, requester: str | None = None):
        _ = requester
        return {"run_id": run_id}

    monkeypatch.setattr(universal_platform_service, "get_run", fake_get_run)
    _write_run_manifest(
        "run-left",
        checks=[
            {
                "id": "a11y.serious_max",
                "status": "failed",
                "reasonCode": "gate.a11y_serious_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"a11ySerious": 3, "perfLcpMs": 3200},
    )
    run_right = _write_run_manifest(
        "run-right",
        gate_status="failed",
        checks=[
            {
                "id": "perf.lcp_ms_max",
                "status": "failed",
                "reasonCode": "gate.perf_lcp_ms_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"a11ySerious": 1, "perfLcpMs": 4500},
        reports={"report": "reports/summary.json", "aiReview": "reports/ai-review.json"},
    )
    (run_right / "reports" / "ai-review.json").write_text(
        json.dumps(
            {
                "summary": {"totalFindings": 2, "highOrAbove": 1},
                "generation": {"model": "models/gemini-3.1-pro-preview"},
                "findings": [{"id": "finding-1"}, {"id": "finding-2"}],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    compare = client.post(
        "/api/proof/runs/compare",
        json={"left_run_id": "run-left", "right_run_id": "run-right"},
    )
    assert compare.status_code == 200
    compare_payload = compare.json()
    assert compare_payload["left_run_id"] == "run-left"
    assert compare_payload["right_run_id"] == "run-right"
    assert "perf.lcp_ms_max" in compare_payload["checks"]["added_failed_or_blocked"]
    assert "a11y.serious_max" in compare_payload["checks"]["removed_failed_or_blocked"]

    ai_review = client.get("/api/proof/runs/run-right/ai-review")
    assert ai_review.status_code == 200
    ai_payload = ai_review.json()
    assert ai_payload["enabled"] is True
    assert ai_payload["report_path"] == "reports/ai-review.json"
    assert len(ai_payload["findings"]) == 2

    release_brief = client.get("/api/proof/runs/run-right/release-brief?baseline_run_id=run-left")
    assert release_brief.status_code == 200
    brief_payload = release_brief.json()
    assert brief_payload["run_id"] == "run-right"
    assert brief_payload["baseline_run_id"] == "run-left"
    assert brief_payload["recommendation"] in {"blocked", "investigate", "review-ready", "insufficient-evidence"}
    assert "failed_check_count" in brief_payload["observed"]
    assert "findings_total" in brief_payload["ai_interpretation"]


def test_similar_failures_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get_run(run_id: str, requester: str | None = None):
        _ = requester
        return {"run_id": run_id, "status": "failed"}

    monkeypatch.setattr(universal_platform_service, "get_run", fake_get_run)
    monkeypatch.setattr(
        universal_platform_service,
        "list_runs",
        lambda limit=100, requester=None: [
            type("RunRecordLike", (), {"run_id": "run-origin", "status": "failed"})(),
            type("RunRecordLike", (), {"run_id": "run-near", "status": "failed"})(),
            type("RunRecordLike", (), {"run_id": "run-far", "status": "failed"})(),
        ],
    )
    _write_run_manifest(
        "run-origin",
        gate_status="failed",
        checks=[
            {
                "id": "perf.lcp_ms_max",
                "status": "failed",
                "reasonCode": "gate.perf_lcp_ms_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"perfLcpMs": 4100, "loadFailedRequests": 2},
    )
    _write_run_manifest(
        "run-near",
        gate_status="failed",
        checks=[
            {
                "id": "perf.lcp_ms_max",
                "status": "failed",
                "reasonCode": "gate.perf_lcp_ms_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"perfLcpMs": 4300, "loadFailedRequests": 1},
    )
    _write_run_manifest(
        "run-far",
        gate_status="failed",
        checks=[
            {
                "id": "a11y.serious_max",
                "status": "failed",
                "reasonCode": "gate.a11y_serious_max.failed.threshold_exceeded",
                "evidencePath": "reports/summary.json",
            }
        ],
        summary={"a11ySerious": 8},
    )

    monkeypatch.setattr(
        embedding_service,
        "embed_texts",
        lambda texts, model=None: EmbeddingBatchResult(
            model=model or "gemini-embedding-001",
            dimension=3,
            vectors=[
                [1.0, 0.0, 0.0],
                [0.99, 0.01, 0.0],
                [0.10, 0.90, 0.0],
            ][: len(texts)],
        ),
    )

    response = client.get("/api/proof/runs/run-origin/similar-failures?limit=2")
    assert response.status_code == 200
    payload = response.json()
    assert payload["run_id"] == "run-origin"
    assert payload["matches"][0]["run_id"] == "run-near"
    assert payload["matches"][0]["score"] > payload["matches"][1]["score"]


def test_template_target_feasibility_endpoint() -> None:
    session_id = client.post(
        "/api/sessions/start", json={"start_url": "https://example.com", "mode": "manual"}
    ).json()["session_id"]
    flow_id = client.post(
        "/api/flows",
        json={
            "session_id": session_id,
            "start_url": "https://example.com",
            "steps": [{"step_id": "s1", "action": "navigate", "url": "https://example.com"}],
        },
    ).json()["flow_id"]
    template_id = client.post(
        "/api/templates",
        json={
            "flow_id": flow_id,
            "name": "feasibility-template",
            "params_schema": [],
            "defaults": {},
            "policies": {},
        },
    ).json()["template_id"]

    response = client.get(f"/api/proof/templates/{template_id}/feasibility?target=swift.macos")
    assert response.status_code == 200
    payload = response.json()
    assert payload["template_id"] == template_id
    assert payload["target"] == "swift.macos"
    assert payload["supported"] is False
    assert any("navigate" in reason for reason in payload["blocked_reasons"])


def test_proof_run_routes_forward_verified_actor(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str | None] = {}

    def fake_compare_runs(*, left_run_id: str, right_run_id: str, requester: str | None = None):
        captured["compare"] = requester
        return {
            "left_run_id": left_run_id,
            "right_run_id": right_run_id,
            "metrics_delta": {"values": {}},
            "checks": {
                "added_failed_or_blocked": [],
                "removed_failed_or_blocked": [],
                "persisted_failed_or_blocked": [],
            },
            "summary": {},
        }

    def fake_read_run_ai_review(*, run_id: str, requester: str | None = None):
        captured["ai"] = requester
        return {
            "run_id": run_id,
            "enabled": False,
            "report_path": None,
            "markdown_path": None,
            "findings": [],
            "summary": {},
            "generation": {},
        }

    monkeypatch.setattr(proof_service, "compare_runs", fake_compare_runs)
    monkeypatch.setattr(proof_service, "read_run_ai_review", fake_read_run_ai_review)

    compare = client.post(
        "/api/proof/runs/compare",
        json={"left_run_id": "run-left", "right_run_id": "run-right"},
    )
    assert compare.status_code == 200
    ai_review = client.get("/api/proof/runs/run-right/ai-review")
    assert ai_review.status_code == 200
    assert isinstance(captured["compare"], str) and captured["compare"].startswith("token:")
    assert isinstance(captured["ai"], str) and captured["ai"].startswith("token:")
