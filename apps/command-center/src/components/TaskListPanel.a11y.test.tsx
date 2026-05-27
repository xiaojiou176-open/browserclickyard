/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../types";
import TaskListPanel from "./TaskListPanel";

const sampleTask: Task = {
  task_id: "task-123",
  command_id: "cmd-001",
  status: "running",
  requested_by: null,
  attempt: 1,
  max_attempts: 1,
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: null,
  exit_code: null,
  message: null,
  output_tail: "",
};

describe("TaskListPanel live region semantics", () => {
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

  it("uses polite live region for loading state", () => {
    act(() => {
      root.render(
        <TaskListPanel
          tasks={[]}
          taskState="loading"
          selectedTaskId=""
          taskErrorMessage=""
          onSelectTask={() => {}}
          onCancelTask={() => {}}
          onRefresh={() => {}}
          statusFilter="all"
          onStatusFilterChange={() => {}}
          commandFilter=""
          onCommandFilterChange={() => {}}
          taskLimit={20}
          onTaskLimitChange={() => {}}
        />,
      );
    });

    const loadingRegion = container.querySelector<HTMLElement>(".loading-card");
    expect(loadingRegion?.getAttribute("role")).toBe("status");
    expect(loadingRegion?.getAttribute("aria-live")).toBe("polite");
    expect(loadingRegion?.getAttribute("aria-atomic")).toBe("true");
    expect(container.textContent).toContain("Loading command runs");
    expect(container.textContent).toContain(
      "Waiting for the automation command lane to answer. When it responds, the newest command runs will appear here with the latest lab output.",
    );
  });

  it("uses assertive live region for error state", () => {
    act(() => {
      root.render(
        <TaskListPanel
          tasks={[sampleTask]}
          taskState="error"
          selectedTaskId={sampleTask.task_id}
          taskErrorMessage="The task list could not be loaded."
          onSelectTask={() => {}}
          onCancelTask={() => {}}
          onRefresh={() => {}}
          statusFilter="all"
          onStatusFilterChange={() => {}}
          commandFilter=""
          onCommandFilterChange={() => {}}
          taskLimit={20}
          onTaskLimitChange={() => {}}
        />,
      );
    });

    const errorRegions = Array.from(
      container.querySelectorAll<HTMLElement>('[role="alert"][aria-live="assertive"]'),
    );
    expect(errorRegions.length).toBeGreaterThan(0);
  });

  it("renders the task list shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <TaskListPanel
          tasks={[sampleTask]}
          locale="zh-CN"
          taskState="success"
          selectedTaskId={sampleTask.task_id}
          taskErrorMessage=""
          onSelectTask={() => {}}
          onCancelTask={() => {}}
          onRefresh={() => {}}
          statusFilter="all"
          onStatusFilterChange={() => {}}
          commandFilter=""
          onCommandFilterChange={() => {}}
          taskLimit={20}
          onTaskLimitChange={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("刷新");
    expect(text).toContain("全部状态");
    expect(text).toContain("运行中");
    expect(text).toContain("运行 #task-123");
  });
});
