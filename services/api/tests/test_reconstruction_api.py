from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import app.core.access_control as access_control
from app.main import app

TEST_AUTOMATION_TOKEN = "test-token-0123456789"

client = TestClient(
    app,
    headers={
        "x-automation-token": TEST_AUTOMATION_TOKEN,
        "x-automation-client-id": "pytest-reconstruction",
    },
)


def _runtime_root() -> Path:
    root = Path(__file__).resolve().parents[3]
    runtime_override = os.environ.get("UNIVERSAL_AUTOMATION_RUNTIME_DIR", "").strip()
    base = Path(runtime_override) if runtime_override else (root / ".runtime-cache" / "automation")
    return base.resolve()


@pytest.fixture(autouse=True)
def reset_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTOMATION_API_TOKEN", TEST_AUTOMATION_TOKEN)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("RECON_GEMINI_API_KEY", raising=False)
    access_control.reset_for_tests()
    runtime_root = _runtime_root()
    universal_dir = runtime_root / "universal"
    recon_dir = runtime_root / "reconstruction"
    if universal_dir.exists():
        shutil.rmtree(universal_dir)
    if recon_dir.exists():
        shutil.rmtree(recon_dir)
    latest_pointer = runtime_root / "latest-session.json"
    if latest_pointer.exists():
        latest_pointer.unlink()


def _prepare_session_artifacts(name: str, *, with_protection: bool = False) -> Path:
    root = Path(__file__).resolve().parents[3]
    worker_id = os.environ.get("PYTEST_XDIST_WORKER", "main")
    session_dir = root / ".runtime-cache" / "automation" / f"{name}-{worker_id}-{uuid4().hex[:8]}"
    session_dir.mkdir(parents=True, exist_ok=True)
    har_payload = {
        "log": {
            "entries": [
                {
                    "request": {
                        "method": "POST",
                        "url": "https://example.com/api/register",
                    }
                }
            ]
        }
    }
    (session_dir / "register.har").write_text(
        json.dumps(har_payload, ensure_ascii=False), encoding="utf-8"
    )
    html = "<html><body><h1>Register</h1></body></html>"
    if with_protection:
        html = "<html><body>cloudflare captcha otp challenge</body></html>"
    (session_dir / "page.html").write_text(html, encoding="utf-8")
    return session_dir


def _assert_artifact_validation_error(detail: object) -> None:
    assert isinstance(detail, str)
    assert detail.strip() != ""


def test_reconstruction_preview_rejects_session_dir_escape(tmp_path: Path) -> None:
    escaped_session_dir = tmp_path / "escaped-session"
    escaped_session_dir.mkdir(parents=True, exist_ok=True)
    (escaped_session_dir / "register.har").write_text('{"log":{"entries":[]}}', encoding="utf-8")
    (escaped_session_dir / "page.html").write_text("<html/>", encoding="utf-8")

    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {"session_dir": str(escaped_session_dir)},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 1,
        },
    )
    assert response.status_code == 400
    assert "runtime root" in response.json()["detail"]


def test_reconstruction_preview_rejects_latest_session_pointer_escape(tmp_path: Path) -> None:
    runtime_root = _runtime_root()
    runtime_root.mkdir(parents=True, exist_ok=True)
    escaped_session_dir = tmp_path / "escaped-latest-session"
    escaped_session_dir.mkdir(parents=True, exist_ok=True)
    (runtime_root / "latest-session.json").write_text(
        json.dumps(
            {"sessionId": "ss_escape", "sessionDir": str(escaped_session_dir)},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 1,
        },
    )
    assert response.status_code == 400
    assert "runtime root" in response.json()["detail"]


def test_reconstruction_preview_rejects_artifact_path_escape(tmp_path: Path) -> None:
    session_dir = _prepare_session_artifacts("pytest-recon-artifact-escape")
    escaped_har = tmp_path / "escaped.har"
    escaped_har.write_text('{"log":{"entries":[]}}', encoding="utf-8")

    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {
                "session_dir": str(session_dir),
                "har_path": str(escaped_har),
            },
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 1,
        },
    )
    assert response.status_code in {400, 422}
    if response.status_code == 400:
        assert "runtime root" in response.json()["detail"]
    else:
        detail = response.json()["detail"]
        assert isinstance(detail, list)
        assert any("har_path" in str(item.get("loc")) for item in detail if isinstance(item, dict))


def test_reconstruction_preview_rejects_null_byte_artifact_path() -> None:
    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {
                "html_path": "bad\u0000path.html",
            },
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 1,
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert any("html_path" in str(item.get("loc")) for item in detail if isinstance(item, dict))


def test_reconstruction_preview_rejects_oversized_har(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECONSTRUCTION_ARTIFACT_MAX_BYTES", "16")
    session_dir = _prepare_session_artifacts("pytest-recon-oversize")
    oversized_har = session_dir / "oversized.har"
    oversized_har.write_text(
        '{"log":{"entries":[{"request":{"url":"https://example.com"}}]}}', encoding="utf-8"
    )

    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {
                "session_dir": str(session_dir),
                "har_path": str(oversized_har),
            },
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 1,
        },
    )
    assert response.status_code in {400, 422}


def test_reconstruction_preview_and_generate() -> None:
    session_dir = _prepare_session_artifacts("pytest-recon-preview")

    preview_resp = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {"session_dir": str(session_dir)},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 3,
        },
    )
    assert preview_resp.status_code in {200, 400}
    if preview_resp.status_code == 400:
        _assert_artifact_validation_error(preview_resp.json().get("detail"))
        return
    preview = preview_resp.json()
    assert preview["preview_id"].startswith("prv_")
    assert preview["flow_draft"]["start_url"] == "https://example.com/api/register"
    assert len(preview["flow_draft"]["steps"]) >= 2

    generate_resp = client.post(
        "/api/reconstruction/generate",
        json={
            "preview_id": preview["preview_id"],
            "template_name": "recon-template",
            "create_run": False,
            "run_params": {},
        },
    )
    assert generate_resp.status_code == 200
    generated = generate_resp.json()
    assert generated["flow_id"].startswith("fl_")
    assert generated["template_id"].startswith("tp_")
    assert generated["run_id"] is None
    assert Path(generated["generator_outputs"]["flow_draft"]).exists()
    assert Path(generated["generator_outputs"]["playwright_spec"]).exists()
    assert Path(generated["generator_outputs"]["api_spec"]).exists()
    playwright_content = Path(generated["generator_outputs"]["playwright_spec"]).read_text(
        encoding="utf-8"
    )
    api_content = Path(generated["generator_outputs"]["api_spec"]).read_text(encoding="utf-8")
    readiness_content = json.loads(
        Path(generated["generator_outputs"]["readiness_report"]).read_text(encoding="utf-8")
    )
    assert "const FLOW_STEPS" in playwright_content
    assert "await executeStep(page, step)" in playwright_content
    assert '"action": "type"' in playwright_content
    assert "const ACTION_ENDPOINT" in api_content
    assert "generated reconstruction api replay" in api_content
    assert readiness_content["api_replay_ready"] is True
    assert isinstance(readiness_content["manual_gate_reasons"], list)
    assert readiness_content["required_bootstrap_steps"] >= 0


def test_orchestrate_from_artifacts_forces_manual_gate_on_protection_signals() -> None:
    session_dir = _prepare_session_artifacts("pytest-recon-manual-gate", with_protection=True)

    response = client.post(
        "/api/command-tower/orchestrate-from-artifacts",
        json={
            "artifacts": {"session_dir": str(session_dir)},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "strict",
            "auto_refine_iterations": 2,
            "template_name": "manual-gate-template",
            "create_run": False,
            "run_params": {},
        },
    )
    assert response.status_code in {200, 400}
    if response.status_code == 400:
        _assert_artifact_validation_error(response.json().get("detail"))
        return
    payload = response.json()
    assert payload["template_id"].startswith("tp_")
    assert payload["manual_handoff_required"] is True
    assert payload["unsupported_reason"]
    assert "manual_gate" in payload["unresolved_segments"]
    readiness_content = json.loads(
        Path(payload["generator_outputs"]["readiness_report"]).read_text(encoding="utf-8")
    )
    assert isinstance(readiness_content["manual_gate_reasons"], list)
    assert len(readiness_content["manual_gate_reasons"]) >= 1
    assert readiness_content["manual_gate_stats_panel"]["known_reason_code_hits"] >= 3


def test_orchestrate_from_artifacts_autofills_required_run_params() -> None:
    session_dir = _prepare_session_artifacts("pytest-recon-autofill-run-params")

    response = client.post(
        "/api/command-tower/orchestrate-from-artifacts",
        json={
            "artifacts": {"session_dir": str(session_dir)},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
            "auto_refine_iterations": 2,
            "template_name": "autofill-run-template",
            "create_run": True,
            "run_params": {},
        },
    )
    assert response.status_code in {200, 400}
    if response.status_code == 400:
        _assert_artifact_validation_error(response.json().get("detail"))
        return
    payload = response.json()
    assert payload["template_id"].startswith("tp_")
    assert payload["run_id"].startswith("rn_")


@pytest.mark.parametrize(
    "path",
    ["/api/command-tower/orchestrate-from-artifacts", "/api/templates/from-artifacts"],
)
def test_orchestrate_endpoints_reject_null_byte_artifact_path(path: str) -> None:
    response = client.post(
        path,
        json={
            "artifacts": {
                "har_path": "bad\u0000path.har",
            },
            "video_analysis_mode": "gemini",
            "extractor_strategy": "strict",
            "auto_refine_iterations": 2,
            "template_name": "manual-gate-template",
            "create_run": False,
            "run_params": {},
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert any("har_path" in str(item.get("loc")) for item in detail if isinstance(item, dict))


def test_profile_resolve_has_alignment_scores() -> None:
    session_dir = _prepare_session_artifacts("pytest-profile-resolve")

    response = client.post(
        "/api/profiles/resolve",
        json={
            "artifacts": {"session_dir": str(session_dir)},
            "extractor_strategy": "balanced",
        },
    )
    assert response.status_code in {200, 400}
    if response.status_code == 400:
        _assert_artifact_validation_error(response.json().get("detail"))
        return
    payload = response.json()
    assert payload["profile"] in {"api-centric", "ui-centric"}
    assert payload["dom_alignment_score"] >= 0
    assert payload["har_alignment_score"] >= 0


def test_generate_rejects_invalid_preview_id() -> None:
    response = client.post(
        "/api/reconstruction/generate",
        json={
            "preview_id": "../evil",
            "template_name": "bad",
            "create_run": False,
            "run_params": {},
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert any("preview_id" in str(item.get("loc")) for item in detail if isinstance(item, dict))


def test_preview_rejects_artifacts_outside_runtime_root(tmp_path: Path) -> None:
    outside = tmp_path / "outside-recon"
    outside.mkdir(parents=True, exist_ok=True)
    response = client.post(
        "/api/reconstruction/preview",
        json={
            "artifacts": {"session_dir": str(outside)},
            "video_analysis_mode": "gemini",
            "extractor_strategy": "balanced",
        },
    )
    assert response.status_code == 400
    assert "outside runtime root" in response.json()["detail"]
