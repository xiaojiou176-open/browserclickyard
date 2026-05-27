/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HelpPanel from "./HelpPanel";

const LANE_MAP_SUMMARY =
  "Start with a target URL in Stress Lab, choose the kind of browser experiment you want to run, inspect the latest result in Runs & Blocks, and open Advanced Review only when you need deeper governed comparison.";

const RECOMMENDED_FIRST_PATH =
  "Recommended first path: enter a URL, choose a lab mode, run the experiment, then inspect the latest result before opening Advanced Review.";

describe("HelpPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let invoker: HTMLButtonElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    invoker = document.createElement("button");
    invoker.textContent = "open-help";
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
    const onClose = vi.fn();

    act(() => {
      root.render(<HelpPanel activeView="launch" onClose={onClose} onRestartTour={() => {}} />);
    });

    const panel = container.querySelector<HTMLElement>(".help-panel");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const closeButton = buttons.find(
      (element) => element.getAttribute("aria-label") === "Close help panel",
    );
    const lastButton = buttons[buttons.length - 1];
    expect(panel).not.toBeNull();
    expect(closeButton).not.toBeUndefined();
    expect(lastButton).not.toBeUndefined();
    if (!panel || !closeButton || !lastButton) {
      throw new Error("Expected help panel focus-trap elements to exist");
    }
    expect(document.activeElement).toBe(closeButton);

    lastButton.focus();
    act(() => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(lastButton);

    act(() => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to invoker after unmount", () => {
    act(() => {
      root.render(<HelpPanel activeView="launch" onClose={() => {}} onRestartTour={() => {}} />);
    });
    expect(document.activeElement).not.toBe(invoker);

    act(() => {
      root.unmount();
    });
    expect(document.activeElement).toBe(invoker);
  });

  it("shows the shared stress-lab path and advanced review help", () => {
    act(() => {
      root.render(<HelpPanel activeView="review" onClose={() => {}} onRestartTour={() => {}} />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain(LANE_MAP_SUMMARY);
    expect(text).toContain(RECOMMENDED_FIRST_PATH);
    expect(text).toContain("Advanced Review");
    expect(text).toContain("proof bundles, AI summaries, or historical comparison");
  });

  it("switches the shared help shell into Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <HelpPanel
          activeView="tasks"
          locale="zh-CN"
          onClose={() => {}}
          onRestartTour={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("帮助");
    expect(text).toContain("压力实验路径");
    expect(text).toContain("先读结果再反应");
  });
});
