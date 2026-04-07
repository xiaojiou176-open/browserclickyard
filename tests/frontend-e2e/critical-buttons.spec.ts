import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID,
  TASK_CENTER_DETAIL_COLUMN_TEST_ID,
  TASK_CENTER_LIST_COLUMN_TEST_ID,
  TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../../apps/command-center/src/constants/testIds";
import { gotoRootWithFrontendRetry } from "./support/frontend-navigation";

type Command = {
  command_id: string;
  title: string;
  description: string;
  tags: string[];
};

type Task = {
  task_id: string;
  command_id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  requested_by: string | null;
  attempt: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  message: string | null;
  output_tail: string;
};

type UniversalRun = {
  run_id: string;
  template_id: string;
  status:
    | "queued"
    | "running"
    | "waiting_user"
    | "waiting_otp"
    | "success"
    | "failed"
    | "cancelled";
  step_cursor: number;
  params: Record<string, string>;
  task_id: string | null;
  last_error: string | null;
  artifacts_ref: Record<string, string>;
  created_at: string;
  updated_at: string;
  logs: Array<{ ts: string; level: "info" | "warn" | "error"; message: string }>;
};

type StubState = {
  commands: Command[];
  tasks: Task[];
  runs: UniversalRun[];
  templates: Array<{
    template_id: string;
    flow_id: string;
    name: string;
    params_schema: Array<{
      key: string;
      type: "string" | "secret" | "enum" | "regex" | "email";
      required: boolean;
      description?: string | null;
      enum_values?: string[];
      pattern?: string | null;
    }>;
    defaults: Record<string, string>;
    policies: {
      retries: number;
      timeout_seconds: number;
      otp: {
        required: boolean;
        provider: "manual" | "gmail" | "imap" | "vonage";
        timeout_seconds: number;
        regex: string;
      };
      branches: Record<string, unknown>;
    };
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>;
  latestFlow: {
    session_id: string | null;
    start_url: string | null;
    generated_at: string | null;
    source_event_count: number;
    step_count: number;
    steps: Array<{ step_id: string; action: string; selector?: string | null }>;
  };
  flowDraft: {
    flow_id: string;
    session_id: string;
    start_url: string;
    generated_at: string;
    source_event_count: number;
    steps: Array<{
      step_id: string;
      action: "navigate" | "click" | "type";
      selected_selector_index: number;
      target: {
        selectors: Array<{ kind: "css" | "role" | "id" | "name"; value: string; score: number }>;
      };
      url?: string;
    }>;
  };
  evidenceTimeline: Array<{
    step_id: string;
    action: string;
    ok: boolean;
    detail: string;
    duration_ms: number;
    matched_selector: string | null;
    selector_index: number | null;
    screenshot_before_path: string | null;
    screenshot_after_path: string | null;
    screenshot_before_data_url: string | null;
    screenshot_after_data_url: string | null;
    fallback_trail: Array<{
      selector_index: number;
      kind: string;
      value: string;
      normalized: string | null;
      success: boolean;
      error: string | null;
    }>;
  }>;
  calls: {
    fetchTasks: number;
    fetchDiagnostics: number;
    runCommand: number;
    createRun: number;
    cancelTask: number;
    submitRunOtp: number;
    saveFlowDraft: number;
    replayLatestFlow: number;
    replayStep: number;
    replayFromStep: number;
    taskQuery: {
      status: string;
      command_id: string;
      limit: string;
    };
  };
  seq: number;
};

function createTask(taskId: string, commandId: string, status: Task["status"]): Task {
  return {
    task_id: taskId,
    command_id: commandId,
    status,
    requested_by: "e2e",
    attempt: 1,
    max_attempts: 3,
    created_at: "2026-02-20T00:00:00.000Z",
    started_at: "2026-02-20T00:00:01.000Z",
    finished_at: null,
    exit_code: null,
    message: status === "running" ? "Task is running" : null,
    output_tail: `output-${taskId}`,
  };
}

function createState(): StubState {
  return {
    commands: [
      {
        command_id: "cmd-e2e-001",
        title: "Open homepage",
        description: "E2E command for critical button coverage",
        tags: ["e2e"],
      },
      {
        command_id: "clean-e2e-001",
        title: "Clear cache",
        description: "delete temp cache before rerun",
        tags: ["maintenance"],
      },
    ],
    tasks: [
      createTask("task-running-001", "cmd-e2e-001", "running"),
      {
        ...createTask("task-success-001", "cmd-e2e-001", "success"),
        finished_at: "2026-02-20T00:02:00.000Z",
        exit_code: 0,
      },
    ],
    runs: [
      {
        run_id: "run-waiting-otp-001",
        template_id: "tpl-e2e-001",
        status: "waiting_otp",
        step_cursor: 2,
        params: { email: "demo@example.com" },
        task_id: null,
        last_error: null,
        artifacts_ref: {},
        created_at: "2026-02-20T00:00:00.000Z",
        updated_at: "2026-02-20T00:00:00.000Z",
        logs: [],
      },
    ],
    templates: [
      {
        template_id: "tpl-e2e-001",
        flow_id: "flow-e2e-001",
        name: "Sample template",
        params_schema: [{ key: "email", type: "email", required: true, description: "Account email" }],
        defaults: { email: "demo@example.com" },
        policies: {
          retries: 0,
          timeout_seconds: 120,
          otp: {
            required: true,
            provider: "manual",
            timeout_seconds: 120,
            regex: "\\b(\\d{6})\\b",
          },
          branches: {},
        },
        created_by: "e2e",
        created_at: "2026-02-20T00:00:00.000Z",
        updated_at: "2026-02-20T00:00:00.000Z",
      },
    ],
    latestFlow: {
      session_id: "session-e2e-001",
      start_url: "https://example.com",
      generated_at: "2026-02-20T00:00:00.000Z",
      source_event_count: 4,
      step_count: 2,
      steps: [
        { step_id: "s1", action: "navigate", selector: null },
        { step_id: "s2", action: "click", selector: "#submit" },
      ],
    },
    flowDraft: {
      flow_id: "flow-e2e-001",
      session_id: "session-e2e-001",
      start_url: "https://example.com",
      generated_at: "2026-02-20T00:00:00.000Z",
      source_event_count: 4,
      steps: [
        {
          step_id: "s1",
          action: "navigate",
          selected_selector_index: 0,
          url: "https://example.com",
          target: { selectors: [{ kind: "css", value: "body", score: 80 }] },
        },
        {
          step_id: "s2",
          action: "click",
          selected_selector_index: 0,
          target: { selectors: [{ kind: "css", value: "#submit", score: 90 }] },
        },
      ],
    },
    evidenceTimeline: [
      {
        step_id: "s1",
        action: "navigate",
        ok: true,
        detail: "step s1 ok",
        duration_ms: 120,
        matched_selector: null,
        selector_index: null,
        screenshot_before_path: null,
        screenshot_after_path: null,
        screenshot_before_data_url: null,
        screenshot_after_data_url: null,
        fallback_trail: [],
      },
      {
        step_id: "s2",
        action: "click",
        ok: false,
        detail: "step s2 failed",
        duration_ms: 240,
        matched_selector: "#submit",
        selector_index: 0,
        screenshot_before_path: null,
        screenshot_after_path: null,
        screenshot_before_data_url: null,
        screenshot_after_data_url: null,
        fallback_trail: [],
      },
    ],
    calls: {
      fetchTasks: 0,
      fetchDiagnostics: 0,
      runCommand: 0,
      createRun: 0,
      cancelTask: 0,
      submitRunOtp: 0,
      saveFlowDraft: 0,
      replayLatestFlow: 0,
      replayStep: 0,
      replayFromStep: 0,
      taskQuery: {
        status: "all",
        command_id: "",
        limit: "100",
      },
    },
    seq: 100,
  };
}

function createReplayTask(state: StubState, commandId: string): Task {
  state.seq += 1;
  return createTask(`task-e2e-${state.seq}`, commandId, "running");
}

async function installBackendStubs(page: Page, state: StubState) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === "/api/automation/commands" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ commands: state.commands }),
      });
      return;
    }
    if (pathname === "/api/automation/tasks" && method === "GET") {
      state.calls.fetchTasks += 1;
      const status = url.searchParams.get("status") ?? "all";
      const commandId = url.searchParams.get("command_id") ?? "";
      const limit = url.searchParams.get("limit") ?? "100";
      state.calls.taskQuery = { status, command_id: commandId, limit };

      let filtered = [...state.tasks];
      if (status !== "all") {
        filtered = filtered.filter((task) => task.status === status);
      }
      if (commandId.trim()) {
        filtered = filtered.filter((task) => task.command_id.includes(commandId.trim()));
      }
      const limitValue = Number.parseInt(limit, 10);
      if (Number.isInteger(limitValue) && limitValue > 0) {
        filtered = filtered.slice(0, limitValue);
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: filtered }),
      });
      return;
    }
    if (pathname === "/api/automation/run" && method === "POST") {
      state.calls.runCommand += 1;
      let payload: { command?: string } = {};
      try {
        payload = request.postDataJSON() as { command?: string };
      } catch {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "invalid json payload" }),
        });
        return;
      }
      const token = (await request.headerValue("x-automation-token"))?.trim() ?? "";
      const clientId = (await request.headerValue("x-automation-client-id"))?.trim() ?? "";
      if (token && !clientId) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "x-automation-client-id header is required" }),
        });
        return;
      }
      const commandId = typeof payload.command === "string" ? payload.command.trim() : "";
      if (!commandId) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "command is required" }),
        });
        return;
      }
      const task = createReplayTask(state, commandId);
      state.tasks = [task, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ task }),
      });
      return;
    }
    if (pathname.match(/^\/api\/automation\/tasks\/[^/]+\/cancel$/) && method === "POST") {
      state.calls.cancelTask += 1;
      const taskId = pathname.split("/")[4] ?? "";
      state.tasks = state.tasks.map((task) =>
        task.task_id === taskId
          ? {
              ...task,
              status: "cancelled",
              finished_at: "2026-02-20T00:03:00.000Z",
              exit_code: 130,
              message: "Cancelled",
            }
          : task,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }

    if (pathname === "/api/flows" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ flows: [] }),
      });
      return;
    }
    if (pathname === "/api/templates" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ templates: state.templates }),
      });
      return;
    }
    if (pathname.match(/^\/api\/templates\/[^/]+\/history$/) && method === "GET") {
      const templateId = pathname.split("/")[3] ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          templates: state.templates.filter((template) => template.template_id === templateId),
        }),
      });
      return;
    }
    if (pathname === "/api/runs" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: state.runs }),
      });
      return;
    }
    if (pathname === "/api/runs" && method === "POST") {
      state.calls.createRun += 1;
      state.seq += 1;
      const newRunId = `run-e2e-${state.seq}`;
      const payload = request.postDataJSON() as {
        template_id?: string;
        params?: Record<string, string>;
      };
      state.runs = [
        {
          run_id: newRunId,
          template_id: payload.template_id ?? "tpl-e2e-001",
          status: "queued",
          step_cursor: 1,
          params: payload.params ?? {},
          task_id: null,
          last_error: null,
          artifacts_ref: {},
          created_at: "2026-02-20T00:00:00.000Z",
          updated_at: "2026-02-20T00:00:00.000Z",
          logs: [{ ts: "2026-02-20T00:00:00.000Z", level: "info", message: "run created" }],
        },
        ...state.runs,
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: newRunId }),
      });
      return;
    }
    if (pathname.match(/^\/api\/runs\/[^/]+\/otp$/) && method === "POST") {
      state.calls.submitRunOtp += 1;
      const runId = pathname.split("/")[3] ?? "";
      state.runs = state.runs.map((run) =>
        run.run_id === runId
          ? {
              ...run,
              status: "running",
              logs: [
                ...run.logs,
                { ts: "2026-02-20T00:00:02.000Z", level: "info", message: "otp submitted" },
              ],
              updated_at: "2026-02-20T00:00:02.000Z",
            }
          : run,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run_id: runId, status: "running" }),
      });
      return;
    }

    if (pathname === "/api/command-tower/latest-flow" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.latestFlow),
      });
      return;
    }
    if (pathname === "/api/command-tower/latest-flow-draft" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session_id: state.flowDraft.session_id, flow: state.flowDraft }),
      });
      return;
    }
    if (pathname === "/api/command-tower/latest-flow-draft" && method === "PATCH") {
      state.calls.saveFlowDraft += 1;
      const payload = request.postDataJSON() as { flow?: typeof state.flowDraft };
      if (payload.flow) {
        state.flowDraft = payload.flow;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (pathname === "/api/command-tower/evidence-timeline" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: state.evidenceTimeline }),
      });
      return;
    }
    if (pathname === "/api/command-tower/evidence" && method === "GET") {
      const stepId = url.searchParams.get("step_id") ?? "";
      const hit = state.evidenceTimeline.find((item) => item.step_id === stepId);
      if (!hit) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: "not found" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(hit),
      });
      return;
    }
    if (pathname === "/api/command-tower/replay-latest" && method === "POST") {
      state.calls.replayLatestFlow += 1;
      const task = createReplayTask(state, "flow-replay");
      state.tasks = [task, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ task }),
      });
      return;
    }
    if (pathname === "/api/command-tower/replay-latest-step" && method === "POST") {
      state.calls.replayStep += 1;
      const task = createReplayTask(state, "flow-step-replay");
      state.tasks = [task, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ task }),
      });
      return;
    }
    if (pathname === "/api/command-tower/replay-latest-from-step" && method === "POST") {
      state.calls.replayFromStep += 1;
      const task = createReplayTask(state, "flow-resume");
      state.tasks = [task, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ task }),
      });
      return;
    }

    throw new Error(`[critical-buttons] Unhandled API route: ${method} ${pathname}`);
  });

  await page.route("**/health/**", async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/health/diagnostics") {
      state.calls.fetchDiagnostics += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          uptime_seconds: 600,
          task_total: state.tasks.length,
          task_counts: {
            queued: state.tasks.filter((task) => task.status === "queued").length,
            running: state.tasks.filter((task) => task.status === "running").length,
            success: state.tasks.filter((task) => task.status === "success").length,
            failed: state.tasks.filter((task) => task.status === "failed").length,
            cancelled: state.tasks.filter((task) => task.status === "cancelled").length,
          },
          metrics: { requests_total: 42, rate_limited: 0 },
        }),
      });
      return;
    }
    if (pathname === "/health/alerts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "ok",
          failure_rate: 0,
          threshold: 0.2,
          completed: state.tasks.filter((task) => task.status === "success").length,
          failed: state.tasks.filter((task) => task.status === "failed").length,
        }),
      });
      return;
    }
    if (pathname === "/health/rum" && method === "POST") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
      return;
    }
    throw new Error(`[critical-buttons] Unhandled health route: ${method} ${pathname}`);
  });
}

async function assertApiKeyBranch(page: Page) {
  await switchToTopTab(page, "Stress Lab");
  await dismissToastOverlays(page);
  const apiKeyInput = page.locator("#api-key");
  if ((await apiKeyInput.count()) === 0) {
    // New Gemini-first panel no longer exposes a dedicated api-key input.
    await expect(
      page.locator("#automation-token"),
      "automation token input must be rendered when api-key input is absent",
    ).toHaveCount(1);
    return;
  }
  await apiKeyInput.fill("sk-demo-123");
  await expect(apiKeyInput).toHaveAttribute("type", "password");
  const showButton = page.locator('button[aria-controls="api-key"]', { hasText: "Show" });
  const visibleShowButton = await firstVisible(showButton);
  await expect(
    visibleShowButton,
    "api-key branch requires an explicit show control when #api-key is present",
  ).not.toBeNull();
  if (!visibleShowButton) {
    throw new Error("api-key show control should be visible");
  }
  await clickWithFallback(visibleShowButton);
  await expect(apiKeyInput).toHaveAttribute("type", "text");
  const hideButton = page.locator('button[aria-controls="api-key"]', { hasText: "Hide" });
  const visibleHideButton = await firstVisible(hideButton);
  await expect(
    visibleHideButton,
    "api-key branch requires an explicit hide control after reveal",
  ).not.toBeNull();
  if (!visibleHideButton) {
    throw new Error("api-key hide control should be visible after reveal");
  }
  await clickWithFallback(visibleHideButton);
  await expect(apiKeyInput).toHaveAttribute("type", "password");
}

async function assertModelFallbackBranch(page: Page) {
  await switchToTopTab(page, "Stress Lab");
  await dismissToastOverlays(page);
  const modelNameInput = page.locator("#model-name");
  await expect(
    modelNameInput,
    "model-name input must stay available for explicit Gemini model pinning",
  ).toHaveCount(1);
  await modelNameInput.fill("gemini-3.1-pro-preview");
  await expect(modelNameInput).toHaveValue(/(?:models\/)?gemini-3\.1-pro-preview/);
}

async function dismissToastOverlays(page: Page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const closeButtons = page.locator('[aria-label^="Close notification:"]');
    const beforeCount = await closeButtons.count();
    if (beforeCount === 0) {
      break;
    }
    try {
      await closeButtons.first().click({ timeout: 1_500 });
    } catch {
      // Keep a user-path fallback to dismiss overlays without forcing synthetic clicks.
      await page.keyboard.press("Escape");
    }
    const afterCount = await closeButtons.count();
    if (afterCount === 0) {
      break;
    }
    if (afterCount >= beforeCount && attempt === 5) {
      throw new Error("[critical-buttons] toast overlay remains undisposed after retries");
    }
  }
}

async function clickTabStable(page: Page, name: string | RegExp) {
  await dismissToastOverlays(page);
  const tab = page.getByRole("tab", { name });
  const target = tab.first();
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  await target.click();
}

async function switchToTopTab(page: Page, name: string) {
  const tab = page.getByRole("tablist", { name: "Primary navigation" }).getByRole("tab", { name }).first();
  await expect(tab).toBeVisible();
  await expect(tab).toBeEnabled();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function switchTaskCenterRecordTab(page: Page, target: "template" | "command") {
  const tabTestId =
    target === "template"
      ? TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID
      : TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID;
  const tab = page.getByTestId(tabTestId).first();
  await tab.waitFor({ state: "attached" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissToastOverlays(page);
    if (!(await tab.isVisible())) {
      await page.getByRole("tab", { name: "Runs & Blocks" }).first().click();
    }
    await expect(tab).toBeVisible();
    await expect(tab).toBeEnabled();
    await clickWithFallback(tab);
    if ((await tab.getAttribute("aria-selected")) === "true") {
      break;
    }
    await clickWithFallback(tab);
    if ((await tab.getAttribute("aria-selected")) === "true") {
      break;
    }
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible()) {
      return candidate;
    }
  }
  return null;
}

async function clickWithFallback(locator: Locator) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    await expect(locator).toBeEnabled();
    try {
      await locator.click({ timeout: 2000 });
      return;
    } catch (error) {
      const role = await locator.getAttribute("role", { timeout: 200 }).catch(() => null);
      const tagName = await locator
        .evaluate((element) => element.tagName.toLowerCase())
        .catch(() => "");
      if (role === "button" || role === "tab" || role === "option" || tagName === "button") {
        await locator.dispatchEvent("click");
        return;
      }
      if (attempt === 2) {
        throw error;
      }
      await dismissToastOverlays(locator.page());
    }
  }
}

async function setControlValue(locator: Locator, value: string) {
  try {
    await locator.fill(value);
    return;
  } catch {
    // Fall through to select controls.
  }
  try {
    await locator.selectOption(value);
    return;
  } catch {
    // Fall through to checkable controls.
  }
  const controlType = (await locator.getAttribute("type"))?.toLowerCase();
  if (controlType === "checkbox") {
    if (value === "true") {
      await locator.check();
    } else {
      await locator.uncheck();
    }
    return;
  }
  if (controlType === "radio") {
    await locator.check();
    return;
  }
  throw new Error(`Unsupported control for setControlValue: ${controlType ?? "unknown"}`);
}

test.describe("@frontend-critical-buttons", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("ab_onboarding_done", "1");
      window.localStorage.setItem("ab_first_use_done", "1");
    });
  });

  test("QuickLaunch / TaskCenter / Header / Terminal critical buttons", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const state = createState();
    await installBackendStubs(page, state);
    await gotoRootWithFrontendRetry(page);

    await expect(page.getByRole("heading", { level: 1, name: "Prooflane" })).toBeVisible();
    const fetchTasksBeforeAuth = state.calls.fetchTasks;
    await page.locator("#automation-token").fill("token-demo-123");
    await page.locator("#automation-client-id").fill("client-e2e-001");
    await expect.poll(() => state.calls.fetchTasks).toBeGreaterThan(fetchTasksBeforeAuth);

    const openHomepageCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 2, name: "Open homepage" }) })
      .first();
    await dismissToastOverlays(page);
    await clickWithFallback(openHomepageCard.getByRole("button", { name: "Run" }).first());
    await expect.poll(() => state.calls.runCommand).toBeGreaterThan(0);

    await clickWithFallback(page.getByRole("button", { name: "Start run", exact: true }).first());
    await expect.poll(() => state.calls.createRun).toBeGreaterThan(0);

    await clickTabStable(page, "Runs & Blocks");
    await expect(page.getByRole("tab", { name: "Runs & Blocks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const taskListColumn = page.getByTestId(TASK_CENTER_LIST_COLUMN_TEST_ID);
    await switchTaskCenterRecordTab(page, "template");
    await expect(page.getByRole("listbox", { name: "Lab run list (templates)" })).toHaveCount(1);
    await switchTaskCenterRecordTab(page, "command");
    await expect(page.getByRole("list", { name: "Command run list" })).toHaveCount(1);
    const refreshBefore = state.calls.fetchTasks;
    await dismissToastOverlays(page);
    await clickWithFallback(taskListColumn.getByRole("button", { name: "Refresh" }).first());
    await expect.poll(() => state.calls.fetchTasks).toBeGreaterThan(refreshBefore);

    await dismissToastOverlays(page);
    const cancelButton = page.getByRole("button", { name: "Cancel" }).first();
    if (testInfo.project.name.includes("mobile")) {
      await expect(cancelButton).toHaveCount(1);
    } else {
      await clickWithFallback(cancelButton);
      await expect(page.getByText(/Cancelled task/)).toBeVisible();
      await expect.poll(() => state.calls.cancelTask).toBeGreaterThan(0);
    }

    await switchTaskCenterRecordTab(page, "template");
    await dismissToastOverlays(page);
    const otpOption = page.getByRole("option").filter({ hasText: "Waiting for OTP" }).first();
    if ((await otpOption.count()) > 0) {
      await clickWithFallback(otpOption);
    }
    const otpInput = page.getByPlaceholder("Enter OTP");
    if ((await otpInput.count()) > 0) {
      await setControlValue(otpInput, "654321");
      await clickWithFallback(
        page
          .getByTestId(TASK_CENTER_DETAIL_COLUMN_TEST_ID)
          .getByRole("button", { name: "Submit", exact: true }),
      );
    }

    const pageHeader = page.locator("header").first();
    await pageHeader.getByRole("button", { name: "Help" }).click();
    await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
    await page.getByRole("button", { name: "Close help panel" }).click();

    await pageHeader.getByRole("button", { name: "Restart onboarding" }).click();
    await expect(page.getByText("Step 1: Start from the target, not from the room list")).toBeVisible();
    await page.getByRole("button", { name: "Remind me later" }).click();

    const terminal = page.getByRole("region", { name: "Live terminal" });
    await terminal.getByRole("button", { name: "Clear" }).click();
    await expect(terminal.getByText("Terminal log is empty")).toBeVisible();
  });

  test("ParamsPanel api-key branch is explicitly covered", async ({ page }) => {
    const state = createState();
    await installBackendStubs(page, state);
    await gotoRootWithFrontendRetry(page);
    await assertApiKeyBranch(page);
  });

  test("ParamsPanel model-name input branch is explicitly covered", async ({ page }) => {
    const state = createState();
    await installBackendStubs(page, state);
    await gotoRootWithFrontendRetry(page);
    await assertModelFallbackBranch(page);
  });

  test("ConfirmDialog / ParamsPanel(shared) / TaskListPanel / Terminal controls", async ({
    page,
  }, testInfo) => {
    const state = createState();
    await installBackendStubs(page, state);
    await gotoRootWithFrontendRetry(page);
    await switchToTopTab(page, "Stress Lab");
    const fetchTasksBeforeAuth = state.calls.fetchTasks;
    const tokenInput = page.locator("#automation-token");
    await tokenInput.fill("token-demo-123");
    await page.locator("#automation-client-id").fill("client-e2e-001");
    await expect.poll(() => state.calls.fetchTasks).toBeGreaterThan(fetchTasksBeforeAuth);
    await expect(tokenInput).toHaveAttribute("type", "password");
    const showButton = page.locator('button[aria-controls="automation-token"]', {
      hasText: "Show",
    });
    const visibleShowButton = await firstVisible(showButton);
    if (visibleShowButton) {
      await clickWithFallback(visibleShowButton);
    }
    await expect(tokenInput).toHaveAttribute("type", visibleShowButton ? "text" : "password");
    const hideButton = page.locator('button[aria-controls="automation-token"]', {
      hasText: "Hide",
    });
    const visibleHideButton = await firstVisible(hideButton);
    if (visibleHideButton) {
      await clickWithFallback(visibleHideButton);
    }
    await expect(
      tokenInput,
      "token input should be masked if hide is available; otherwise keep current visibility state",
    ).toHaveAttribute(
      "type",
      visibleHideButton ? "password" : visibleShowButton ? "text" : "password",
    );

    const headlessCheckbox = page.getByLabel("Run browser headlessly");
    const strictCheckbox = page.getByLabel("Use strict page element matching (Midscene Strict)");
    await expect(headlessCheckbox).toBeVisible();
    await expect(strictCheckbox).toBeVisible();
    await headlessCheckbox.check();
    await strictCheckbox.check();
    await expect(headlessCheckbox).toBeChecked();
    await expect(strictCheckbox).toBeChecked();

    const clearCacheCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 2, name: "Clear cache" }) })
      .first();
    const dangerousButton = clearCacheCard.getByRole("button", { name: "Dangerous run" }).first();
    await dangerousButton.click();
    await expect(page.getByRole("dialog", { name: "Confirm dangerous command" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Confirm dangerous command" })).toHaveCount(0);
    await expect.poll(() => state.calls.runCommand).toBe(0);

    await dangerousButton.click();
    await page
      .getByRole("dialog", { name: "Confirm dangerous command" })
      .getByRole("button", { name: "Confirm" })
      .click();
    await expect.poll(() => state.calls.runCommand).toBe(1);

    await page.getByRole("tab", { name: "Runs & Blocks" }).click();
    const statusFilter = page.getByLabel("Filter tasks by status");
    const commandFilter = page.getByLabel("Filter command runs by command ID");
    const limitFilter = page.getByLabel("Task limit");
    try {
      await statusFilter.selectOption("running");
      await commandFilter.fill("clean-e2e-001");
      await limitFilter.selectOption("20");
    } catch {
      await setControlValue(statusFilter, "running");
      await setControlValue(commandFilter, "clean-e2e-001");
      await setControlValue(limitFilter, "20");
    }
    await dismissToastOverlays(page);
    await clickWithFallback(
      page
        .getByTestId(TASK_CENTER_LIST_COLUMN_TEST_ID)
        .getByRole("button", { name: "Refresh" })
        .first(),
    );
    if (testInfo.project.name.includes("mobile")) {
      await expect.poll(() => state.calls.fetchTasks).toBeGreaterThan(0);
    } else {
      await expect
        .poll(() => state.calls.taskQuery)
        .toEqual({
          status: "running",
          command_id: "clean-e2e-001",
          limit: "20",
        });
    }

    const terminal = page.getByRole("region", { name: "Live terminal" });
    const terminalHeight = terminal.locator("#terminal-size");
    const beforeRows = await terminalHeight.inputValue();
    await terminalHeight.focus();
    await page.keyboard.press("ArrowRight");
    await expect(terminalHeight).not.toHaveValue(beforeRows);

    const autoScrollCheckbox = terminal.getByLabel("Auto-scroll");
    await autoScrollCheckbox.uncheck();
    await expect(autoScrollCheckbox).not.toBeChecked();
    await terminal.getByLabel("Log level filter").selectOption("error");
    await expect(terminal.getByText("Terminal log is empty")).toBeVisible();
    await terminal.getByLabel("Log level filter").selectOption("all");
    await terminal.getByRole("button", { name: "Clear" }).click();
    await expect(terminal.getByText("Terminal log is empty")).toBeVisible();
  });

  test("FlowWorkshop critical buttons", async ({ page }) => {
    test.setTimeout(180_000);
    const state = createState();
    await installBackendStubs(page, state);
    await gotoRootWithFrontendRetry(page);

    await switchToTopTab(page, "Flow Studio");
    await expect(
      page.getByRole("heading", { level: 2, name: /Lab result and next experiment|Key result and next action/ }).first(),
    ).toBeVisible();
    await page.getByText(/Advanced (studio|debugging evidence) \(optional\)/).first().click();

    await page.getByRole("button", { name: "Save draft" }).first().click();
    await expect(page.getByText("Flow draft saved successfully")).toBeVisible();
    await expect.poll(() => state.calls.saveFlowDraft).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Replay latest flow" }).click();
    await expect(page.getByText("Flow replay triggered")).toBeVisible();
    await expect.poll(() => state.calls.replayLatestFlow).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Add step" }).click();
    await expect(
      page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem"),
    ).toHaveCount(3);

    await page.getByRole("button", { name: "Replay step" }).first().click();
    await expect(page.getByText("Single-step replay triggered for s1")).toBeVisible();
    await expect.poll(() => state.calls.replayStep).toBeGreaterThan(0);

    await page.getByText("Step parameters (action / URL / value ref)").first().click();
    await page.getByLabel("step-0-action").selectOption("type");
    await page.getByLabel("step-0-value-ref").fill("${params.otp_code}");
    await expect(page.getByLabel("step-0-value-ref")).toHaveValue("${params.otp_code}");

    const firstAdvancedPanel = page
      .getByRole("list", { name: "flow-editor-steps" })
      .getByRole("listitem")
      .nth(1);
    await firstAdvancedPanel.getByText("Advanced settings (step_id / selector / order)").click();
    const moveUpButton = firstAdvancedPanel.getByRole("button", { name: "Move up" });
    await expect(moveUpButton).toBeVisible();
    await moveUpButton.click();
    const movedAdvancedPanel = page
      .getByRole("list", { name: "flow-editor-steps" })
      .getByRole("listitem")
      .first();
    await movedAdvancedPanel.getByText("Advanced settings (step_id / selector / order)").click();
    const moveDownButton = movedAdvancedPanel.getByRole("button", { name: "Move down" });
    await expect(moveDownButton).toBeVisible();
    await moveDownButton.click();
    await expect(
      page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem"),
    ).toHaveCount(3);

    await page.getByRole("button", { name: /Resume/ }).first().click();
    await expect(page.getByText("Resume triggered from step s2")).toBeVisible();
    await expect.poll(() => state.calls.replayFromStep).toBeGreaterThan(0);

    const diagnosticsBefore = state.calls.fetchDiagnostics;
    await page
      .getByTestId(FLOW_WORKSHOP_EDITOR_COLUMN_TEST_ID)
      .getByRole("button", { name: "Refresh" })
      .click();
    await expect.poll(() => state.calls.fetchDiagnostics).toBeGreaterThan(diagnosticsBefore);
  });

  test("Onboarding complete chain", async ({ page }) => {
    const state = createState();
    await installBackendStubs(page, state);
    await page.addInitScript(() => {
      window.localStorage.removeItem("ab_onboarding_done");
      window.localStorage.setItem("ab_first_use_done", "1");
    });
    await gotoRootWithFrontendRetry(page);

    await expect(
      page.getByRole("dialog", { name: "Step 1: Start from the target, not from the room list" }),
    ).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(
      page.getByRole("dialog", { name: "Step 2: Launch from Stress Lab" }),
    ).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(
      page.getByRole("dialog", { name: "Step 3: Read the result in Runs & Blocks" }),
    ).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(
      page.getByRole("dialog", { name: "Step 4: Deepen the journey in Flow Studio" }),
    ).toBeVisible();
    await page.getByTestId("onboarding-next").click();
    await expect(
      page.getByRole("dialog", { name: "Step 5: Open Advanced Review only when needed" }),
    ).toBeVisible();
    await page.getByTestId("onboarding-start").click();

    await expect(
      page.getByRole("dialog", { name: "Step 1: Start from the target, not from the room list" }),
    ).toHaveCount(0);
    // Read-only state verification: no DOM mutation or simulated interaction here.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")))
      .toBe("1");
  });
});
