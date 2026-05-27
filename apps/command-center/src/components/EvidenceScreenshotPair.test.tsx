/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import EvidenceScreenshotPair from "./EvidenceScreenshotPair";

describe("EvidenceScreenshotPair", () => {
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

  it("shows before/after screenshot blocks when image urls are provided", () => {
    act(() => {
      root.render(
        <EvidenceScreenshotPair
          beforeImageUrl="/before.png"
          afterImageUrl="/after.png"
          beforeAlt="before image"
          afterAlt="after image"
        />,
      );
    });

    expect(container.querySelector('img[alt="before image"]')).toBeInstanceOf(HTMLImageElement);
    expect(container.querySelector('img[alt="after image"]')).toBeInstanceOf(HTMLImageElement);
    expect(container.textContent).toContain("Before execution");
    expect(container.textContent).toContain("After execution");
  });

  it("renders empty hint when no screenshot exists", () => {
    act(() => {
      root.render(
        <EvidenceScreenshotPair
          beforeImageUrl={null}
          afterImageUrl={undefined}
          beforeAlt="before image"
          afterAlt="after image"
          emptyHint="No screenshots yet"
        />,
      );
    });

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("No screenshots yet");
  });

  it("uses Chinese default labels when locale is zh-CN", () => {
    act(() => {
      root.render(
        <EvidenceScreenshotPair
          locale="zh-CN"
          beforeImageUrl="/before.png"
          afterImageUrl="/after.png"
          beforeAlt="before image"
          afterAlt="after image"
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("执行前");
    expect(text).toContain("执行后");
  });
});
