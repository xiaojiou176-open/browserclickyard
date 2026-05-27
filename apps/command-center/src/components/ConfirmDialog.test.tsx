/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmDialog from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let invoker: HTMLButtonElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    invoker = document.createElement("button");
    invoker.textContent = "open";
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

  it("restores focus to invoker after unmount", () => {
    const onCancel = vi.fn();

    act(() => {
      root.render(
        <ConfirmDialog
          title="Confirm deletion"
          message="Do you want to continue?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />,
      );
    });

    const cancelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.textContent === "Cancel",
    );
    expect(document.activeElement).toBe(cancelButton);

    act(() => {
      root.unmount();
    });

    expect(document.activeElement).toBe(invoker);
  });

  it("traps focus with tab and supports escape to cancel", () => {
    const onCancel = vi.fn();

    act(() => {
      root.render(
        <ConfirmDialog
          title="Confirm deletion"
          message="Do you want to continue?"
          onConfirm={() => {}}
          onCancel={onCancel}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const cancelButton = buttons.find((el) => el.textContent === "Cancel");
    const confirmButton = buttons.find((el) => el.textContent === "Confirm");
    const dialogBox = container.querySelector<HTMLDivElement>(".dialog-box");
    expect(cancelButton).not.toBeUndefined();
    expect(confirmButton).not.toBeUndefined();
    expect(dialogBox).not.toBeNull();
    if (!cancelButton || !confirmButton || !dialogBox) {
      throw new Error("Expected confirm dialog controls to exist");
    }

    confirmButton.focus();
    act(() => {
      dialogBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(cancelButton);

    cancelButton.focus();
    act(() => {
      dialogBox.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(confirmButton);

    act(() => {
      dialogBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the confirmation shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          locale="zh-CN"
          title="确认删除"
          message="你要继续吗？"
          confirmLabel="确认"
          cancelLabel="取消"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("确认删除");
    expect(text).toContain("取消");
    expect(text).toContain("确认");
    const overlay = container.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-overlay-close"]');
    expect(overlay?.getAttribute("aria-label")).toBe("关闭确认对话框");
  });
});
