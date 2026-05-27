/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LogStream from "./LogStream";

describe("LogStream", () => {
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

  it("renders logs with uppercase tag and message", () => {
    act(() => {
      root.render(
        <LogStream
          logs={[
            { ts: "2026-02-25T01:02:03.000Z", level: "info", message: "Startup complete" },
            { ts: "2026-02-25T01:03:04.000Z", level: "warn", message: "Retry detected" },
          ]}
        />,
      );
    });

    const tags = Array.from(container.querySelectorAll(".log-tag")).map((el) => el.textContent);
    expect(tags).toEqual(["[INFO]", "[WARN]"]);
    expect(container.textContent).toContain("Startup complete");
    expect(container.textContent).toContain("Retry detected");
  });

  it("applies custom maxHeight style", () => {
    act(() => {
      root.render(<LogStream logs={[]} maxHeight="360px" />);
    });

    const stream = container.querySelector<HTMLDivElement>(".terminal-body");
    expect(stream?.style.maxHeight).toBe("360px");
  });
});
