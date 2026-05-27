from __future__ import annotations

import base64
import importlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.computer_use_service import (
    ComputerUseAction,
    ComputerUseService,
    ComputerUseServiceError,
)

computer_use_module = importlib.import_module("backend.app.services.computer_use_service")


def _new_action(action_id: str = "act_branch_expansion") -> ComputerUseAction:
    return ComputerUseAction(
        action_id=action_id,
        name="click",
        args={"selector": "#submit"},
        rationale="submit form",
        risk_level="low",
        confirmation_reason=None,
        action_digest="digest-expansion",
        require_confirmation=False,
        safety_decision="allow_auto_execute",
    )


def test_resolve_node_binary_covers_configured_path_and_discovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configured = tmp_path / "configured-node"
    configured.write_text("#!/bin/sh\n", encoding="utf-8")
    configured.chmod(0o755)
    discovered = tmp_path / "discovered-node"
    discovered.write_text("#!/bin/sh\n", encoding="utf-8")
    discovered.chmod(0o755)
    fallback = tmp_path / "fallback-node"
    fallback.write_text("#!/bin/sh\n", encoding="utf-8")
    fallback.chmod(0o755)
    allowed_paths = {configured.resolve(), discovered.resolve(), fallback.resolve()}

    def fake_access(path: str | os.PathLike[str], mode: int) -> bool:
        return Path(path).resolve() in allowed_paths and mode == computer_use_module.os.X_OK

    def fake_which(command: str) -> str | None:
        if command == "custom-node":
            return str(discovered)
        if command == "node":
            return str(fallback)
        return None

    monkeypatch.setattr(computer_use_module.os, "access", fake_access)
    monkeypatch.setattr(computer_use_module, "which", fake_which)

    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", str(configured))
    assert ComputerUseService._resolve_node_binary() == str(configured.resolve())

    monkeypatch.setenv("COMPUTER_USE_NODE_BINARY", "custom-node")
    assert ComputerUseService._resolve_node_binary() == str(discovered.resolve())

    monkeypatch.delenv("COMPUTER_USE_NODE_BINARY", raising=False)
    assert ComputerUseService._resolve_node_binary() == str(fallback.resolve())


def test_preview_confirm_and_guard_paths_cover_confirmation_edges() -> None:
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")

    with pytest.raises(ComputerUseServiceError) as empty_instruction:
        service.preview_action(
            session_id=session.session_id,
            actor="owner-a",
            screenshot_base64=None,
            screenshot_mime_type="image/png",
            instruction="   ",
        )
    assert empty_instruction.value.status_code == 422

    executed = _new_action("act_executed")
    executed.status = "executed"
    session.actions[executed.action_id] = executed
    assert (
        service.confirm_action(
            session_id=session.session_id,
            action_id=executed.action_id,
            actor="owner-a",
            approved=False,
        )
        is executed
    )

    pending = _new_action("act_pending")
    session.actions[pending.action_id] = pending
    confirmed = service.confirm_action(
        session_id=session.session_id,
        action_id=pending.action_id,
        actor="owner-a",
        approved=True,
        confirmation_reason="  reviewed manually  ",
    )
    assert confirmed.status == "confirmed"
    assert confirmed.confirmation_reason == "reviewed manually"

    rejected = _new_action("act_rejected")
    rejected.status = "rejected"
    with pytest.raises(ComputerUseServiceError) as rejected_error:
        service._validate_action_can_execute(rejected)
    assert rejected_error.value.status_code == 409

    previewed = _new_action("act_previewed")
    previewed.require_confirmation = True
    with pytest.raises(ComputerUseServiceError) as previewed_error:
        service._validate_action_can_execute(previewed)
    assert previewed_error.value.status_code == 409

    queued = _new_action("act_queued")
    queued.require_confirmation = True
    queued.status = "queued"
    with pytest.raises(ComputerUseServiceError) as queued_error:
        service._validate_action_can_execute(queued)
    assert queued_error.value.status_code == 409

    with pytest.raises(ComputerUseServiceError) as invalid_session:
        service._require_session("bad-session")
    assert invalid_session.value.status_code == 422

    missing_session_id = "cus_" + ("0" * 32)
    with pytest.raises(ComputerUseServiceError) as missing_session:
        service._require_session(missing_session_id)
    assert missing_session.value.status_code == 404

    with pytest.raises(ComputerUseServiceError) as missing_action:
        service._require_action(session.session_id, "act_missing")
    assert missing_action.value.status_code == 404


def test_generate_plan_covers_tool_success_and_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakePart:
        @staticmethod
        def from_bytes(*, data: bytes, mime_type: str) -> dict[str, object]:
            return {"data": data, "mime_type": mime_type}

    class FakeThinkingConfig:
        def __init__(self, *, thinking_level: object, include_thoughts: bool) -> None:
            self.thinking_level = thinking_level
            self.include_thoughts = include_thoughts

    class FakeGenerateContentConfig:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    class FakeTool:
        def __init__(self, *, computer_use: object) -> None:
            self.computer_use = computer_use

    class FakeClient:
        def __init__(self, *, api_key: str) -> None:
            captured["api_key"] = api_key
            self.models = SimpleNamespace(generate_content=self.generate_content)

        def generate_content(self, **kwargs: object) -> dict[str, object]:
            captured["generate_content"] = kwargs
            return {"ok": True}

    fake_types = SimpleNamespace(
        Part=FakePart,
        ThinkingConfig=FakeThinkingConfig,
        GenerateContentConfig=FakeGenerateContentConfig,
        Tool=FakeTool,
        ComputerUse=lambda: "computer-use",
        ThinkingLevel=SimpleNamespace(MEDIUM="ENUM_MEDIUM", HIGH="ENUM_HIGH"),
    )
    monkeypatch.setattr(computer_use_module, "genai_types", fake_types)
    monkeypatch.setattr(computer_use_module, "genai", SimpleNamespace(Client=FakeClient))
    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "medium")

    service = ComputerUseService()
    response = service._generate_plan(
        api_key="gemini-key",  # pragma: allowlist secret
        model="gemini-3.1-pro-preview",
        instruction="inspect page",
        screenshot_base64=base64.b64encode(b"png-bytes").decode("utf-8"),
        screenshot_mime_type="image/webp",
        include_thoughts=False,
    )
    assert response == {"ok": True}
    assert captured["api_key"] == "gemini-key"  # pragma: allowlist secret
    generate_call = captured["generate_content"]
    assert isinstance(generate_call, dict)
    assert generate_call["model"] == "gemini-3.1-pro-preview"
    assert generate_call["contents"][1]["mime_type"] == "image/webp"
    assert generate_call["config"].kwargs["tools"][0].computer_use == "computer-use"
    assert generate_call["config"].kwargs["thinking_config"].thinking_level == "ENUM_MEDIUM"
    assert generate_call["config"].kwargs["thinking_config"].include_thoughts is False

    class RaisingTool:
        def __init__(self, *, computer_use: object) -> None:
            _ = computer_use
            raise RuntimeError("tool init failed")

    fallback_types = SimpleNamespace(
        Part=FakePart,
        ThinkingConfig=FakeThinkingConfig,
        GenerateContentConfig=FakeGenerateContentConfig,
        Tool=RaisingTool,
        ComputerUse=lambda: "computer-use",
        ThinkingLevel=SimpleNamespace(HIGH="ENUM_HIGH"),
    )
    monkeypatch.setattr(computer_use_module, "genai_types", fallback_types)
    captured.clear()
    response = service._generate_plan(
        api_key="gemini-key",  # pragma: allowlist secret
        model="gemini-3.1-pro-preview",
        instruction="inspect page",
        screenshot_base64="not-base64",
        screenshot_mime_type="",
        include_thoughts=True,
    )
    assert response == {"ok": True}
    fallback_call = captured["generate_content"]
    assert isinstance(fallback_call, dict)
    assert fallback_call["contents"][1] == "[invalid screenshot payload]"
    assert "tools" not in fallback_call["config"].kwargs


def test_extract_action_risk_and_thinking_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ComputerUseService()

    monkeypatch.setenv("GEMINI_THINKING_LEVEL", "medium")
    fake_thinking_enum = SimpleNamespace(
        ThinkingLevel=SimpleNamespace(MEDIUM="ENUM_MEDIUM", HIGH="ENUM_HIGH")
    )
    monkeypatch.setattr(computer_use_module, "genai_types", fake_thinking_enum)
    assert service._resolve_thinking_level() == "ENUM_MEDIUM"

    response_with_raw_args = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(
                            function_call=SimpleNamespace(name="type", args="raw-payload")
                        )
                    ]
                )
            )
        ]
    )
    name, args, rationale = service._extract_action_from_response(response_with_raw_args)
    assert (name, args, rationale) == (
        "type",
        {"raw": "raw-payload"},
        "generated by gemini computer-use planner",
    )

    no_parts_response = SimpleNamespace(
        candidates=[SimpleNamespace(content=SimpleNamespace(parts=None))], text="review manually"
    )
    assert service._extract_action_from_response(no_parts_response) == (
        "manual_review",
        {"summary": "review manually"},
        "text-only fallback",
    )

    assert service._extract_action_from_response(SimpleNamespace(candidates=None, text="   ")) == (
        "manual_review",
        {},
        "empty model response",
    )

    assert service._classify_risk("noop", {"cta": "checkout now"}, "inspect later") == (
        "high",
        "instruction/args contain high-risk keywords",
    )
    assert service._classify_risk("scroll", {}, "inspect page") == ("medium", None)
    assert service._classify_risk("hover_card", {}, "inspect page") == ("low", None)


def test_execute_with_playwright_and_evidence_fallbacks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("UNIVERSAL_AUTOMATION_RUNTIME_DIR", str(tmp_path))
    service = ComputerUseService()
    session = service.create_session(instruction="open dashboard", actor="owner-a")
    action = _new_action("act_exec_oserror")

    script = tmp_path / "executor.mjs"
    script.write_text("console.log('executor')\n", encoding="utf-8")
    service._playwright_executor_script = script
    service._node_binary = "node"

    def raise_oserror(*args: object, **kwargs: object) -> object:
        _ = (args, kwargs)
        raise OSError("executor missing")

    monkeypatch.setattr(computer_use_module.subprocess, "run", raise_oserror)
    with pytest.raises(ComputerUseServiceError) as os_error:
        service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert os_error.value.status_code == 503

    def run_invalid_evidence(*args: object, **kwargs: object) -> SimpleNamespace:
        _ = (args, kwargs)
        return SimpleNamespace(
            returncode=0,
            stderr="",
            stdout=json.dumps({"executor": "node", "evidence": "invalid"}),
        )

    monkeypatch.setattr(computer_use_module.subprocess, "run", run_invalid_evidence)
    execution = service._execute_with_playwright(session=session, action=action, actor="owner-a")
    assert execution == {
        "executor": "node",
        "evidence": {
            "screens": [],
            "clips": [],
            "network_summary": {},
            "dom_summary": {},
            "replay_trace": {},
        },
    }
