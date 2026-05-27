import { expect } from "@playwright/test";
import {
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
  TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID,
  TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../../apps/command-center/src/constants/testIds";
import { bootstrapButtonBehaviorApp, buttonBehaviorCase } from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "nav-task-center-selected", assertion_type: "aria-selected" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const taskCenterTab = page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID);

    await taskCenterTab.click();

    await expect(taskCenterTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID)).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "taskcenter-template-runs-visible", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();

    const templateTab = page.getByTestId(TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID);
    const commandPanel = page.getByTestId(TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID);
    const templatePanel = page.getByTestId(TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID);

    await templateTab.click();

    await expect(templatePanel).toBeVisible();
    await expect(commandPanel).toBeHidden();
  },
);

buttonBehaviorCase(
  { case_id: "taskcenter-command-runs-visible", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();

    const commandTab = page.getByTestId(TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID);
    const templateTab = page.getByTestId(TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID);
    const commandPanel = page.getByTestId(TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID);
    const templatePanel = page.getByTestId(TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID);

    await templateTab.click();
    await commandTab.click();

    await expect(commandPanel).toBeVisible();
    await expect(templatePanel).toBeHidden();
  },
);

buttonBehaviorCase(
  { case_id: "tasklist-refresh", assertion_type: "text-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();

    await page.getByTestId("tasklist-refresh").click();

    await expect.poll(() => harness.calls.fetchTasks).toBeGreaterThan(1);
  },
);

buttonBehaviorCase(
  { case_id: "taskcenter-open-task-detail", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, {
      tasks: [
        {
          task_id: "task-running-001",
          command_id: "pipeline-run-demo",
          status: "running",
          requested_by: "tester",
          attempt: 1,
          max_attempts: 1,
          created_at: "2026-02-20T00:00:00.000Z",
          started_at: "2026-02-20T00:00:01.000Z",
          finished_at: null,
          exit_code: null,
          message: null,
          output_tail: "running",
        },
        {
          task_id: "task-success-002",
          command_id: "init-setup-demo",
          status: "success",
          requested_by: "tester",
          attempt: 1,
          max_attempts: 1,
          created_at: "2026-02-20T00:01:00.000Z",
          started_at: "2026-02-20T00:01:01.000Z",
          finished_at: "2026-02-20T00:01:03.000Z",
          exit_code: 0,
          message: "ok",
          output_tail: "done",
        },
      ],
    });
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();

    const taskButtons = page.getByTestId("task-item-open");
    await expect(taskButtons).toHaveCount(2);
    await taskButtons.nth(1).click();

    await expect(taskButtons.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(taskButtons.nth(0)).not.toHaveAttribute("aria-current", "true");
  },
);

buttonBehaviorCase(
  { case_id: "taskcenter-cancel-running-task", assertion_type: "text-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page, {
      tasks: [
        {
          task_id: "task-running-001",
          command_id: "pipeline-run-demo",
          status: "running",
          requested_by: "tester",
          attempt: 1,
          max_attempts: 1,
          created_at: "2026-02-20T00:00:00.000Z",
          started_at: "2026-02-20T00:00:01.000Z",
          finished_at: null,
          exit_code: null,
          message: null,
          output_tail: "running",
        },
      ],
    });
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();

    await page.getByTestId("task-item-cancel").click();

    await expect.poll(() => harness.calls.cancelTask).toBe(1);
    await expect(page.getByTestId("task-item-open").first().getByText("Cancelled")).toBeVisible();
  },
);
