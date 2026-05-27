/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID } from "../constants/testIds";
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

const createRun = (overrides: Partial<UniversalRun>): UniversalRun => ({
  run_id: "run-12345678",
  template_id: "tpl-12345678",
  status: "running",
  wait_context: null,
  step_cursor: 1,
  params: {},
  task_id: null,
  last_error: null,
  artifacts_ref: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  logs: [],
  ...overrides,
});

describe("TaskCenterView waiting state branches", () => {
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

  const renderRunView = (
    run: UniversalRun,
    onSubmitOtp = vi.fn(),
    locale: "en" | "zh-CN" = "en",
  ) => {
    act(() => {
      root.render(
        <TaskCenterView
          tasks={[sampleTask]}
          locale={locale}
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
          runs={[run]}
          selectedRunId={run.run_id}
          onSelectedRunIdChange={() => {}}
          otpCode=""
          onOtpCodeChange={() => {}}
          onSubmitOtp={onSubmitOtp}
          onGoToLaunch={() => {}}
        />,
      );
    });

    const templateTab = container.querySelector(
      `button[data-testid="${TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID}"]`,
    ) as HTMLButtonElement;
    expect(templateTab).not.toBeNull();
    act(() => {
      templateTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    return onSubmitOtp;
  };

  it("shows continue-only CTA for provider-protected waiting_user", () => {
    const run = createRun({
      status: "waiting_user",
      wait_context: { reason_code: "provider_protected_payment_step" },
    });
    const onSubmitOtp = renderRunView(run);

    expect(container.textContent).toContain("Latest lab result");
    expect(container.textContent).toContain("Runs & Blocks is the result desk for the latest browser experiment.");
    expect(container.textContent).toContain("Manual Gate inbox: 1 lab run(s) need operator help right now.");
    expect(container.textContent).toContain("Run #run-1234 \u00b7 Localhost-first target");
    expect(container.textContent).toContain(
      "This workflow run is paused on a protected provider step. Finish the check in the opened page, then resume from here.",
    );
    expect(container.textContent).toContain("The workflow run is paused and waiting for operator help.");
    expect(container.textContent).toContain(
      "This records approval for the current manual gate and asks the workflow run to continue from the saved checkpoint.",
    );
    expect(container.querySelector(".card-raised input")).toBeNull();
    const continueButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Resume after manual check",
    );
    expect(continueButton).not.toBeUndefined();

    act(() => {
      continueButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitOtp).toHaveBeenCalledWith(run.run_id, run.status, run.wait_context);
  });

  it("keeps supplemental input flow for non-provider waiting_user", () => {
    const run = createRun({
      status: "waiting_user",
      wait_context: { reason_code: "manual_input_required" },
      artifacts_ref: { summary: "reports/summary.json" },
    });
    renderRunView(run);

    expect(container.textContent).toContain("Next step: complete the manual gate on this page, then continue the saved checkpoint.");
    expect(container.textContent).toContain(
      "This workflow run is paused and waiting for additional input before it can continue.",
    );
    expect(container.textContent).toContain("Report surface");
    expect(container.textContent).toContain("reports/summary.json");
    expect(container.textContent).toContain(
      "This sends the requested input to the paused workflow run and asks it to continue from the saved checkpoint.",
    );
    const input = container.querySelector(".card-raised input") as HTMLInputElement | null;
    expect(input?.placeholder).toBe("Enter the requested input");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send input and resume",
    );
    expect(submitButton).not.toBeUndefined();
  });

  it("keeps otp input flow for waiting_otp", () => {
    const run = createRun({
      status: "waiting_otp",
      wait_context: { reason_code: "otp_required" },
    });
    renderRunView(run);

    expect(container.textContent).toContain("Next step: complete the manual gate on this page, then continue the saved checkpoint.");
    expect(container.textContent).toContain(
      "This workflow run is paused and waiting for a one-time code before it can continue.",
    );
    expect(container.textContent).toContain(
      "This sends the code to the paused workflow run and asks it to continue from the saved checkpoint.",
    );
    const input = container.querySelector(".card-raised input") as HTMLInputElement | null;
    const label = container.querySelector('label[for="run-waiting-input"]');
    expect(label?.textContent).toBe("OTP input");
    expect(input?.id).toBe("run-waiting-input");
    expect(input?.placeholder).toBe("Enter 4-8 digit OTP");
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send OTP and resume",
    );
    expect(submitButton).not.toBeUndefined();
  });

  it("renders the manual gate branch in Chinese when locale is zh-CN", () => {
    const run = createRun({
      status: "waiting_otp",
      wait_context: { reason_code: "otp_required" },
    });
    renderRunView(run, vi.fn(), "zh-CN");

    expect(container.textContent).toContain("最新实验结果");
    expect(container.textContent).toContain("人工闸门：恢复前需要先输入 OTP");
    expect(container.textContent).toContain("这条工作流运行已暂停，正在等待一次性验证码后才能继续。");
    expect(container.textContent).toContain("发送 OTP 并继续");
    const input = container.querySelector(".card-raised input") as HTMLInputElement | null;
    expect(input?.placeholder).toBe("输入 4-8 位 OTP");
  });
});
