/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowEditableDraft } from "../types";
import FlowDraftEditor from "./FlowDraftEditor";

function createDraft(): FlowEditableDraft {
  return {
    start_url: "https://example.com",
    steps: [
      {
        step_id: "s1",
        action: "click",
        selected_selector_index: 0,
        target: { selectors: [{ kind: "css", value: "#submit", score: 80 }] },
      },
    ],
  };
}

describe("FlowDraftEditor resume controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("clicking resume calls onResumeFromStep without triggering row selection", () => {
    const onSelectStep = vi.fn();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onRunStep = vi.fn();
    const onResumeFromStep = vi.fn();

    act(() => {
      root.render(
        <FlowDraftEditor
          draft={createDraft()}
          selectedStepId=""
          onSelectStep={onSelectStep}
          onChange={onChange}
          onSave={onSave}
          onRunStep={onRunStep}
          onResumeFromStep={onResumeFromStep}
        />,
      );
    });

    const resumeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Resume",
    );
    expect(resumeButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      resumeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onResumeFromStep).toHaveBeenCalledTimes(1);
    expect(onResumeFromStep).toHaveBeenCalledWith("s1");
    expect(onSelectStep).not.toHaveBeenCalled();
  });

  it("renders the flow editor shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <FlowDraftEditor
          draft={createDraft()}
          locale="zh-CN"
          selectedStepId=""
          onSelectStep={() => {}}
          onChange={() => {}}
          onSave={() => {}}
          onRunStep={() => {}}
          onResumeFromStep={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("流程起始 URL");
    expect(text).toContain("添加步骤");
    expect(text).toContain("保存草稿");
    expect(text).toContain("继续");
  });
});
