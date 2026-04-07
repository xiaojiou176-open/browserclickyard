/* @vitest-environment jsdom */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TASK_CENTER_DETAIL_COLUMN_TEST_ID,
  TASK_CENTER_LIST_COLUMN_TEST_ID,
  TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID,
  TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../constants/testIds";
import type { Task, UniversalRun } from "../types";
import TaskCenterView from "./TaskCenterView";

vi.mock("../components/TaskListPanel", () => ({
  default: () => <div data-testid="mock-task-list-panel" />,
}));

vi.mock("../components/TerminalPanel", () => ({
  default: () => <div data-testid="mock-terminal-panel" />,
}));

vi.mock("../components/EmptyState", () => ({
  default: () => <div data-testid="mock-empty-state" />,
}));

const sampleRun: UniversalRun = {
  run_id: "run-12345678",
  template_id: "tpl-12345678",
  status: "running",
  step_cursor: 1,
  params: {},
  task_id: null,
  last_error: null,
  artifacts_ref: { summary: "reports/summary.json" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  logs: [],
};

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

describe("TaskCenterView accessibility contract", () => {
  it("binds sub-tabs to tabpanels and keeps listbox options free of nested buttons", () => {
    const { container } = render(
      <TaskCenterView
        tasks={[sampleTask]}
        taskState="success"
        selectedTaskId={sampleTask.task_id}
        taskErrorMessage=""
        onSelectTask={() => {}}
        onCancelTask={() => {}}
        onRefreshTasks={() => {}}
        statusFilter="all"
        onStatusFilterChange={() => {}}
        commandFilter=""
        onCommandFilterChange={() => {}}
        taskLimit={20}
        onTaskLimitChange={() => {}}
        logs={[]}
        selectedTask={sampleTask}
        terminalRows={8}
        onTerminalRowsChange={() => {}}
        terminalFilter="all"
        onTerminalFilterChange={() => {}}
        autoScroll
        onAutoScrollChange={() => {}}
        onClearLogs={() => {}}
        runs={[sampleRun]}
        selectedRunId={sampleRun.run_id}
        onSelectedRunIdChange={() => {}}
        otpCode=""
        onOtpCodeChange={() => {}}
        onSubmitOtp={() => {}}
        onGoToLaunch={() => {}}
      />,
    );
    const html = container.innerHTML;

    expect(html).toContain('id="app-view-tasks-panel"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="console-tab-tasks"');

    expect(html).toContain(`data-testid="${TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID}"`);
    expect(html).toContain(`data-testid="${TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID}"`);
    expect(html).toContain("Command queue");
    expect(html).toContain("Lab runs");
    expect(html).toContain("Latest lab result");
    expect(html).toContain("Runs &amp; Blocks is the result desk for the latest browser experiment.");
    expect(html).toContain("No lab run is waiting for operator input right now.");
    expect(html).toContain("Report surface");
    expect(html).toContain("reports/summary.json");
    expect(html).toContain("Target");
    expect(html).toContain("Localhost-first target");
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-label="Runs and Blocks lanes"');
    expect(html).toContain('aria-controls="task-center-panel-command-runs"');
    expect(html).toContain('aria-controls="task-center-panel-template-runs"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');

    expect(html).toContain(`data-testid="${TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID}"`);
    expect(html).toContain(`data-testid="${TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID}"`);
    expect(html).toContain('id="task-center-panel-command-runs"');
    expect(html).toContain('id="task-center-panel-template-runs"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('hidden=""');
    expect(html).toContain(`data-testid="${TASK_CENTER_LIST_COLUMN_TEST_ID}"`);
    expect(html).toContain(`data-testid="${TASK_CENTER_DETAIL_COLUMN_TEST_ID}"`);

    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="Lab run list (templates)"');
    expect(html).toContain('aria-activedescendant="task-center-template-option-run-12345678"');
    expect(html).toContain('id="task-center-template-option-run-12345678"');
    expect(html).toContain('role="option"');
    expect(html).not.toContain('role="option"><button');
  });
});
