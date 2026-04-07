import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { gotoRootWithFrontendRetry } from "./support/frontend-navigation";

type CommandItem = {
  command_id: string;
  title: string;
  description: string;
  tags: string[];
};

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
    command.description.includes("non-stub execution path")
  );
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

test("@frontend-nonstub @nonstub command list api and ui rendering stay consistent without route stubs", async ({
  page,
}) => {
  const headers = automationToken
    ? {
        "x-automation-token": automationToken,
        "x-automation-client-id": "frontend-e2e-nonstub-consistency",
      }
    : {};
  const commandsResponse = await page.request.get(`${apiOrigin}/api/automation/commands`, {
    timeout: 10_000,
    headers,
  });
  if (!commandsResponse.ok()) {
    const body = await commandsResponse.text();
    throw new Error(
      dependencyMessage(
        `/api/automation/commands returned ${commandsResponse.status()}: ${body.slice(0, 300)}`,
      ),
    );
  }

  const payload = (await commandsResponse.json()) as { commands?: CommandItem[] };
  const commands = payload.commands ?? [];
  expect(commands.length).toBeGreaterThan(0);
  if (isInternalNonStubMock(commands)) {
    throw new Error(
      dependencyMessage(
        "detected apps/command-center/scripts/mock-backend.mjs command payload; non-stub must hit real backend",
      ),
    );
  }
  for (const command of commands.slice(0, 3)) {
    expect(command.command_id.length).toBeGreaterThan(0);
    expect(command.title.length).toBeGreaterThan(0);
    expect(command.tags).toEqual(expect.any(Array));
  }

  const firstCommand = commands[0];
  if (!firstCommand) {
    throw new Error(
      dependencyMessage("commands payload unexpectedly empty after non-empty length check"),
    );
  }

  await gotoRootWithFrontendRetry(page);
  await expect(page.getByRole("heading", { level: 1, name: "Prooflane" })).toBeVisible();
  const proxiedFrontendOrigin = new URL(page.url()).origin;
  await page.getByLabel("Target site URL (BASE_URL)").fill(proxiedFrontendOrigin);
  if (automationToken) {
    await page.getByLabel("Access token (API token)").fill(automationToken);
  }

  const backendUnavailable = page.getByText("The backend connection failed.").first();
  if (await backendUnavailable.isVisible()) {
    throw new Error(dependencyMessage('UI reports backend unavailable ("The backend connection failed.")'));
  }

  await page.getByRole("tab", { name: "Quick Launch" }).click();
  await expect(page.getByText(firstCommand.command_id).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: firstCommand.title }).first(),
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        const normalRunButtons = await page.getByRole("button", { name: "Run" }).count();
        const dangerousRunButtons = await page.getByRole("button", { name: "Dangerous run" }).count();
        return normalRunButtons + dangerousRunButtons;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(commands.length);
});
