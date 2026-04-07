/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingTour from "./OnboardingTour";

describe("OnboardingTour", () => {
  let container: HTMLDivElement;
  let root: Root;
  let invoker: HTMLButtonElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    invoker = document.createElement("button");
    invoker.textContent = "open-tour";
    document.body.appendChild(invoker);
    document.body.appendChild(container);
    invoker.focus();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    invoker.remove();
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("traps focus and closes with Escape", () => {
    const onComplete = vi.fn();

    act(() => {
      root.render(<OnboardingTour active onComplete={onComplete} />);
    });

    const popover = document.querySelector<HTMLElement>(".tour-popover");
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".tour-popover button"),
    );
    const firstButton = buttons[0];
    const lastButton = buttons[buttons.length - 1];

    expect(popover).not.toBeNull();
    expect(firstButton).not.toBeUndefined();
    expect(lastButton).not.toBeUndefined();
    if (!popover || !firstButton || !lastButton) {
      throw new Error("Expected onboarding tour focus-trap elements to exist");
    }
    expect(popover.contains(document.activeElement)).toBe(true);

    lastButton.focus();
    act(() => {
      popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(firstButton);

    firstButton.focus();
    act(() => {
      popover.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(lastButton);

    act(() => {
      popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("restores focus to invoker when tour deactivates", () => {
    act(() => {
      root.render(<OnboardingTour active onComplete={() => {}} />);
    });
    expect(document.activeElement).not.toBe(invoker);

    act(() => {
      root.render(<OnboardingTour active={false} onComplete={() => {}} />);
    });
    expect(document.activeElement).toBe(invoker);
  });

  it("closes when pointer interaction lands outside the popover", () => {
    const onComplete = vi.fn();

    act(() => {
      root.render(<OnboardingTour active onComplete={onComplete} />);
    });

    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shows the guided tour in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(<OnboardingTour active locale="zh-CN" onComplete={() => {}} />);
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("步骤 1：先从目标开始，而不是先看房间列表");
    expect(text).toContain("稍后提醒我");
  });
});
