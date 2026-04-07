from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import importlib
from app.services.computer_use_service import (
    ComputerUseAction,
    ComputerUseService,
    ComputerUseServiceError,
)

computer_use_module = importlib.import_module("backend.app.services.computer_use_service")


def _new_action(action_id: str = "act_branch001") -> ComputerUseAction:
    return ComputerUseAction(
        action_id=action_id,
        name="click",
        args={"selector": "#submit"},
        rationale="submit form",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-branch",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )


def test_create_session_validates_instruction_and_model() -> None:
    service = ComputerUseService()
    with pytest.raises(ComputerUseServiceError) as missing_instruction:
        service.create_session(instruction="   ", actor="owner-a")
    assert missing_instruction.value.status_code == 422

    with pytest.raises(ComputerUseServiceError) as invalid_model:
        service.create_session(instruction="open dashboard", actor="owner-a", model="gpt-4o")
    assert invalid_model.value.status_code == 422


def test_preview_action_requires_api_key_and_parses_function_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open account", actor="owner-a")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(ComputerUseServiceError) as missing_key:
        service.preview_action(
            session_id=session.session_id,
            actor="owner-a",
            screenshot_base64=None,
            screenshot_mime_type="image/png",
        )
    assert missing_key.value.status_code == 503

    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
    fake_response = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(
                            function_call=SimpleNamespace(name="delete", args={"target": "record"})
                        )
                    ]
                )
            )
        ]
    )

    def fake_generate_plan(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return fake_response

    monkeypatch.setattr(service, "_generate_plan", fake_generate_plan)
    action = service.preview_action(
        session_id=session.session_id,
        actor="owner-a",
        screenshot_base64=None,
        screenshot_mime_type="image/png",
    )
    assert action.name == "delete"
    assert action.risk_level == "critical"
    assert action.require_confirmation is True


def test_preview_action_rejects_empty_effective_instruction() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open account", actor="owner-a")
    with pytest.raises(ComputerUseServiceError) as empty_instruction:
        service.preview_action(
            session_id=session.session_id,
            actor="owner-a",
            screenshot_base64=None,
            screenshot_mime_type="image/png",
            instruction="   ",
        )
    assert empty_instruction.value.status_code == 422


def test_confirm_action_handles_executed_approved_rejected_reason_updates() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")

    already_executed = _new_action("act_executed")
    already_executed.status = "executed"
    session.actions[already_executed.action_id] = already_executed
    returned = service.confirm_action(
        session_id=session.session_id,
        action_id=already_executed.action_id,
        actor="owner-a",
        approved=False,
    )
    assert returned.status == "executed"

    to_confirm = _new_action("act_confirm")
    session.actions[to_confirm.action_id] = to_confirm
    confirmed = service.confirm_action(
        session_id=session.session_id,
        action_id=to_confirm.action_id,
        actor="owner-a",
        approved=True,
        confirmation_reason="  operator approved  ",
    )
    assert confirmed.status == "confirmed"
    assert confirmed.confirmed_by == "owner-a"
    assert confirmed.confirmation_reason == "operator approved"

    to_reject = _new_action("act_reject")
    to_reject.confirmation_reason = "keep-me"
    session.actions[to_reject.action_id] = to_reject
    rejected = service.confirm_action(
        session_id=session.session_id,
        action_id=to_reject.action_id,
        actor="owner-a",
        approved=False,
        confirmation_reason="   ",
    )
    assert rejected.status == "rejected"
    assert rejected.confirmation_reason == "keep-me"


def test_read_evidence_skips_invalid_json_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(tmp_path))
    service = ComputerUseService()
    session = service.create_session(instruction="open settings", actor="owner-a")
    evidence_file = service._evidence_file(session.session_id)
    evidence_file.parent.mkdir(parents=True, exist_ok=True)
    evidence_file.write_text(
        "\n".join(['{"event":"session_created","payload":{}}', "{invalid", "", '{"event":"ok"}']),
        encoding="utf-8",
    )

    evidence = service.read_evidence(session_id=session.session_id, actor="owner-a")
    assert evidence["eventCount"] == 2
    assert len(evidence["events"]) == 2


def test_execute_action_guards_missing_executor_dependencies() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")
    session.actions["act_missing_script"] = _new_action("act_missing_script")
    service._playwright_executor_script = Path("/path/does/not/exist.mjs")
    with pytest.raises(ComputerUseServiceError) as missing_script:
        service.execute_action(
            session_id=session.session_id,
            action_id="act_missing_script",
            actor="owner-a",
        )
    assert missing_script.value.status_code == 503

    service._playwright_executor_script = Path(__file__)
    session.actions["act_missing_node"] = _new_action("act_missing_node")
    service._node_binary = None
    with pytest.raises(ComputerUseServiceError) as missing_node:
        service.execute_action(
            session_id=session.session_id,
            action_id="act_missing_node",
            actor="owner-a",
        )
    assert missing_node.value.status_code == 503


def test_execute_with_playwright_handles_nonzero_and_invalid_payload(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(tmp_path))
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")
    action = _new_action("act_exec")
    script = tmp_path / "executor.mjs"
    script.write_text("console.log('ok')\n", encoding="utf-8")
    service._playwright_executor_script = script
    service._node_binary = "node"

    def run_non_zero(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return SimpleNamespace(returncode=1, stderr="boom", stdout="")

    monkeypatch.setattr(computer_use_module.subprocess, "run", run_non_zero)
    with pytest.raises(ComputerUseServiceError) as non_zero:
        service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert non_zero.value.status_code == 502

    def run_bad_json(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return SimpleNamespace(returncode=0, stderr="", stdout="not-json")

    monkeypatch.setattr(computer_use_module.subprocess, "run", run_bad_json)
    with pytest.raises(ComputerUseServiceError) as bad_json:
        service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert bad_json.value.status_code == 502

    def run_bad_payload(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return SimpleNamespace(returncode=0, stderr="", stdout="[]")

    monkeypatch.setattr(computer_use_module.subprocess, "run", run_bad_payload)
    with pytest.raises(ComputerUseServiceError) as bad_payload:
        service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert bad_payload.value.status_code == 502


def test_execute_with_playwright_handles_oserror_and_evidence_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(tmp_path))
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")
    action = _new_action("act_exec_oserror")
    script = tmp_path / "executor_oserror.mjs"
    script.write_text("console.log('ok')\n", encoding="utf-8")
    service._playwright_executor_script = script
    service._node_binary = "node"

    def _raise_oserror(*args: object, **kwargs: object) -> None:
        _ = (args, kwargs)
        raise OSError("spawn failed")

    monkeypatch.setattr(computer_use_module.subprocess, "run", _raise_oserror)
    with pytest.raises(ComputerUseServiceError) as oserror_exc:
        service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert oserror_exc.value.status_code == 503

    def run_unexpected_evidence(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return SimpleNamespace(
            returncode=0,
            stderr="",
            stdout='{"executor":"node-custom","evidence":"unexpected"}',
        )

    monkeypatch.setattr(computer_use_module.subprocess, "run", run_unexpected_evidence)
    execution = service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert execution["executor"] == "node-custom"
    assert execution["evidence"] == {
        "screens": [],
        "clips": [],
        "network_summary": {},
        "dom_summary": {},
        "replay_trace": {},
    }


def test_parse_and_thinking_resolvers_cover_enum_and_node_branches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = ComputerUseService()
    assert service._parse_bool("YES", False) is True
    assert service._parse_bool("OFF", True) is False
    assert service._parse_bool("maybe", True) is True

    node_binary = tmp_path / "node-real"
    node_binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    node_binary.chmod(0o755)

    def fake_access(path: str | os.PathLike[str], mode: int) -> bool:
        return Path(path).resolve() == node_binary.resolve() and mode == computer_use_module.os.X_OK

    def fake_which(command: str) -> str | None:
        if command in {"node-env-alias", "node"}:
            return str(node_binary)
        return None

    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", str(node_binary))
    monkeypatch.setattr(computer_use_module.os, "access", fake_access)
    monkeypatch.setattr(computer_use_module, "which", fake_which)
    assert ComputerUseService._resolve_node_binary() == str(node_binary.resolve())

    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", "node-env-alias")
    assert ComputerUseService._resolve_node_binary() == str(node_binary.resolve())

    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", "")
    assert ComputerUseService._resolve_node_binary() == str(node_binary.resolve())

    fake_levels = SimpleNamespace(HIGH="HIGH_ENUM", LOW="LOW_ENUM")
    monkeypatch.setattr(
        computer_use_module, "genai_types", SimpleNamespace(ThinkingLevel=fake_levels)
    )
    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "low")
    assert service._resolve_thinking_level() == "LOW_ENUM"

    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "invalid")
    assert service._resolve_thinking_level() == "HIGH_ENUM"

    monkeypatch.setattr(
        computer_use_module,
        "genai_types",
        SimpleNamespace(ThinkingLevel=SimpleNamespace(HIGH="HIGH_ONLY")),
    )
    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "medium")
    assert service._resolve_thinking_level() == "HIGH_ONLY"

    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "unknown")
    monkeypatch.setattr(computer_use_module, "genai_types", None)
    assert service._resolve_thinking_level() == "HIGH"


def test_generate_plan_extract_and_risk_classification_branches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ComputerUseService()

    class FakeThinkingConfig:
        def __init__(self, *, thinking_level, include_thoughts):
            self.thinking_level = thinking_level
            self.include_thoughts = include_thoughts

    class FakeGenerateContentConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakePart:
        @staticmethod
        def from_bytes(*, data: bytes, mime_type: str):
            return {"size": len(data), "mime": mime_type}

    class FakeComputerUse:
        pass

    class WorkingTool:
        def __init__(self, *, computer_use):
            self.computer_use = computer_use

    class FailingTool:
        def __init__(self, *, computer_use):
            _ = computer_use
            raise RuntimeError("tool construction failed")

    def run_generate(tool_cls, screenshot: str | None, include_thoughts: bool) -> dict[str, object]:
        captured: dict[str, object] = {}

        class FakeModels:
            def generate_content(self, *, model: str, contents, config):
                captured["model"] = model
                captured["contents"] = contents
                captured["config"] = config
                return {"ok": True}

        class FakeClient:
            def __init__(self, api_key: str):
                captured["api_key"] = api_key
                self.models = FakeModels()

        monkeypatch.setattr(computer_use_module, "genai", SimpleNamespace(Client=FakeClient))
        monkeypatch.setattr(
            computer_use_module,
            "genai_types",
            SimpleNamespace(
                Part=FakePart,
                Tool=tool_cls,
                ComputerUse=FakeComputerUse,
                ThinkingConfig=FakeThinkingConfig,
                GenerateContentConfig=FakeGenerateContentConfig,
            ),
        )
        monkeypatch.setattr(service, "_resolve_thinking_level", lambda: "HIGH_ENUM")
        service._generate_plan(
            api_key="key-1",  # pragma: allowlist secret
            model="gemini-3.1-pro-preview",
            instruction="do something",
            screenshot_base64=screenshot,
            screenshot_mime_type="image/png",
            include_thoughts=include_thoughts,
        )
        return captured

    with_tools = run_generate(WorkingTool, "not-valid-base64", True)
    with_tools_config = with_tools["config"]
    assert isinstance(with_tools_config, FakeGenerateContentConfig)
    with_tools_kwargs = with_tools_config.kwargs
    assert with_tools["contents"] == ["do something", "[invalid screenshot payload]"]
    assert isinstance(with_tools_kwargs["tools"], list)
    assert len(with_tools_kwargs["tools"]) == 1
    assert with_tools_kwargs["thinking_config"].include_thoughts is True

    without_tools = run_generate(FailingTool, None, False)
    without_tools_config = without_tools["config"]
    assert isinstance(without_tools_config, FakeGenerateContentConfig)
    without_tools_kwargs = without_tools_config.kwargs
    assert without_tools["contents"] == ["do something"]
    assert "tools" not in without_tools_kwargs
    assert without_tools_kwargs["thinking_config"].include_thoughts is False

    raw_args_response = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[SimpleNamespace(function_call=SimpleNamespace(name="click", args="x=1"))]
                )
            )
        ]
    )
    extracted = service._extract_action_from_response(raw_args_response)
    assert extracted == (
        "click",
        {"raw": "x=1"},
        "generated by gemini computer-use planner",
    )

    text_only_response = SimpleNamespace(candidates="not-a-list", text="  summarize this action  ")
    text_fallback = service._extract_action_from_response(text_only_response)
    assert text_fallback == (
        "manual_review",
        {"summary": "summarize this action"},
        "text-only fallback",
    )

    empty_response = SimpleNamespace(candidates=None, text=None)
    empty_fallback = service._extract_action_from_response(empty_response)
    assert empty_fallback == ("manual_review", {}, "empty model response")

    keyword_risk, _ = service._classify_risk("drag", {"note": "please checkout now"}, "open page")
    medium_risk, _ = service._classify_risk("click", {}, "open page")
    low_risk, _ = service._classify_risk("hover_custom", {}, "open page")
    assert keyword_risk == "high"
    assert medium_risk == "medium"
    assert low_risk == "low"


def test_require_and_validation_error_branches() -> None:
    service = ComputerUseService()

    with pytest.raises(ComputerUseServiceError) as invalid_session:
        service._require_session("bad-session-id")
    assert invalid_session.value.status_code == 422

    with pytest.raises(ComputerUseServiceError) as missing_session:
        service._require_session("cus_" + "f" * 32)
    assert missing_session.value.status_code == 404

    session = service.create_session(instruction="open app", actor="owner-a")
    with pytest.raises(ComputerUseServiceError) as missing_action:
        service._require_action(session.session_id, "act_missing")
    assert missing_action.value.status_code == 404

    rejected = _new_action("act_rejected")
    rejected.status = "rejected"
    with pytest.raises(ComputerUseServiceError) as rejected_error:
        service._validate_action_can_execute(rejected)
    assert rejected_error.value.status_code == 409

    previewed_requires_confirmation = _new_action("act_previewed_confirmation")
    previewed_requires_confirmation.require_confirmation = True
    previewed_requires_confirmation.status = "previewed"
    with pytest.raises(ComputerUseServiceError) as previewed_error:
        service._validate_action_can_execute(previewed_requires_confirmation)
    assert previewed_error.value.status_code == 409

    pending_requires_confirmation = _new_action("act_pending_confirmation")
    pending_requires_confirmation.require_confirmation = True
    pending_requires_confirmation.status = "pending"
    with pytest.raises(ComputerUseServiceError) as pending_error:
        service._validate_action_can_execute(pending_requires_confirmation)
    assert pending_error.value.status_code == 409
