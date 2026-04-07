/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ReconstructionReviewPanel from "./ReconstructionReviewPanel";

describe("ReconstructionReviewPanel", () => {
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders the reconstruction shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <ReconstructionReviewPanel
          locale="zh-CN"
          artifacts={{}}
          mode="gemini"
          strategy="strict"
          error=""
          profileResolved={null}
          preview={null}
          generated={null}
          onArtifactsChange={() => {}}
          onModeChange={() => {}}
          onStrategyChange={() => {}}
          onResolveProfile={() => {}}
          onPreview={() => {}}
          onGenerate={() => {}}
          onOrchestrate={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("重建审查");
    expect(text).toContain("session_dir 路径");
    expect(text).toContain("解析 Profile");
    expect(text).toContain("编排执行");
  });
});
