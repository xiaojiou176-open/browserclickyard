import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

type CommandItem = {
  command_id: string;
  title?: string;
  description?: string;
  tags?: string[];
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
const requestHeaders = automationToken
  ? {
      "x-automation-token": automationToken,
      "x-automation-client-id": "frontend-e2e-nonstub-availability",
    }
  : {};

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

test("@frontend-nonstub @nonstub command inventory is available from real backend", async ({
  page,
}) => {
  const response = await page.request.get(`${apiOrigin}/api/automation/commands`, {
    timeout: 10_000,
    headers: requestHeaders,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      dependencyMessage(
        `/api/automation/commands returned ${response.status()}: ${body.slice(0, 300)}`,
      ),
    );
  }

  const payload = (await response.json()) as { commands?: CommandItem[] };
  const commands = payload.commands ?? [];
  expect(commands.length).toBeGreaterThan(0);
  if (isInternalNonStubMock(commands)) {
    throw new Error(
      dependencyMessage(
        "detected apps/command-center/scripts/mock-backend.mjs command payload; non-stub must hit real backend",
      ),
    );
  }
  expect(commands.some((command) => (command.command_id ?? "").trim().length > 0)).toBe(true);
  expect(
    commands.some(
      (command) =>
        (command.title ?? "").trim().length > 0 || (command.description ?? "").trim().length > 0,
    ),
  ).toBe(true);
});
