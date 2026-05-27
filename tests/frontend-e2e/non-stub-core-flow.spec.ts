import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { gotoRootWithFrontendRetry } from "./support/frontend-navigation";

type TaskStatus = "queued" | "running" | "success" | "failed" | "cancelled";
type CommandItem = {
  command_id: string;
  title?: string;
  description?: string;
};
const PREFERRED_COMMAND_IDS = [
  "backend-test",
  "automation-test",
  "lint-frontend",
  "script-pipeline-full",
  "script-pipeline-full-midscene",
  "script-pipeline-capture",
  "script-pipeline-capture-midscene",
] as const;
const REMOTE_BLOCKED_COMMAND_IDS = new Set([
  "dev-frontend",
  "automation-record-manual",
  "automation-record",
  "automation-record-midscene",
  "automation-install",
  "setup",
  "clean",
  "map",
  "diagnose",
]);

const TOKEN_ENV_KEYS = [
  "UIQ_AUTOMATION_TOKEN",
  "AUTOMATION_API_TOKEN",
  "AUTOMATION_TOKEN",
] as const;

function stripWrappingQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function readTokenFromRepoRootEnv(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return "";
  }
  const content = readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!TOKEN_ENV_KEYS.includes(key as (typeof TOKEN_ENV_KEYS)[number])) {
      continue;
    }
    const rawValue = match[2].split(/\s+#/, 1)[0] ?? "";
    const value = stripWrappingQuotes(rawValue);
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveAutomationToken(): { token: string; source: string } {
  for (const key of TOKEN_ENV_KEYS) {
    const fromEnv = (process.env[key] ?? "").trim();
    if (fromEnv) {
      return { token: fromEnv, source: `process.env.${key}` };
    }
  }
  const fromRepoRootEnv = readTokenFromRepoRootEnv();
  if (fromRepoRootEnv) {
    return { token: fromRepoRootEnv, source: "repo-root .env" };
  }
  return { token: "", source: "none" };
}

const backendPort = process.env.BACKEND_PORT?.trim() || "17380";
const apiOrigin = process.env.VITE_DEFAULT_BASE_URL?.trim() || `http://127.0.0.1:${backendPort}`;
const resolvedBackendPortHint = (() => {
  try {
    return new URL(apiOrigin).port || backendPort;
  } catch {
    return backendPort;
  }
})();
const resolvedAutomationToken = resolveAutomationToken();
const automationToken = resolvedAutomationToken.token;
const AUTOMATION_CLIENT_ID_STORAGE_KEY = "ab_automation_client_id";

function buildRequestHeaders(clientId: string) {
  if (!automationToken || !clientId.trim()) {
    return {};
  }
  return {
    "x-automation-token": automationToken,
    "x-automation-client-id": clientId.trim(),
  };
}

function dependencyMessage(reason: string): string {
  const tokenHint = automationToken
    ? `automation token detected from ${resolvedAutomationToken.source}`
    : "no automation token from process.env or repo-root .env";
  return [
    `[frontend-e2e-nonstub] Real backend dependency is missing: ${reason}`,
    `resolved VITE_DEFAULT_BASE_URL=${apiOrigin}`,
    tokenHint,
    "Start backend first, for example:",
    "1) bash scripts/dev-up.sh",
    `2) or export VITE_DEFAULT_BASE_URL=http://127.0.0.1:${resolvedBackendPortHint}`,
    "3) if backend enforces token, export UIQ_AUTOMATION_TOKEN=<real token>",
  ].join("\n");
}

function isInternalNonStubMock(commands: CommandItem[]): boolean {
  if (commands.length !== 1) {
    return false;
  }
  const [command] = commands;
  if (!command) {
    return false;
  }
  return (
    command.command_id === "script-pipeline-capture" &&
    command.title === "Real pipeline command" &&
    (command.description ?? "").includes("non-stub execution path")
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickPreferredCommand(commands: CommandItem[]): CommandItem | undefined {
  const preferred = PREFERRED_COMMAND_IDS.map((commandId) =>
    commands.find((command) => command.command_id === commandId),
  ).find((command): command is CommandItem => Boolean(command));
  if (preferred) {
    return preferred;
  }
  const remotelyRunnable = commands.find(
    (command) => !REMOTE_BLOCKED_COMMAND_IDS.has(command.command_id),
  );
  return remotelyRunnable ?? commands[0];
}

async function assertLiveBackendCompatibility(page: Page): Promise<CommandItem[]> {
  const runtimeClientId =
    (await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AUTOMATION_CLIENT_ID_STORAGE_KEY,
    )) ?? "";
  const requestHeaders = buildRequestHeaders(runtimeClientId);
  let healthResponse = null as Awaited<ReturnType<typeof page.request.get>> | null;
  let lastHealthError = "";
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get(`${apiOrigin}/health`, {
            timeout: 10_000,
            headers: requestHeaders,
          });
          healthResponse = response;
          return response.ok();
        } catch (error) {
          lastHealthError = error instanceof Error ? error.message : String(error);
          return false;
        }
      },
      {
        timeout: 12_000,
        intervals: [250, 500, 750],
      },
    )
    .toBe(true)
    .catch(() => {
      throw new Error(
        dependencyMessage(`/health request failed: ${lastHealthError || "unknown error"}`),
      );
    });
  if (!healthResponse) {
    throw new Error(
      dependencyMessage(`/health request failed: ${lastHealthError || "unknown error"}`),
    );
  }
  if (!healthResponse.ok()) {
    const body = await healthResponse.text();
    throw new Error(
      dependencyMessage(`/health returned ${healthResponse.status()}: ${body.slice(0, 300)}`),
    );
  }
  const healthPayload = (await healthResponse.json()) as { status?: unknown };
  if (healthPayload.status !== "ok") {
    throw new Error(
      dependencyMessage(`/health payload mismatch: status=${String(healthPayload.status)}`),
    );
  }

  let commandsResponse;
  try {
    commandsResponse = await page.request.get(`${apiOrigin}/api/automation/commands`, {
      timeout: 10_000,
      headers: requestHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(dependencyMessage(`/api/automation/commands request failed: ${message}`));
  }
  if (!commandsResponse.ok()) {
    const body = await commandsResponse.text();
    throw new Error(
      dependencyMessage(
        `/api/automation/commands returned ${commandsResponse.status()}: ${body.slice(0, 300)}`,
      ),
    );
  }
  const commandsPayload = (await commandsResponse.json()) as { commands?: unknown };
  if (!Array.isArray(commandsPayload.commands) || commandsPayload.commands.length === 0) {
    throw new Error(
      dependencyMessage(
        `compatible command inventory is required, received commands=${JSON.stringify(commandsPayload.commands).slice(0, 120)}`,
      ),
    );
  }
  const commands = commandsPayload.commands as CommandItem[];
  if (isInternalNonStubMock(commands)) {
    throw new Error(
      dependencyMessage(
        "detected apps/command-center/scripts/mock-backend.mjs command payload; non-stub must hit real backend",
      ),
    );
  }
  return commands;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ab_onboarding_done", "1");
    window.localStorage.setItem("ab_first_use_done", "1");
  });
});

test.afterEach(async ({ context, page }) => {
  await context.clearCookies();
  if (!page.isClosed()) {
    await page
      .evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      })
      .catch(() => undefined);
  }
});

test("@frontend-nonstub @nonstub run and cancel chain over live local api", async ({ page }) => {
  await gotoRootWithFrontendRetry(page);

  await expect(page.getByRole("heading", { level: 1, name: "Pagestress" })).toBeVisible();
  const proxiedFrontendOrigin = new URL(page.url()).origin;
  await page.getByLabel("Target site URL (BASE_URL)").fill(proxiedFrontendOrigin);
  if (automationToken) {
    await page.getByLabel("Access token (API token)").fill(automationToken);
  }
  const backendUnavailable = page.getByText("The backend connection failed.").first();
  if (await backendUnavailable.isVisible()) {
    throw new Error(
      dependencyMessage("frontend rendered backend unavailable state, live backend is required"),
    );
  }
  const runtimeClientId =
    (await page.evaluate(
      (key) => window.localStorage.getItem(key),
      AUTOMATION_CLIENT_ID_STORAGE_KEY,
    )) ?? "";
  const requestHeaders = buildRequestHeaders(runtimeClientId);
  if (automationToken && !requestHeaders["x-automation-client-id"]) {
    throw new Error(dependencyMessage("frontend automation client id is missing"));
  }
  const commands = await assertLiveBackendCompatibility(page);

  await page.getByRole("tab", { name: "Quick Launch" }).click();
  const targetCommand = pickPreferredCommand(commands);
  if (!targetCommand) {
    throw new Error(dependencyMessage("commands payload is empty, cannot execute non-stub flow"));
  }
  const runButton = page
    .locator("article", { hasText: targetCommand.command_id })
    .getByRole("button", { name: /^(Run|Dangerous run)$/ })
    .first();
  await expect(runButton).toBeVisible({ timeout: 10_000 });
  const uiRunResponsePromise = page.waitForResponse(
    async (response) => {
      const request = response.request();
      if (request.method() !== "POST") {
        return false;
      }
      let pathname = "";
      try {
        pathname = new URL(response.url()).pathname;
      } catch {
        return false;
      }
      if (pathname !== "/api/automation/run") {
        return false;
      }
      try {
        const payload = request.postDataJSON() as {
          command?: unknown;
          command_id?: unknown;
        };
        const requestCommand =
          typeof payload.command === "string"
            ? payload.command
            : typeof payload.command_id === "string"
              ? payload.command_id
              : "";
        return requestCommand === targetCommand.command_id;
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  await runButton.click();
  const confirmDangerousRun = page.getByRole("button", { name: "Confirm" }).first();
  const confirmVisible = await confirmDangerousRun.isVisible({ timeout: 1_500 }).catch(() => false);
  if (confirmVisible) {
    await confirmDangerousRun.click();
  }
  const uiRunResponse = await uiRunResponsePromise;
  if (!uiRunResponse.ok()) {
    const body = await uiRunResponse.text();
    throw new Error(
      dependencyMessage(
        `ui-triggered /api/automation/run returned ${uiRunResponse.status()}: ${body.slice(0, 300)}`,
      ),
    );
  }
  const runPayload = (await uiRunResponse.json()) as {
    task?: { task_id?: string; status?: TaskStatus; command_id?: string };
  };
  const responseTask = runPayload.task;
  let createdTask: { task_id: string; status: TaskStatus } | null =
    responseTask &&
    typeof responseTask.task_id === "string" &&
    typeof responseTask.status === "string" &&
    (responseTask.command_id === undefined || responseTask.command_id === targetCommand.command_id)
      ? {
          task_id: responseTask.task_id,
          status: responseTask.status,
        }
      : null;

  if (!createdTask) {
    await expect
      .poll(
        async () => {
          const params = new URLSearchParams({
            limit: "100",
            command_id: targetCommand.command_id,
          });
          const response = await page.request.get(
            `${apiOrigin}/api/automation/tasks?${params.toString()}`,
            {
              headers: requestHeaders,
            },
          );
          if (!response.ok()) {
            return false;
          }
          const payload = (await response.json()) as {
            tasks?: Array<{ task_id: string; command_id: string; status: TaskStatus }>;
          };
          const commandTasks =
            payload.tasks?.filter((task) => task.command_id === targetCommand.command_id) ?? [];
          if (commandTasks.length === 0) {
            return false;
          }
          const observedTask =
            commandTasks.find((task) => task.status === "queued" || task.status === "running") ??
            commandTasks[0];
          createdTask = { task_id: observedTask.task_id, status: observedTask.status };
          return true;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  }

  if (!createdTask) {
    throw new Error(dependencyMessage("run task was not observed in task list"));
  }

  await page.getByRole("tab", { name: "Task Center" }).click();
  const createdTaskLabel = createdTask.task_id.slice(0, 8);
  const createdTaskItem = page.locator("li.task-item", { hasText: createdTaskLabel }).first();
  await expect(createdTaskItem).toBeVisible({ timeout: 15_000 });

  if (createdTask.status === "queued" || createdTask.status === "running") {
    const cancelButton = createdTaskItem.getByRole("button", { name: "Cancel" }).first();
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click();
      await expect(page.getByText(/Cancelled task/)).toBeVisible({ timeout: 10_000 });
    }

    await expect
      .poll(async () => (await createdTaskItem.textContent()) ?? "", { timeout: 10_000 })
      .toMatch(/Cancelled|Succeeded|Failed/);
    return;
  }

  expect(createdTask.status).toMatch(/^(success|failed)$/);
});
