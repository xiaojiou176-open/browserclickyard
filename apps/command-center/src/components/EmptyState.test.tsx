/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmptyState from "./EmptyState";

describe("EmptyState", () => {
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

  it("renders title only when optional fields are absent", () => {
    act(() => {
      root.render(<EmptyState title="No data yet" />);
    });

    expect(container.querySelector(".empty-state-title")?.textContent).toBe("No data yet");
    expect(container.querySelector(".empty-state-icon")).toBeNull();
    expect(container.querySelector(".empty-state-desc")).toBeNull();
    expect(container.querySelector(".empty-state-action")).toBeNull();
  });

  it("renders optional icon/description/action and triggers action click", () => {
    const onClick = vi.fn();

    act(() => {
      root.render(
        <EmptyState
          icon={<span data-testid="icon">!</span>}
          title="Completed"
          description="No more items"
          action={{ label: "Refresh", onClick }}
        />,
      );
    });

    expect(container.querySelector('[data-testid="icon"]')).toBeInstanceOf(HTMLSpanElement);
    expect(container.querySelector(".empty-state-desc")?.textContent).toBe("No more items");

    const button = container.querySelector<HTMLButtonElement>("button");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
