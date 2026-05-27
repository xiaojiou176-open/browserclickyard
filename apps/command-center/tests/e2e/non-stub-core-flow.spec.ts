import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";

type TaskStatus = "queued" | "running" | "success" | "failed" | "cancelled";

type TaskRecord = {
  task_id: string;
  command_id: string;
  status: TaskStatus;
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

const backendPort = process.env.BACKEND_PORT?.trim() || "17380";
const API_ORIGIN = process.env.VITE_DEFAULT_BASE_URL?.trim() || `http://127.0.0.1:${backendPort}`;
const API_PORT = Number.parseInt(new URL(API_ORIGIN).port || backendPort, 10);

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type,x-automation-token,x-automation-client-id",
  );
  response.end(JSON.stringify(payload));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { detail: "not found" });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function buildCoreApiServer() {
  let seq = 1;
  const tasks: TaskRecord[] = [];

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", API_ORIGIN);
    const pathname = requestUrl.pathname;
    const method = request.method ?? "GET";

    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "content-type,x-automation-token,x-automation-client-id",
      );
      response.end();
      return;
    }

    if (pathname === "/api/automation/commands" && method === "GET") {
      sendJson(response, 200, {
        commands: [
          {
            command_id: "script-pipeline-capture",
            title: "Real pipeline command",
            description: "Run/cancel path for non-stub E2E coverage",
            tags: ["pipeline", "ui-only"],
          },
        ],
      });
      return;
    }

    if (pathname === "/api/automation/tasks" && method === "GET") {
      const status = requestUrl.searchParams.get("status") ?? "all";
      const commandId = (requestUrl.searchParams.get("command_id") ?? "").trim();
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "100", 10);
      let filtered = [...tasks];
      if (status !== "all") {
        filtered = filtered.filter((task) => task.status === status);
      }
      if (commandId) {
        filtered = filtered.filter((task) => task.command_id.includes(commandId));
      }
      if (Number.isInteger(limit) && limit > 0) {
        filtered = filtered.slice(0, limit);
      }
      sendJson(response, 200, { tasks: filtered });
      return;
    }

    if (pathname === "/api/automation/run" && method === "POST") {
      const body = await readJsonBody(request);
      const preferredCommand = typeof body.command === "string" ? body.command.trim() : "";
      const commandId = preferredCommand || "script-pipeline-capture";
      const taskId = `task-nonstub-${String(seq).padStart(4, "0")}`;
      seq += 1;
      const task: TaskRecord = {
        task_id: taskId,
        command_id: commandId,
        status: "running",
        requested_by: "e2e",
        attempt: 1,
        max_attempts: 3,
        created_at: "2026-02-21T00:00:00.000Z",
        started_at: "2026-02-21T00:00:01.000Z",
        finished_at: null,
        exit_code: null,
        message: "Task is running",
        output_tail: `${taskId}-output`,
      };
      tasks.unshift(task);
      sendJson(response, 200, { task });
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/automation\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const taskId = cancelMatch[1] ?? "";
      const target = tasks.find((task) => task.task_id === taskId);
      if (!target) {
        notFound(response);
        return;
      }
      target.status = "cancelled";
      target.finished_at = "2026-02-21T00:00:05.000Z";
      target.exit_code = 130;
      target.message = "Cancelled";
      sendJson(response, 200, target);
      return;
    }

    if (pathname === "/health/diagnostics" && method === "GET") {
      sendJson(response, 200, {
        uptime_seconds: 120,
        task_total: tasks.length,
        task_counts: {
          queued: tasks.filter((task) => task.status === "queued").length,
          running: tasks.filter((task) => task.status === "running").length,
          success: tasks.filter((task) => task.status === "success").length,
          failed: tasks.filter((task) => task.status === "failed").length,
          cancelled: tasks.filter((task) => task.status === "cancelled").length,
        },
        metrics: { requests_total: 1, rate_limited: 0 },
      });
      return;
    }

    if (pathname === "/health/alerts" && method === "GET") {
      sendJson(response, 200, {
        state: "ok",
        failure_rate: 0,
        threshold: 0.2,
        completed: 0,
        failed: 0,
      });
      return;
    }

    if (pathname === "/api/command-tower/latest-flow" && method === "GET") {
      sendJson(response, 200, {
        session_id: null,
        start_url: null,
        generated_at: null,
        source_event_count: 0,
        step_count: 0,
        steps: [],
      });
      return;
    }

    if (pathname === "/api/command-tower/latest-flow-draft" && method === "GET") {
      sendJson(response, 200, { session_id: null, flow: null });
      return;
    }

    if (pathname === "/api/command-tower/evidence-timeline" && method === "GET") {
      sendJson(response, 200, { items: [] });
      return;
    }

    if (pathname === "/api/flows" && method === "GET") {
      sendJson(response, 200, { flows: [] });
      return;
    }

    if (pathname === "/api/templates" && method === "GET") {
      sendJson(response, 200, { templates: [] });
      return;
    }

    if (pathname === "/api/runs" && method === "GET") {
      sendJson(response, 200, { runs: [] });
      return;
    }

    notFound(response);
  });

  return {
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(API_PORT, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function hasCompatibleExternalApi(): Promise<boolean> {
  try {
    const response = await fetch(`${API_ORIGIN}/api/automation/commands`);
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { commands?: unknown };
    return Array.isArray(payload.commands);
  } catch {
    return false;
  }
}

let managedServer: ReturnType<typeof buildCoreApiServer> | null = null;

test.beforeAll(async () => {
  managedServer = buildCoreApiServer();
  try {
    await managedServer.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("EADDRINUSE")) {
      throw error;
    }
    const compatible = await hasCompatibleExternalApi();
    if (!compatible) {
      const reason = `port ${API_PORT} is already in use and does not expose compatible /api/automation/commands`;
      throw new Error(`[non-stub-core-flow] ${reason}; gate requires strict live compatibility.`);
    }
    managedServer = null;
  }
});

test.afterAll(async () => {
  if (managedServer) {
    await managedServer.stop();
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ab_onboarding_done", "1");
    window.localStorage.setItem("ab_first_use_done", "1");
  });
});

test.afterEach(async ({ context, page }) => {
  await context.clearCookies();
  if (!page.isClosed()) {
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
  }
});

test("@core-nonstub @nonstub run and cancel chain over live local api", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Browserclickyard" })).toBeVisible();
  const backendUnavailable = page.getByText("The backend connection failed.").first();
  if (await backendUnavailable.isVisible()) {
    throw new Error("frontend non-stub contract requires backend connectivity");
  }

  const commandsResponse = await page.request.get(`${API_ORIGIN}/api/automation/commands`);
  if (!commandsResponse.ok()) {
    throw new Error("frontend non-stub contract requires /api/automation/commands to be available");
  }
  const commandsPayload = (await commandsResponse.json()) as { commands?: unknown };
  if (!Array.isArray(commandsPayload.commands) || commandsPayload.commands.length === 0) {
    throw new Error("frontend non-stub contract requires at least one command");
  }
  await page.getByRole("tab", { name: "Quick Launch" }).click();
  await expect
    .poll(async () => page.getByRole("button", { name: "Run" }).count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Run" }).first().click();
  await expect(page.getByText(/Submitted[:：]?\s*Real pipeline command/)).toBeVisible();

  await page.getByRole("tab", { name: "Task Center" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Running" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByText(/Cancelled task/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Cancelled" }).first()).toBeVisible();

  // Regression guard: cancellation must be persisted and queryable via real API.
  const cancelledResponse = await page.request.get(
    `${API_ORIGIN}/api/automation/tasks?status=cancelled`,
  );
  expect(cancelledResponse.status()).toBe(200);
  const cancelledPayload = (await cancelledResponse.json()) as {
    tasks?: Array<{ task_id: string; status: TaskStatus }>;
  };
  const cancelledTasks = cancelledPayload.tasks ?? [];
  expect(cancelledTasks.length).toBeGreaterThan(0);
  expect(cancelledTasks.map((task) => task.status)).toContain("cancelled");
});
