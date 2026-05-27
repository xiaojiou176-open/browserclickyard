/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types";
import TerminalPanel from "./TerminalPanel";

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

describe("TerminalPanel", () => {
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

  it("renders the terminal shell in Chinese when locale is zh-CN", () => {
    act(() => {
      root.render(
        <TerminalPanel
          locale="zh-CN"
          logs={[]}
          selectedTask={sampleTask}
          terminalRows={8}
          onTerminalRowsChange={() => {}}
          terminalFilter="all"
          onTerminalFilterChange={() => {}}
          autoScroll
          onAutoScrollChange={() => {}}
          onClear={() => {}}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("终端");
    expect(text).toContain("高度");
    expect(text).toContain("自动滚动");
    expect(text).toContain("终端日志为空");
    const footer = container.querySelector(".terminal-sub");
    expect(footer?.getAttribute("aria-label")).toBe("当前任务输出");
  });
});
