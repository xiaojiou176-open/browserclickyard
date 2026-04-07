"""Shared runtime helpers for computer-use provider scripts."""

from __future__ import annotations

import base64
import io
import os
import time
from collections.abc import Callable, Mapping
from typing import Any

import pyautogui
from PIL import ImageGrab

SENSITIVE_KEYWORDS = {
    "type",
    "text",
    "token",
    "cvc",
    "cvv",
    "password",
    "secret",
    "otp",
    "passcode",
    "authorization",
}

HIGH_RISK_ACTION_KEYWORDS = ("delete", "pay", "send", "purchase", "submit")
HIGH_RISK_CONTEXT_KEYWORDS = (
    "delete",
    "remove",
    "pay",
    "payment",
    "purchase",
    "checkout",
    "send",
    "transfer",
    "submit",
    "confirm",
)
IRREVERSIBLE_KEYWORDS = (
    "delete",
    "pay",
    "purchase",
    "send",
    "submit",
    "transfer",
    "checkout",
    "confirm",
)
MODEL_CONFIRM_SIGNAL_KEYS = (
    "confirmed",
    "model_confirmed",
    "risk_ack",
    "high_risk_confirmed",
    "safety_confirmed",
    "confirmation",
)
TRUTHY_ENV_VALUES = {"1", "true", "yes", "y", "on"}
MAX_STEPS_EXCEEDED_REASON_CODE = "ai.gemini.computer_use.max_steps_exceeded"

_SAFETY_CONFIRMATION_EVENTS: list[dict[str, Any]] = []


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUTHY_ENV_VALUES


def is_auto_confirm_enabled() -> bool:
    return _env_flag("COMPUTER_USE_AUTO_CONFIRM")


def is_high_risk_confirmation_enabled() -> bool:
    return _env_flag("COMPUTER_USE_CONFIRM_HIGH_RISK")


def is_high_risk_action(action_name: str) -> bool:
    normalized = action_name.strip().lower()
    return any(keyword in normalized for keyword in HIGH_RISK_ACTION_KEYWORDS)


def reset_safety_confirmation_events() -> None:
    _SAFETY_CONFIRMATION_EVENTS.clear()


def get_safety_confirmation_events() -> list[dict[str, Any]]:
    return list(_SAFETY_CONFIRMATION_EVENTS)


def _append_safety_confirmation_event(event: dict[str, Any]) -> None:
    _SAFETY_CONFIRMATION_EVENTS.append(event)


def configure_runtime(*, pause: float = 0.3, failsafe: bool = True) -> None:
    pyautogui.PAUSE = pause
    pyautogui.FAILSAFE = failsafe


def get_screen_size() -> tuple[int, int]:
    width, height = pyautogui.size()
    return int(width), int(height)


def take_screenshot_bytes() -> bytes:
    screenshot = ImageGrab.grab()
    buffer = io.BytesIO()
    screenshot.save(buffer, format="PNG")
    return buffer.getvalue()


def take_screenshot_base64() -> str:
    return base64.standard_b64encode(take_screenshot_bytes()).decode("utf-8")


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower()
    return any(keyword in normalized for keyword in SENSITIVE_KEYWORDS)


def _mask_sensitive(value: Any) -> str:
    if value is None:
        return "<redacted>"
    if isinstance(value, str):
        return f"<redacted:{len(value)} chars>"
    if isinstance(value, (list, tuple, set)):
        return f"<redacted:{len(value)} items>"
    if isinstance(value, dict):
        return "<redacted:object>"
    return "<redacted>"


def redact_action(action: Mapping[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in action.items():
        if _is_sensitive_key(key):
            redacted[key] = _mask_sensitive(value)
            continue
        if isinstance(value, Mapping):
            redacted[key] = redact_action(value)
            continue
        if isinstance(value, list):
            redacted[key] = [
                redact_action(item) if isinstance(item, Mapping) else item for item in value
            ]
            continue
        redacted[key] = value
    return redacted


def _read_coordinate(
    action_args: Mapping[str, Any], screen_width: int, screen_height: int
) -> tuple[int, int]:
    coordinate = action_args.get("coordinate")
    if isinstance(coordinate, (list, tuple)) and len(coordinate) >= 2:
        return int(coordinate[0]), int(coordinate[1])
    return int(action_args.get("x", screen_width // 2)), int(
        action_args.get("y", screen_height // 2)
    )


def _has_explicit_coordinate(action_args: Mapping[str, Any]) -> bool:
    if "x" in action_args and "y" in action_args:
        return True
    coordinate = action_args.get("coordinate")
    return isinstance(coordinate, (list, tuple)) and len(coordinate) >= 2


def _read_drag_points(action_args: Mapping[str, Any]) -> tuple[int, int, int, int]:
    if isinstance(action_args.get("start_coordinate"), (list, tuple)) and isinstance(
        action_args.get("end_coordinate"),
        (list, tuple),
    ):
        start = action_args["start_coordinate"]
        end = action_args["end_coordinate"]
        return int(start[0]), int(start[1]), int(end[0]), int(end[1])
    return (
        int(action_args.get("start_x", 0)),
        int(action_args.get("start_y", 0)),
        int(action_args.get("end_x", 0)),
        int(action_args.get("end_y", 0)),
    )


def _normalize_key(raw_key: str) -> str:
    key_map = {
        "return": "enter",
        "tab": "tab",
        "escape": "escape",
        "backspace": "backspace",
        "space": "space",
    }
    normalized = raw_key.strip().lower()
    return key_map.get(normalized, normalized)


def _collect_context_text(action_args: Mapping[str, Any], depth: int = 0) -> str:
    if depth > 2:
        return ""
    chunks: list[str] = []
    for key, value in action_args.items():
        normalized_key = str(key).lower()
        if any(
            token in normalized_key
            for token in ("text", "target", "context", "label", "url", "title", "name", "value")
        ):
            chunks.append(str(value))
        if isinstance(value, Mapping):
            nested = _collect_context_text(value, depth + 1)
            if nested:
                chunks.append(nested)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, Mapping):
                    nested = _collect_context_text(item, depth + 1)
                    if nested:
                        chunks.append(nested)
                elif isinstance(item, str):
                    chunks.append(item)
    return " ".join(chunks).strip().lower()


def _extract_model_confirmation_signal(action_args: Mapping[str, Any]) -> tuple[bool, str]:
    for key in MODEL_CONFIRM_SIGNAL_KEYS:
        if key not in action_args:
            continue
        value = action_args.get(key)
        if isinstance(value, bool):
            return value, key
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in TRUTHY_ENV_VALUES or normalized in {
                "confirm",
                "confirmed",
                "allow",
                "approved",
            }:
                return True, key
            if normalized in {"0", "false", "no", "deny", "rejected"}:
                return False, key
    return False, ""


def _is_irreversible(action_name: str, context_text: str) -> bool:
    normalized_action = action_name.strip().lower()
    if any(keyword in normalized_action for keyword in IRREVERSIBLE_KEYWORDS):
        return True
    return any(keyword in context_text for keyword in IRREVERSIBLE_KEYWORDS)


def _is_high_risk_by_business_rules(action_name: str, context_text: str) -> tuple[bool, list[str]]:
    rules_matched: list[str] = []
    normalized_action = action_name.strip().lower()
    if any(keyword in normalized_action for keyword in HIGH_RISK_ACTION_KEYWORDS):
        rules_matched.append("action_keyword")
    if any(keyword in context_text for keyword in HIGH_RISK_CONTEXT_KEYWORDS):
        rules_matched.append("context_keyword")
    return len(rules_matched) > 0, rules_matched


def _ask_secondary_confirmation(action_name: str, context_text: str) -> tuple[bool, str]:
    if is_auto_confirm_enabled():
        return True, "auto_confirm_env"

    preview = context_text[:120] if context_text else "<none>"
    print(
        f"[SAFETY] Irreversible action requires confirmation. action={action_name}, context={preview}. "
        "Type CONFIRM to proceed: "
    )
    try:
        answer = input().strip()
    except EOFError:
        return False, "user_input_eof"
    if answer == "CONFIRM":
        return True, "user_confirmed"
    return False, "user_rejected"


def execute_action(
    action_name: str,
    action_args: Mapping[str, Any],
    *,
    screen_width: int,
    screen_height: int,
    typing_interval: float = 0.02,
    redact_typed_text: bool = True,
) -> str:
    action = action_name.strip()

    action_context = _collect_context_text(action_args)
    high_risk_business, matched_rules = _is_high_risk_by_business_rules(action, action_context)
    model_confirmed, model_signal_source = _extract_model_confirmation_signal(action_args)
    irreversible = _is_irreversible(action, action_context)

    if high_risk_business:
        if not (model_confirmed and is_high_risk_confirmation_enabled()):
            _append_safety_confirmation_event(
                {
                    "action": action,
                    "highRisk": True,
                    "irreversible": irreversible,
                    "modelConfirmed": model_confirmed,
                    "modelSignalSource": model_signal_source or None,
                    "businessRulesMatched": matched_rules,
                    "contextPreview": action_context[:200] if action_context else None,
                    "gateDecision": "blocked",
                    "blockedReasonCode": "ai.gemini.computer_use.high_risk.double_gate_blocked",
                    "secondaryConfirmationRequired": irreversible,
                    "secondaryConfirmationAccepted": False,
                }
            )
            return (
                f"Blocked high-risk action '{action}'. "
                "Requires dual gate: model confirmation signal + COMPUTER_USE_CONFIRM_HIGH_RISK=true."
            )

        if irreversible:
            secondary_confirmed, secondary_source = _ask_secondary_confirmation(
                action, action_context
            )
            if not secondary_confirmed:
                _append_safety_confirmation_event(
                    {
                        "action": action,
                        "highRisk": True,
                        "irreversible": True,
                        "modelConfirmed": True,
                        "modelSignalSource": model_signal_source or None,
                        "businessRulesMatched": matched_rules,
                        "contextPreview": action_context[:200] if action_context else None,
                        "gateDecision": "blocked",
                        "blockedReasonCode": "ai.gemini.computer_use.secondary_confirmation_rejected",
                        "secondaryConfirmationRequired": True,
                        "secondaryConfirmationAccepted": False,
                        "secondaryConfirmationSource": secondary_source,
                    }
                )
                return f"Blocked irreversible action '{action}': secondary confirmation rejected."

            _append_safety_confirmation_event(
                {
                    "action": action,
                    "highRisk": True,
                    "irreversible": True,
                    "modelConfirmed": True,
                    "modelSignalSource": model_signal_source or None,
                    "businessRulesMatched": matched_rules,
                    "contextPreview": action_context[:200] if action_context else None,
                    "gateDecision": "allowed",
                    "secondaryConfirmationRequired": True,
                    "secondaryConfirmationAccepted": True,
                    "secondaryConfirmationSource": secondary_source,
                }
            )
        else:
            _append_safety_confirmation_event(
                {
                    "action": action,
                    "highRisk": True,
                    "irreversible": False,
                    "modelConfirmed": True,
                    "modelSignalSource": model_signal_source or None,
                    "businessRulesMatched": matched_rules,
                    "contextPreview": action_context[:200] if action_context else None,
                    "gateDecision": "allowed",
                    "secondaryConfirmationRequired": False,
                    "secondaryConfirmationAccepted": False,
                }
            )

    if action in {"click", "left_click", "right_click"}:
        button = "left"
        if action == "right_click":
            button = "right"
        elif isinstance(action_args.get("button"), str):
            button = action_args.get("button", "left")
        if _has_explicit_coordinate(action_args):
            x, y = _read_coordinate(action_args, screen_width, screen_height)
            pyautogui.click(x, y, button=button)
            return f"Clicked {button} at ({x}, {y})"
        pyautogui.click(button=button)
        return "Clicked at current position"

    if action == "double_click":
        if _has_explicit_coordinate(action_args):
            x, y = _read_coordinate(action_args, screen_width, screen_height)
            pyautogui.doubleClick(x, y)
            return f"Double-clicked at ({x}, {y})"
        pyautogui.doubleClick()
        return "Double-clicked at current position"

    if action in {"move", "mouse_move", "cursor_position"}:
        x, y = _read_coordinate(action_args, screen_width, screen_height)
        pyautogui.moveTo(x, y, duration=0.2)
        return f"Moved cursor to ({x}, {y})"

    if action in {"drag", "left_click_drag"}:
        start_x, start_y, end_x, end_y = _read_drag_points(action_args)
        pyautogui.moveTo(start_x, start_y, duration=0.2)
        pyautogui.drag(end_x - start_x, end_y - start_y, duration=0.5)
        return f"Dragged from ({start_x}, {start_y}) to ({end_x}, {end_y})"

    if action == "type":
        text = str(action_args.get("text", ""))
        if text:
            pyautogui.write(text, interval=typing_interval)
        if redact_typed_text:
            return f"Typed input (<redacted>, {len(text)} chars)"
        preview = text[:50]
        suffix = "..." if len(text) > 50 else ""
        return f"Typed: {preview}{suffix}"

    if action == "key":
        key = _normalize_key(str(action_args.get("key", "")))
        if key:
            pyautogui.press(key)
        return f"Pressed: {key}"

    if action in {"keyCombo", "hotkey"}:
        keys = action_args.get("keys", [])
        if isinstance(keys, list):
            normalized = [_normalize_key(str(key)) for key in keys if str(key).strip()]
            if normalized:
                pyautogui.hotkey(*normalized)
                return f"Hotkey: {'+'.join(normalized)}"
        return "Hotkey: <none>"

    if action == "scroll":
        x, y = _read_coordinate(action_args, screen_width, screen_height)
        pyautogui.moveTo(x, y)
        if "delta_y" in action_args or "delta_x" in action_args:
            delta_y = int(action_args.get("delta_y", 0) or 0)
            delta_x = int(action_args.get("delta_x", 0) or 0)
            amount = delta_y // 100 if delta_y else delta_x // 100
            pyautogui.scroll(amount)
            return f"Scrolled at ({x}, {y})"
        direction = str(action_args.get("direction", "down")).lower()
        amount = int(action_args.get("amount", 3) or 0)
        scroll_amount = -amount if direction == "down" else amount
        pyautogui.scroll(scroll_amount)
        return f"Scrolled {direction} at ({x}, {y})"

    if action == "wait":
        if "seconds" in action_args:
            seconds = float(action_args.get("seconds", 1) or 0)
        else:
            seconds = float(action_args.get("ms", 1000) or 0) / 1000
        time.sleep(max(0.0, seconds))
        return f"Waited {seconds:.2f}s"

    if action == "screenshot":
        return "Screenshot requested"

    return f"Unknown action: {action}"


def run_iteration_loop(
    max_iterations: int,
    step_handler: Callable[[int], bool],
    *,
    label: str = "Iteration",
    on_max_reached: str = "⚠️ Max iterations reached",
) -> tuple[bool, str | None]:
    for iteration in range(max_iterations):
        print(f"\\n[{label} {iteration + 1}]")
        if step_handler(iteration):
            return True, None
    print(f"\\n{on_max_reached}")
    return False, MAX_STEPS_EXCEEDED_REASON_CODE
