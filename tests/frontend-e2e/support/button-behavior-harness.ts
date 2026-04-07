import { expect, type Page, test } from "@playwright/test";
import { BUTTON_BEHAVIOR_MANIFEST } from "../../../apps/command-center/src/testing/button-manifest";
import type {
  Command,
  FlowEditableDraft,
  FlowPreviewPayload,
  Task,
  UniversalFlow,
  UniversalRun,
  UniversalTemplate,
} from "../../../apps/command-center/src/types";
import { gotoRootWithFrontendRetry } from "./frontend-navigation";

type ButtonBehaviorMeta = {
  case_id: string;
  assertion_type: string;
};

type LocalStoragePreset = {
  onboardingDone?: boolean;
  firstUseDone?: boolean;
  firstUseStage?: "welcome" | "configure" | "run" | "verify";
  firstUseProgress?: {
    configValid: boolean;
    runTriggered: boolean;
    resultSeen: boolean;
  };
};

type BootstrapOptions = {
  localStorage?: LocalStoragePreset;
  commands?: Command[];
  tasks?: Task[];
  flows?: UniversalFlow[];
  templates?: UniversalTemplate[];
  runs?: UniversalRun[];
  latestFlow?: FlowPreviewPayload;
  flowDraft?: FlowEditableDraft | null;
  diagnostics?: {
    uptime_seconds: number;
    task_total: number;
    task_counts: Record<string, number>;
    metrics: { requests_total: number; rate_limited: number };
  };
  alerts?: {
    state: "ok" | "degraded";
    failure_rate: number;
    threshold: number;
    completed: number;
    failed: number;
  };
};

type Harness = {
  calls: {
    runCommand: number;
    saveFlowDraft: number;
    replayLatestFlow: number;
    replayStep: number;
    replayFromStep: number;
    fetchTasks: number;
    cancelTask: number;
  };
};

const FRONTEND_BOOTSTRAP_READY_TIMEOUT_MS = 12_000;

async function waitForFrontendBootstrapReady(page: Page): Promise<void> {
  const bootStatus = page.getByRole("status").filter({ hasText: "Initializing page..." });
  await expect(bootStatus).toHaveCount(0, { timeout: FRONTEND_BOOTSTRAP_READY_TIMEOUT_MS });
}

async function openBootstrappedFrontend(page: Page, maxAttempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await gotoRootWithFrontendRetry(page);
      await waitForFrontendBootstrapReady(page);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        throw error;
      }
      await page.goto("about:blank").catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("frontend bootstrap did not stabilize");
}

const DEFAULT_COMMANDS: Command[] = [
  {
    command_id: "pipeline-run-demo",
    title: "Run pipeline task",
    description: "Verify the pipeline command entry point",
    tags: ["pipeline"],
  },
  {
    command_id: "init-setup-demo",
    title: "Initialize environment",
    description: "Verify category filtering",
    tags: ["setup"],
  },
];

const DEFAULT_TASKS: Task[] = [
  {
    task_id: "task-demo-001",
    command_id: "pipeline-run-demo",
    status: "success",
    requested_by: "tester",
    attempt: 1,
    max_attempts: 1,
    created_at: "2026-02-20T00:00:00.000Z",
    started_at: "2026-02-20T00:00:01.000Z",
    finished_at: "2026-02-20T00:00:03.000Z",
    exit_code: 0,
    message: "ok",
    output_tail: "done",
  },
];

const DEFAULT_FLOWS: UniversalFlow[] = [
  {
    flow_id: "flow-demo-001",
    session_id: "session-demo-001",
    version: 1,
    quality_score: 0.99,
    start_url: "http://127.0.0.1:17380/register",
    source_event_count: 2,
    steps: [
      { step_id: "step-1", action: "navigate", url: "http://127.0.0.1:17380/register" },
      {
        step_id: "step-2",
        action: "click",
        target: { selectors: [{ kind: "css", value: "#submit", score: 0.9 }] },
      },
    ],
    created_at: "2026-02-20T00:00:00.000Z",
    updated_at: "2026-02-20T00:00:00.000Z",
  },
];

const DEFAULT_TEMPLATES: UniversalTemplate[] = [
  {
    template_id: "tpl-demo-001",
    flow_id: "flow-demo-001",
    name: "Demo Template",
    params_schema: [{ key: "email", type: "email", required: true, description: "Email" }],
    defaults: { email: "demo@example.com" },
    policies: {
      retries: 0,
      timeout_seconds: 120,
      otp: {
        required: false,
        provider: "manual",
        timeout_seconds: 120,
        regex: "\\b(\\d{6})\\b",
        sender_filter: null,
        subject_filter: null,
      },
      branches: {},
    },
    created_by: "tester",
    created_at: "2026-02-20T00:00:00.000Z",
    updated_at: "2026-02-20T00:00:00.000Z",
  },
];

const DEFAULT_RUNS: UniversalRun[] = [
  {
    run_id: "run-demo-001",
    template_id: "tpl-demo-001",
    status: "success",
    step_cursor: 2,
    params: { email: "demo@example.com" },
    task_id: "task-demo-001",
    last_error: null,
    artifacts_ref: {},
    created_at: "2026-02-20T00:00:00.000Z",
    updated_at: "2026-02-20T00:00:00.000Z",
    logs: [],
  },
];

const DEFAULT_LATEST_FLOW: FlowPreviewPayload = {
  session_id: "session-demo-001",
  start_url: "http://127.0.0.1:17380/register",
  generated_at: "2026-02-20T00:00:00.000Z",
  source_event_count: 2,
  step_count: 2,
  steps: [
    { step_id: "step-1", action: "navigate", url: "http://127.0.0.1:17380/register" },
    { step_id: "step-2", action: "click", selector: "#submit" },
  ],
};

const DEFAULT_FLOW_DRAFT: FlowEditableDraft = {
  flow_id: "flow-demo-001",
  session_id: "session-demo-001",
  start_url: "http://127.0.0.1:17380/register",
  generated_at: "2026-02-20T00:00:00.000Z",
  source_event_count: 2,
  steps: [
    { step_id: "step-1", action: "navigate", url: "http://127.0.0.1:17380/register" },
    {
      step_id: "step-2",
      action: "click",
      target: { selectors: [{ kind: "css", value: "#submit", score: 0.9 }] },
    },
  ],
};

function toJsonBody(payload: unknown) {
  return JSON.stringify(payload);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function buttonBehaviorCase(meta: ButtonBehaviorMeta, body: Parameters<typeof test>[1]) {
  test(meta.case_id, body);
}

export function selectorForCase(caseId: string): string {
  const entry = BUTTON_BEHAVIOR_MANIFEST.find((item) => item.case_id === caseId);
  if (!entry) {
    throw new Error(`button behavior manifest is missing case_id=${caseId}`);
  }
  return entry.selector;
}

export async function bootstrapButtonBehaviorApp(
  page: Page,
  options: BootstrapOptions = {},
): Promise<Harness> {
  const calls = {
    runCommand: 0,
    saveFlowDraft: 0,
    replayLatestFlow: 0,
    replayStep: 0,
    replayFromStep: 0,
    fetchTasks: 0,
    cancelTask: 0,
  };

  const state = {
    commands: clone(options.commands ?? DEFAULT_COMMANDS),
    tasks: clone(options.tasks ?? DEFAULT_TASKS),
    flows: clone(options.flows ?? DEFAULT_FLOWS),
    templates: clone(options.templates ?? DEFAULT_TEMPLATES),
    runs: clone(options.runs ?? DEFAULT_RUNS),
    latestFlow: clone(options.latestFlow ?? DEFAULT_LATEST_FLOW),
    flowDraft: clone(options.flowDraft ?? DEFAULT_FLOW_DRAFT),
    diagnostics: clone(
      options.diagnostics ?? {
        uptime_seconds: 3600,
        task_total: 3,
        task_counts: { running: 0, success: 2, failed: 1 },
        metrics: { requests_total: 100, rate_limited: 0 },
      },
    ),
    alerts: clone(
      options.alerts ?? {
        state: "ok",
        failure_rate: 0,
        threshold: 0.15,
        completed: 2,
        failed: 0,
      },
    ),
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname === "/api/automation/commands") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ commands: state.commands }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/automation/tasks") {
      calls.fetchTasks += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ tasks: state.tasks }),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/api/automation/tasks/") &&
      url.pathname.endsWith("/cancel")
    ) {
      calls.cancelTask += 1;
      const taskId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const nextTasks = state.tasks.map((task) =>
        task.task_id === taskId
          ? {
              ...task,
              status: "cancelled" as const,
              finished_at: task.finished_at ?? "2026-02-21T00:00:04.000Z",
              message: "cancelled by test harness",
            }
          : task,
      );
      const cancelledTask = nextTasks.find((task) => task.task_id === taskId) ?? null;
      state.tasks = nextTasks;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ task: cancelledTask }),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/automation/run") {
      calls.runCommand += 1;
      const raw = request.postData() ?? "{}";
      let parsed: { command?: string } = {};
      try {
        parsed = JSON.parse(raw) as { command?: string };
      } catch {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: toJsonBody({ detail: "invalid json payload" }),
        });
        return;
      }
      const token = (await request.headerValue("x-automation-token"))?.trim() ?? "";
      const clientId = (await request.headerValue("x-automation-client-id"))?.trim() ?? "";
      if (token && !clientId) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: toJsonBody({ detail: "x-automation-client-id header is required" }),
        });
        return;
      }
      const commandId = typeof parsed.command === "string" ? parsed.command.trim() : "";
      if (!commandId) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: toJsonBody({ detail: "command is required" }),
        });
        return;
      }
      const taskId = `task-run-${String(calls.runCommand).padStart(3, "0")}`;
      const nextTask: Task = {
        task_id: taskId,
        command_id: commandId,
        status: "running",
        requested_by: "tester",
        attempt: 1,
        max_attempts: 1,
        created_at: "2026-02-21T00:00:00.000Z",
        started_at: "2026-02-21T00:00:00.000Z",
        finished_at: null,
        exit_code: null,
        message: null,
        output_tail: "",
      };
      state.tasks = [nextTask, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ task: nextTask }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/command-tower/latest-flow") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody(state.latestFlow),
      });
      return;
    }

    if (url.pathname === "/api/command-tower/latest-flow-draft") {
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: toJsonBody({
            session_id: state.flowDraft?.session_id ?? null,
            flow: state.flowDraft,
          }),
        });
        return;
      }
      if (method === "PATCH") {
        calls.saveFlowDraft += 1;
        const raw = request.postData() ?? "{}";
        const parsed = JSON.parse(raw) as { flow?: FlowEditableDraft | null };
        state.flowDraft = parsed.flow ?? null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: toJsonBody({ ok: true }),
        });
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/command-tower/replay-latest") {
      calls.replayLatestFlow += 1;
      const replayTask: Task = {
        task_id: `task-replay-${String(calls.replayLatestFlow).padStart(3, "0")}`,
        command_id: "command-tower-replay-latest",
        status: "running",
        requested_by: "tester",
        attempt: 1,
        max_attempts: 1,
        created_at: "2026-02-21T00:00:00.000Z",
        started_at: "2026-02-21T00:00:00.000Z",
        finished_at: null,
        exit_code: null,
        message: null,
        output_tail: "",
      };
      state.tasks = [replayTask, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ task: replayTask }),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/command-tower/replay-latest-step") {
      calls.replayStep += 1;
      const raw = request.postData() ?? "{}";
      const parsed = JSON.parse(raw) as { step_id?: string };
      const stepId = (parsed.step_id ?? "").trim() || "unknown-step";
      const replayTask: Task = {
        task_id: `task-step-${String(calls.replayStep).padStart(3, "0")}`,
        command_id: `command-tower-replay-step-${stepId}`,
        status: "running",
        requested_by: "tester",
        attempt: 1,
        max_attempts: 1,
        created_at: "2026-02-21T00:00:00.000Z",
        started_at: "2026-02-21T00:00:00.000Z",
        finished_at: null,
        exit_code: null,
        message: null,
        output_tail: "",
      };
      state.tasks = [replayTask, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ task: replayTask }),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/command-tower/replay-latest-from-step") {
      calls.replayFromStep += 1;
      const raw = request.postData() ?? "{}";
      const parsed = JSON.parse(raw) as { step_id?: string };
      const stepId = (parsed.step_id ?? "").trim() || "unknown-step";
      const replayTask: Task = {
        task_id: `task-resume-${String(calls.replayFromStep).padStart(3, "0")}`,
        command_id: `command-tower-resume-step-${stepId}`,
        status: "running",
        requested_by: "tester",
        attempt: 1,
        max_attempts: 1,
        created_at: "2026-02-21T00:00:00.000Z",
        started_at: "2026-02-21T00:00:00.000Z",
        finished_at: null,
        exit_code: null,
        message: null,
        output_tail: "",
      };
      state.tasks = [replayTask, ...state.tasks];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ task: replayTask }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/command-tower/evidence-timeline") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ items: [] }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/command-tower/evidence") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: toJsonBody({ detail: "not found" }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/flows") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ flows: state.flows }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/templates") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({ templates: state.templates }),
      });
      return;
    }

    if (method === "GET" && url.pathname.match(/^\/api\/templates\/[^/]+\/history$/)) {
      const templateId = url.pathname.split("/")[3] ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody({
          templates: state.templates.filter((template) => template.template_id === templateId),
        }),
      });
      return;
    }

    if (url.pathname === "/api/runs") {
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: toJsonBody({ runs: state.runs }),
        });
        return;
      }
      if (method === "POST") {
        const newRun: UniversalRun = {
          run_id: `run-created-${String(state.runs.length + 1).padStart(3, "0")}`,
          template_id: state.templates[0]?.template_id ?? "tpl-unknown",
          status: "queued",
          step_cursor: 0,
          params: {},
          task_id: null,
          last_error: null,
          artifacts_ref: {},
          created_at: "2026-02-21T00:00:00.000Z",
          updated_at: "2026-02-21T00:00:00.000Z",
          logs: [],
        };
        state.runs = [newRun, ...state.runs];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: toJsonBody({ run: newRun }),
        });
        return;
      }
    }

    throw new Error(`[button-behavior-harness] Unhandled API route: ${method} ${url.pathname}`);
  });

  await page.route("**/health/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/health/diagnostics") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody(state.diagnostics),
      });
      return;
    }
    if (url.pathname === "/health/alerts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: toJsonBody(state.alerts),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: toJsonBody({}) });
  });

  const storagePreset = {
    onboardingDone: true,
    firstUseDone: true,
    ...options.localStorage,
  };

  await page.addInitScript((preset: LocalStoragePreset) => {
    const setOrRemove = (key: string, value: string | null) => {
      if (value == null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    };

    setOrRemove("ab_onboarding_done", preset.onboardingDone ? "1" : null);
    setOrRemove("ab_first_use_done", preset.firstUseDone ? "1" : null);
    setOrRemove("ab_first_use_stage", preset.firstUseStage ?? null);
    setOrRemove(
      "ab_first_use_progress",
      preset.firstUseProgress ? JSON.stringify(preset.firstUseProgress) : null,
    );
    setOrRemove("ab_automation_client_id", "test-client-id");
  }, storagePreset);

  await openBootstrappedFrontend(page);
  return { calls };
}
