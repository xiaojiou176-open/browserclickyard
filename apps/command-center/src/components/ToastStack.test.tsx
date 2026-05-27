/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToastStack from "./ToastStack";

describe("ToastStack", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders nothing when notices are empty", () => {
    act(() => {
      root.render(<ToastStack notices={[]} onDismiss={() => {}} />);
    });

    expect(container.innerHTML).toBe("");
  });

  it("renders notices and dismisses by click", () => {
    const onDismiss = vi.fn();

    act(() => {
      root.render(
        <ToastStack
          notices={[
            { id: "1", level: "warn", message: "Needs attention" },
            { id: "2", level: "success", message: "Run succeeded" },
          ]}
          onDismiss={onDismiss}
        />,
      );
    });

    const items = Array.from(container.querySelectorAll<HTMLDivElement>(".toast-item"));
    expect(items).toHaveLength(2);
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Run succeeded");

    act(() => {
      items[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(0);
    act(() => {
      vi.advanceTimersByTime(170);
    });
    expect(onDismiss).toHaveBeenNthCalledWith(1, "1");

    expect(items[1]?.tagName).toBe("BUTTON");
    act(() => {
      items[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(170);
    });
    expect(onDismiss).toHaveBeenNthCalledWith(2, "2");

    act(() => {
      items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("localizes the toast aria shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <ToastStack
          locale="zh-CN"
          notices={[{ id: "1", level: "warn", message: "需要关注" }]}
          onDismiss={() => {}}
        />,
      );
    });

    const stack = container.querySelector(".toast-stack");
    const item = container.querySelector<HTMLButtonElement>(".toast-item");
    expect(stack?.getAttribute("aria-label")).toBe("通知列表");
    expect(item?.getAttribute("aria-label")).toContain("关闭通知");
  });
});
