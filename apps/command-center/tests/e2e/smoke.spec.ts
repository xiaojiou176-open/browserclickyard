import { expect, test } from "@playwright/test";
import {
  CONSOLE_TAB_FLOW_DRAFT_TEST_ID,
  CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
  TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID,
  TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../../src/constants/testIds";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/automation/commands") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          commands: [
            {
              command_id: "cmd-smoke-001",
              title: "Smoke command",
              description: "Used for frontend smoke coverage",
              tags: ["smoke"],
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname === "/api/automation/tasks") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/latest-flow") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session_id: null,
          start_url: null,
          generated_at: null,
          source_event_count: 0,
          step_count: 0,
          steps: [],
        }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/latest-flow-draft") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session_id: null, flow: null }),
      });
      return;
    }
    if (url.pathname === "/api/command-tower/evidence-timeline") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    if (url.pathname === "/api/flows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flows: [] }),
      });
      return;
    }
    if (url.pathname === "/api/templates") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ templates: [] }),
      });
      return;
    }
    if (url.pathname === "/api/runs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        tasks: [],
        flows: [],
        templates: [],
        runs: [],
        sessions: [],
      }),
    });
  });
  await page.route("**/health/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        uptime_seconds: 120,
        task_total: 0,
        task_counts: { queued: 0, running: 0, success: 0, failed: 0, cancelled: 0 },
        metrics: { requests_total: 1, rate_limited: 0 },
      }),
    });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("ab_onboarding_done", "1");
    window.localStorage.setItem("ab_first_use_done", "1");
  });
});

test("@smoke frontend shell and primary navigation", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Prooflane" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Quick Launch" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tablist", { name: "Command categories" })).toBeVisible();

  const quickLaunchTab = page.getByTestId(CONSOLE_TAB_QUICK_LAUNCH_TEST_ID);
  const taskCenterTab = page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID);
  const flowDraftTab = page.getByTestId(CONSOLE_TAB_FLOW_DRAFT_TEST_ID);

  await quickLaunchTab.click();
  await expect(quickLaunchTab).toHaveAttribute("aria-selected", "true");
  await expect(quickLaunchTab).toHaveAttribute("aria-controls", "app-view-launch-panel");
  await expect(page.locator("#app-view-launch-panel")).toBeVisible();

  await taskCenterTab.click();
  await expect(taskCenterTab).toHaveAttribute("aria-selected", "true");
  await expect(taskCenterTab).toHaveAttribute("aria-controls", "app-view-tasks-panel");

  const commandRunsTab = page.getByTestId(TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID);
  const templateRunsTab = page.getByTestId(TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID);
  const commandRunsPanel = page.getByTestId(TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID);
  const templateRunsPanel = page.getByTestId(TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID);

  await commandRunsTab.click();
  await expect(commandRunsPanel).toBeVisible();
  await expect(templateRunsPanel).toBeHidden();

  await templateRunsTab.click();
  await expect(templateRunsPanel).toBeVisible();
  await expect(commandRunsPanel).toBeHidden();

  await flowDraftTab.click();
  await expect(flowDraftTab).toHaveAttribute("aria-selected", "true");
  await expect(flowDraftTab).toHaveAttribute("aria-controls", "app-view-workshop-panel");
  await expect(page.locator("#app-view-workshop-panel")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Key result and next action" })).toBeVisible();
  await expect(page.getByText("Advanced workshop (optional): diagnostics, flow editing, and debugging evidence")).toBeVisible();

  const helpTrigger = page.getByRole("button", { name: "Help" });
  await helpTrigger.click();
  await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
  await page.getByRole("button", { name: "Close help panel" }).click();
  await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
  await expect(helpTrigger).toBeFocused();
});
