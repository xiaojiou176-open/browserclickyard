"""
Google Gemini Computer Use (Official API) - OS-level automation.

Uses Google's official Gemini Computer Use model to control the computer.
This is the OFFICIAL implementation.

Docs: https://ai.google.dev/gemini-api/docs/computer-use

Usage:
    export GEMINI_API_KEY="xxx"
    export GEMINI_MODEL="models/gemini-3.1-pro-preview"  # optional override
    export GEMINI_THINKING_LEVEL="high"                  # optional override
    python3 gemini-computer-use.py "your task description"
"""

import os
import sys
import time
import json
from typing import Optional

from runtime import (
    configure_runtime,
    execute_action,
    get_safety_confirmation_events,
    get_screen_size,
    reset_safety_confirmation_events,
    run_iteration_loop,
    take_screenshot_bytes,
)

try:
    from google import genai
    from google.genai import types
except ImportError:
    print("Please install: pip install google-genai")
    sys.exit(1)

configure_runtime(pause=0.3, failsafe=True)
SCREEN_WIDTH, SCREEN_HEIGHT = get_screen_size()
DEFAULT_MODEL = "models/gemini-3.1-pro-preview"
DEFAULT_THINKING_LEVEL = "high"
DEFAULT_MAX_STEPS = 50


def get_max_steps() -> int:
    raw_value = os.environ.get("AI_MAX_STEPS", "").strip()
    if not raw_value:
        return DEFAULT_MAX_STEPS
    try:
        parsed = int(raw_value)
    except ValueError:
        print(f"Warning: invalid AI_MAX_STEPS='{raw_value}', fallback to {DEFAULT_MAX_STEPS}")
        return DEFAULT_MAX_STEPS
    if parsed < 1:
        print(f"Warning: AI_MAX_STEPS must be >= 1, fallback to {DEFAULT_MAX_STEPS}")
        return DEFAULT_MAX_STEPS
    return parsed


def get_model_name() -> str:
    return os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def get_thinking_level() -> str:
    return os.environ.get("GEMINI_THINKING_LEVEL", "").strip().lower() or DEFAULT_THINKING_LEVEL


def build_generation_config(
    computer_use_tool: types.Tool, thinking_level: str
) -> types.GenerateContentConfig:
    config_kwargs: dict[str, object] = {
        "tools": [computer_use_tool],
        "temperature": 0,
        # Keep an explicit, observable thinking entry even if SDK-level ThinkingConfig is unavailable.
        "system_instruction": f"Use thinking_level={thinking_level} when planning next actions.",
    }

    thinking_config_cls = getattr(types, "ThinkingConfig", None)
    if thinking_config_cls is not None:
        try:
            config_kwargs["thinking_config"] = thinking_config_cls(thinking_level=thinking_level)
        except Exception as exc:  # pragma: no cover - depends on SDK version behavior
            print(f"Warning: failed to apply thinking_config with level '{thinking_level}': {exc}")

    return types.GenerateContentConfig(**config_kwargs)


def run_computer_use(
    task: str,
    api_key: str,
    max_iterations: int = 50,
    model_name: Optional[str] = None,
    thinking_level: Optional[str] = None,
):
    """Run the Gemini Computer Use loop."""
    client = genai.Client(api_key=api_key)
    selected_model = model_name or get_model_name()
    selected_thinking_level = thinking_level or get_thinking_level()

    print(f"Screen: {SCREEN_WIDTH}x{SCREEN_HEIGHT}")
    print(f"Task: {task}")
    print(f"Model: {selected_model}")
    print(f"Thinking level: {selected_thinking_level}")
    print("-" * 60)

    computer_use_tool = types.Tool(
        computer_use=types.ToolComputerUse(
            environment="mac",
            display_width=SCREEN_WIDTH,
            display_height=SCREEN_HEIGHT,
        )
    )

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part(text=f"[thinking_level={selected_thinking_level}] {task}"),
                types.Part(
                    inline_data=types.Blob(mime_type="image/png", data=take_screenshot_bytes())
                ),
            ],
        )
    ]
    generation_config = build_generation_config(computer_use_tool, selected_thinking_level)

    reset_safety_confirmation_events()

    def step_handler(_iteration: int) -> bool:
        nonlocal contents

        response = client.models.generate_content(
            model=selected_model,
            contents=contents,
            config=generation_config,
        )

        if not response.candidates:
            print("No response from model")
            return True

        candidate = response.candidates[0]

        function_calls = []
        text_parts = []

        for part in candidate.content.parts:
            if hasattr(part, "function_call") and part.function_call:
                function_calls.append(part.function_call)
            elif hasattr(part, "text") and part.text:
                text_parts.append(part.text)

        for text in text_parts:
            print(f"Model: {text[:200]}...")

        if not function_calls:
            print("\n✅ No more actions. Task may be completed!")
            return True

        function_responses = []
        for fc in function_calls:
            action_name = fc.name
            action_args = dict(fc.args) if fc.args else {}
            runtime_action_name = str(action_args.get("action", "")).strip() or action_name

            print(f"Action: {runtime_action_name} {action_args}")
            result = execute_action(
                action_name=runtime_action_name,
                action_args=action_args,
                screen_width=SCREEN_WIDTH,
                screen_height=SCREEN_HEIGHT,
                typing_interval=0.02,
                redact_typed_text=False,
            )
            print(f"Result: {result}")

            function_responses.append(
                types.Part(
                    function_response=types.FunctionResponse(
                        name=action_name,
                        response={"result": result},
                    )
                )
            )

        time.sleep(0.5)

        contents.append(candidate.content)
        contents.append(
            types.Content(
                role="user",
                parts=function_responses
                + [
                    types.Part(
                        inline_data=types.Blob(mime_type="image/png", data=take_screenshot_bytes())
                    )
                ],
            )
        )

        return False

    completed, reason_code = run_iteration_loop(max_iterations, step_handler, label="Iteration")
    safety_events = get_safety_confirmation_events()
    print(
        "COMPUTER_USE_SAFETY_SUMMARY="
        + json.dumps(
            {
                "computerUseSafetyConfirmations": len(safety_events),
                "events": safety_events,
            },
            ensure_ascii=False,
        )
    )
    if reason_code:
        print(f"COMPUTER_USE_REASON_CODE={reason_code}")
    return {"completed": completed, "reasonCode": reason_code}


if __name__ == "__main__":
    print("=" * 60)
    print("Google Gemini Computer Use (Official API)")
    print("=" * 60)
    print("\n⚠️ SAFETY: Move mouse to top-left corner to abort!\n")

    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        api_key = input("Enter GEMINI_API_KEY: ").strip()

    if not api_key:
        print("Error: GEMINI_API_KEY is required")
        sys.exit(1)

    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    else:
        task = input("Enter task: ").strip()

    if not task:
        task = "Please analyze the current screen and describe what you see."

    print(f"\nTask: {task}")
    print(f"Model: {get_model_name()}")
    print(f"Thinking level: {get_thinking_level()}")
    print(
        "High-risk actions gate: set COMPUTER_USE_CONFIRM_HIGH_RISK=true to allow delete/pay/send/purchase/submit."
    )
    print("\nMake sure the target window is visible on screen.")
    input("Press Enter to start...")

    max_steps = get_max_steps()
    print(f"Max steps: {max_steps}")
    run_result = run_computer_use(task, api_key, max_iterations=max_steps)
    if not run_result.get("completed", False):
        reason_code = str(run_result.get("reasonCode") or "ai.gemini.computer_use.execution_failed")
        if not run_result.get("reasonCode"):
            print(f"COMPUTER_USE_REASON_CODE={reason_code}")
        sys.exit(2)
