from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "ci" / "gemini_ui_ux_diff_audit.py"


def _load_script_module(monkeypatch):
    fake_google = types.ModuleType("google")
    fake_genai = types.ModuleType("google.genai")
    fake_types = types.SimpleNamespace(
        Part=types.SimpleNamespace(from_text=lambda text: {"text": text}),
        GenerateContentConfig=lambda **kwargs: kwargs,
    )
    fake_genai.types = fake_types
    fake_genai.Client = object
    fake_google.genai = fake_genai
    monkeypatch.setitem(sys.modules, "google", fake_google)
    monkeypatch.setitem(sys.modules, "google.genai", fake_genai)

    spec = importlib.util.spec_from_file_location("gemini_ui_ux_diff_audit", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load gemini_ui_ux_diff_audit.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_filter_targets_keeps_only_frontend_and_apps_web_supported_files(
    monkeypatch, tmp_path: Path
) -> None:
    module = _load_script_module(monkeypatch)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "frontend").mkdir(parents=True)
    (tmp_path / "tests/web-harness").mkdir(parents=True)
    (tmp_path / "backend").mkdir(parents=True)
    (tmp_path / "frontend" / "a.tsx").write_text("const a = 1;", encoding="utf-8")
    (tmp_path / "tests/web-harness" / "b.css").write_text(".x{}", encoding="utf-8")
    (tmp_path / "backend" / "ignored.tsx").write_text("const b = 2;", encoding="utf-8")
    (tmp_path / "frontend" / "ignored.md").write_text("# x", encoding="utf-8")

    result = module._filter_targets(
        [
            "apps/command-center/a.tsx",
            "apps/command-center/a.tsx",
            "tests/web-harness/b.css",
            "services/api/ignored.tsx",
            "apps/command-center/ignored.md",
            "apps/command-center/missing.tsx",
        ]
    )

    assert result == ["tests/web-harness/b.css", "apps/command-center/a.tsx"]


def test_parse_json_handles_embedded_json_and_invalid_payload(monkeypatch) -> None:
    module = _load_script_module(monkeypatch)

    embedded = module._parse_json(
        "non-json prefix\n"
        + '{"passed": true, "summary": "ok", "issues": []}'
        + "\nnon-json suffix"
    )
    assert embedded["passed"] is True
    assert embedded["summary"] == "ok"

    invalid = module._parse_json("<<< not-json >>>")
    assert invalid["passed"] is False
    assert invalid["summary"] == "invalid json response"
    assert invalid["issues"][0]["severity"] == "error"


def test_main_skips_when_no_targets(monkeypatch, capsys) -> None:
    module = _load_script_module(monkeypatch)
    monkeypatch.setattr(module, "_detect_targets", lambda _cli_files: [])

    exit_code = module.main()
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "no frontend UI/UX file changes detected; skip" in captured.out


def test_main_fails_when_api_key_missing(monkeypatch, capsys) -> None:
    module = _load_script_module(monkeypatch)
    monkeypatch.setattr(
        module, "_detect_targets", lambda _cli_files: ["apps/command-center/src/App.tsx"]
    )
    monkeypatch.setattr(module, "_load_api_key", lambda: "")

    exit_code = module.main()
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "missing GEMINI_API_KEY" in captured.err


def _stub_main_dependencies(module, monkeypatch, tmp_path: Path, response_text: str):
    report_path = tmp_path / "gemini-uiux-diff-audit.json"
    monkeypatch.setattr(module, "REPORT_PATH", report_path)
    monkeypatch.setattr(
        module, "_detect_targets", lambda _cli_files: ["apps/command-center/src/App.tsx"]
    )
    monkeypatch.setattr(module, "_load_api_key", lambda: "test-key")
    monkeypatch.setattr(module, "_resolve_model", lambda: "models/gemini-3.0-flash")
    monkeypatch.setattr(module, "_collect_payload", lambda _files: {"files": [], "diff": ""})

    class _StubResponse:
        def __init__(self, text: str) -> None:
            self.text = text

    class _StubModels:
        def __init__(self, text: str) -> None:
            self._text = text

        def generate_content(self, **_kwargs):
            return _StubResponse(self._text)

    class _StubClient:
        def __init__(self, api_key: str) -> None:
            assert api_key == "test-key"  # pragma: allowlist secret
            self.models = _StubModels(response_text)

    monkeypatch.setattr(module.genai, "Client", _StubClient)
    return report_path


def test_main_advisory_mode_records_blocking_findings_but_returns_success(
    monkeypatch, tmp_path: Path, capsys
) -> None:
    module = _load_script_module(monkeypatch)
    report_path = _stub_main_dependencies(
        module,
        monkeypatch,
        tmp_path,
        json.dumps(
            {
                "passed": False,
                "summary": "has issues",
                "issues": [{"severity": "error", "reason": "bad a11y"}],
            }
        ),
    )
    # Default mode is blocking; set explicit advisory mode for this test branch.
    monkeypatch.setenv("GEMINI_UI_UX_BLOCKING", "0")

    exit_code = module.main()
    assert exit_code == 0
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    assert payload["blocking_count"] == 1
    assert payload["passed"] is False
    captured = capsys.readouterr()
    assert "advisory mode" in captured.out


def test_main_blocking_mode_fails_on_blocking_findings(monkeypatch, tmp_path: Path, capsys) -> None:
    module = _load_script_module(monkeypatch)
    _stub_main_dependencies(
        module,
        monkeypatch,
        tmp_path,
        json.dumps(
            {
                "passed": False,
                "summary": "has issues",
                "issues": [{"severity": "error", "reason": "bad a11y"}],
            }
        ),
    )
    monkeypatch.setenv("GEMINI_UI_UX_BLOCKING", "1")

    exit_code = module.main()
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "failed (1 blocking issues)" in captured.err


def test_main_falls_back_to_next_model_on_404(monkeypatch, tmp_path: Path) -> None:
    module = _load_script_module(monkeypatch)
    report_path = tmp_path / "gemini-uiux-diff-audit.json"
    monkeypatch.setattr(module, "REPORT_PATH", report_path)
    monkeypatch.setattr(
        module, "_detect_targets", lambda _cli_files: ["apps/command-center/src/App.tsx"]
    )
    monkeypatch.setattr(module, "_load_api_key", lambda: "test-key")
    monkeypatch.setattr(module, "_resolve_model", lambda: "models/custom-flash")
    monkeypatch.setattr(
        module,
        "_build_model_candidates",
        lambda _primary: ["models/custom-flash", "models/gemini-3.0-flash"],
    )
    monkeypatch.setattr(module, "_collect_payload", lambda _files: {"files": [], "diff": ""})

    class _StubResponse:
        def __init__(self, text: str) -> None:
            self.text = text

    class _StubModels:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def generate_content(self, **kwargs):
            model = kwargs["model"]
            self.calls.append(model)
            if model == "models/custom-flash":
                raise RuntimeError("404 NOT_FOUND")
            return _StubResponse(
                json.dumps({"passed": True, "summary": "ok", "issues": [{"severity": "warning"}]})
            )

    class _StubClient:
        def __init__(self, api_key: str) -> None:
            assert api_key == "test-key"  # pragma: allowlist secret
            self.models = _StubModels()

    monkeypatch.setattr(module.genai, "Client", _StubClient)
    monkeypatch.delenv("GEMINI_UI_UX_BLOCKING", raising=False)

    exit_code = module.main()
    assert exit_code == 0
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    assert payload["used_model"] == "models/gemini-3.0-flash"
