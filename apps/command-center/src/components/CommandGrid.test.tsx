/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../types";
import CommandGrid from "./CommandGrid";

function createCommands(): Command[] {
  return [
    {
      command_id: "script-pipeline-full-midscene",
      title: "Smart run",
      description: "Use AI to execute the flow",
      tags: ["pipeline", "ai"],
    },
    {
      command_id: "clean",
      title: "Clear cache",
      description: "delete temporary cache files",
      tags: ["maintenance"],
    },
    {
      command_id: "backend-test",
      title: "Backend test",
      description: "run backend tests",
      tags: ["backend"],
    },
  ];
}

describe("CommandGrid", () => {
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

  it("renders category counts and AI badge for ai command", () => {
    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="success"
          activeTab="all"
          submittingId=""
          feedbackText=""
          onActiveTabChange={() => {}}
          onRunCommand={() => {}}
        />,
      );
    });

    const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".category-tab"));
    const allTab = tabButtons.find((btn) => btn.textContent?.includes("All"));
    const pipelineTab = tabButtons.find((btn) => btn.textContent?.includes("Pipeline"));
    const maintenanceTab = tabButtons.find((btn) => btn.textContent?.includes("Maintenance"));

    expect(allTab?.querySelector(".cat-count")?.textContent).toBe("3");
    expect(pipelineTab?.querySelector(".cat-count")?.textContent).toBe("1");
    expect(maintenanceTab?.querySelector(".cat-count")?.textContent).toBe("1");
    expect(allTab?.getAttribute("role")).toBe("tab");
    expect(allTab?.getAttribute("aria-controls")).toBe("command-category-panel");
    expect(allTab?.getAttribute("id")).toBe("command-category-tab-all");
    expect(allTab?.getAttribute("tabindex")).toBe("0");

    const panel = container.querySelector<HTMLElement>("#command-category-panel");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe("command-category-tab-all");
    expect(panel?.getAttribute("aria-busy")).toBe("false");

    const aiBadge = Array.from(container.querySelectorAll(".ui-badge")).find(
      (badge) => badge.textContent === "AI",
    );
    expect(aiBadge).toBeInstanceOf(HTMLSpanElement);
  });

  it("shows destructive action variant and blocks click while command is submitting", () => {
    const onRunCommand = vi.fn();

    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="success"
          activeTab="all"
          submittingId="clean"
          feedbackText=""
          onActiveTabChange={() => {}}
          onRunCommand={onRunCommand}
        />,
      );
    });

    const cardForClean = Array.from(container.querySelectorAll(".command-card")).find((card) =>
      card.textContent?.includes("Clear cache"),
    );
    const cleanButton = cardForClean?.querySelector<HTMLButtonElement>("button");
    expect(cleanButton?.textContent).toBe("Running...");
    expect(cleanButton?.className.includes("ui-btn--destructive")).toBe(true);
    expect(cleanButton?.disabled).toBe(true);

    act(() => {
      cleanButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRunCommand).not.toHaveBeenCalled();
  });

  it("marks panel busy when command list is loading", () => {
    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="loading"
          activeTab="all"
          submittingId=""
          feedbackText=""
          onActiveTabChange={() => {}}
          onRunCommand={() => {}}
        />,
      );
    });

    const panel = container.querySelector<HTMLElement>("#command-category-panel");
    expect(panel?.getAttribute("aria-busy")).toBe("true");
    const loadingRegion = container.querySelector<HTMLElement>(".loading-card");
    expect(loadingRegion?.getAttribute("role")).toBe("status");
    expect(loadingRegion?.getAttribute("aria-live")).toBe("polite");
    expect(loadingRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(container.textContent).toContain("Loading lab commands");
    expect(container.textContent).toContain(
      "Waiting for the backend command catalog. When it responds, choose a card to start a new command run.",
    );
  });

  it("announces command loading errors with assertive live region", () => {
    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="error"
          activeTab="all"
          submittingId=""
          feedbackText="Loading the command list failed"
          onActiveTabChange={() => {}}
          onRunCommand={() => {}}
        />,
      );
    });

    const errorRegion = container.querySelector<HTMLElement>(".loading-card");
    expect(errorRegion?.getAttribute("role")).toBe("alert");
    expect(errorRegion?.getAttribute("aria-live")).toBe("assertive");
    expect(errorRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(errorRegion?.textContent).toContain("Loading the command list failed");
  });

  it("filters by active tab and sends selected tab when user clicks category", () => {
    const onActiveTabChange = vi.fn();

    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="success"
          activeTab="backend"
          submittingId=""
          feedbackText=""
          onActiveTabChange={onActiveTabChange}
          onRunCommand={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Backend test");
    expect(container.textContent).not.toContain("Smart run");

    const automationTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".category-tab"),
    ).find((btn) => btn.textContent?.includes("Automation"));

    act(() => {
      automationTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onActiveTabChange).toHaveBeenCalledTimes(1);
    expect(onActiveTabChange).toHaveBeenCalledWith("automation");
  });

  it("shows empty hint when selected category has no commands", () => {
    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          commandState="success"
          activeTab="frontend"
          submittingId=""
          feedbackText=""
          onActiveTabChange={() => {}}
          onRunCommand={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("No commands in this category yet");
    expect(container.textContent).toContain(
      "Try All to browse the full catalog, or switch categories to find a different launch path.",
    );
  });

  it("renders the command grid shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <CommandGrid
          commands={createCommands()}
          locale="zh-CN"
          commandState="success"
          activeTab="all"
          submittingId=""
          feedbackText=""
          onActiveTabChange={() => {}}
          onRunCommand={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("全部");
    expect(text).toContain("能力驱动的实验命令");
    expect(text).toContain("流水线");
    expect(text).toContain("危险运行");
  });
});
