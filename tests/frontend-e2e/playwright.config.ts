// @ts-nocheck

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const TOKEN_ENV_KEYS = [
  "UIQ_AUTOMATION_TOKEN",
  "AUTOMATION_API_TOKEN",
  "AUTOMATION_TOKEN",
] as const;
const DEFAULT_NONSTUB_AUTOMATION_TOKEN = "uiq-local-nonstub-token-1234567890";

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

function isWeakAutomationToken(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.length < 16) {
    return true;
  }
  return /(replace|placeholder|changeme|dummy|example|fake|test-token|strong-token)/i.test(
    normalized,
  );
}

function readTokenFromRepoRootEnv(repoRoot: string): string {
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
    if (value && !isWeakAutomationToken(value)) {
      return value;
    }
  }
  return "";
}

function resolveAutomationToken(repoRoot: string): string {
  for (const key of TOKEN_ENV_KEYS) {
    const fromEnv = (process.env[key] ?? "").trim();
    if (fromEnv && !isWeakAutomationToken(fromEnv)) {
      return fromEnv;
    }
  }
  const fromRepoRootEnv = readTokenFromRepoRootEnv(repoRoot);
  if (fromRepoRootEnv) {
    return fromRepoRootEnv;
  }
  return DEFAULT_NONSTUB_AUTOMATION_TOKEN;
}

function findAvailablePort(startPort: number, maxAttempts: number): number {
  const probeScript = `
const net = require("node:net");
const start = Number.parseInt(process.argv[1], 10);
const attempts = Number.parseInt(process.argv[2], 10);
if (!Number.isInteger(start) || start <= 0 || !Number.isInteger(attempts) || attempts <= 0) {
  process.exit(2);
}
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
(async () => {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    if (await canListen(port)) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(3);
})().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message + "\\n");
  process.exit(4);
});
`;
  const result = spawnSync(
    process.execPath,
    ["-e", probeScript, String(startPort), String(maxAttempts)],
    {
      encoding: "utf8",
    },
  );
  if (result.status === 0) {
    const selected = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isInteger(selected) && selected > 0) {
      return selected;
    }
  }
  throw new Error(
    `Unable to allocate available frontend e2e port from ${startPort} (+${maxAttempts - 1}).` +
      ` stdout='${result.stdout?.trim()}' stderr='${result.stderr?.trim()}' status='${String(result.status)}'`,
  );
}

function readPort(defaultPort: number): number {
  const raw = process.env.UIQ_FRONTEND_E2E_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  const selected = findAvailablePort(defaultPort, 200);
  process.env.UIQ_FRONTEND_E2E_PORT = String(selected);
  return selected;
}

function readBackendPort(): number {
  const grepRaw = (process.env.UIQ_FRONTEND_E2E_GREP ?? "").toLowerCase();
  const argvRaw = process.argv.slice(2).join(" ").toLowerCase();
  const nonStubTarget =
    grepRaw.includes("@frontend-nonstub") ||
    grepRaw.includes("@nonstub") ||
    grepRaw.includes("non-stub") ||
    argvRaw.includes("@frontend-nonstub") ||
    argvRaw.includes("@nonstub") ||
    argvRaw.includes("non-stub");
  const explicit = process.env.BACKEND_PORT;
  const parsed = explicit ? Number.parseInt(explicit, 10) : Number.NaN;
  if (!nonStubTarget && Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  if (nonStubTarget) {
    const nonStubRaw = process.env.UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT;
    const nonStubParsed = nonStubRaw ? Number.parseInt(nonStubRaw, 10) : Number.NaN;
    if (Number.isInteger(nonStubParsed) && nonStubParsed > 0) {
      return nonStubParsed;
    }
    try {
      return findAvailablePort(28000 + Math.abs(process.pid % 10000), 200);
    } catch {
      return findAvailablePort(38000 + Math.abs(process.pid % 10000), 500);
    }
  }
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 30000 + (process.pid % 20000);
}

function resolvePreferredPortBase(): number {
  const deterministicOffset = Math.abs(process.pid % 5000);
  return 43000 + deterministicOffset;
}

function readDefaultPort(): number {
  const raw = process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return resolvePreferredPortBase();
}

const port = readPort(readDefaultPort());
const baseURL = `http://127.0.0.1:${port}`;
const backendPort = readBackendPort();
const backendOrigin = `http://127.0.0.1:${backendPort}`;
process.env.UIQ_FRONTEND_E2E_BASE_URL =
  (process.env.UIQ_FRONTEND_E2E_BASE_URL ?? "").trim() || baseURL;
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "../..");
const nonStubAutomationToken = resolveAutomationToken(repoRoot);
const nonStubDatabasePath = path.resolve(
  repoRoot,
  ".runtime-cache/automation/frontend-e2e-nonstub.db",
);
const nonStubDatabaseUrl = `sqlite+pysqlite:////${nonStubDatabasePath.replaceAll("\\", "/")}`;
process.env.UIQ_AUTOMATION_TOKEN =
  (process.env.UIQ_AUTOMATION_TOKEN ?? "").trim() || nonStubAutomationToken;
process.env.AUTOMATION_API_TOKEN =
  (process.env.AUTOMATION_API_TOKEN ?? "").trim() || nonStubAutomationToken;
process.env.VITE_AUTOMATION_TOKEN =
  (process.env.VITE_AUTOMATION_TOKEN ?? "").trim() || nonStubAutomationToken;
process.env.BACKEND_PORT = process.env.BACKEND_PORT?.trim() || String(backendPort);
process.env.VITE_DEFAULT_BASE_URL = process.env.VITE_DEFAULT_BASE_URL?.trim() || backendOrigin;
const frontendDir = path.resolve(thisDir, "../../apps/command-center");
const nonStubBackendLogPath = path.resolve(
  repoRoot,
  ".runtime-cache/logs/frontend-e2e/nonstub-backend.log",
);
const shellEscapedAutomationToken = escapeShellDoubleQuoted(nonStubAutomationToken);
const shellEscapedBaseUrl = escapeShellDoubleQuoted(baseURL);
const shellEscapedBackendOrigin = escapeShellDoubleQuoted(backendOrigin);
const shellEscapedDatabaseUrl = escapeShellDoubleQuoted(nonStubDatabaseUrl);
const shellEscapedBackendLogPath = escapeShellDoubleQuoted(nonStubBackendLogPath);
const shellEscapedFrontendViteConfigPath = escapeShellDoubleQuoted(
  path.join(frontendDir, "vite.config.ts"),
);
const defaultWorkers = process.env.CI ? "4" : "50%";

function resolveWorkers(): number | string {
  const requestedWorkers = process.env.UIQ_FRONTEND_E2E_WORKERS?.trim() ?? "";
  const matrixOverride = (process.env.UIQ_FRONTEND_E2E_MATRIX ?? "").trim().toLowerCase();
  if (!requestedWorkers && !shouldBootMockBackend()) {
    return 1;
  }
  if (!requestedWorkers && matrixOverride === "pr") {
    return 1;
  }
  const raw = requestedWorkers || defaultWorkers;
  if (/^\d+%$/.test(raw)) {
    return raw;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(
    `Invalid Playwright workers value '${raw}'. Use positive integer or percentage like '50%'.`,
  );
}

function resolveTestTimeout(): number {
  const raw = process.env.UIQ_FRONTEND_E2E_TEST_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 150_000;
}

function resolveRetries(): number {
  const raw = process.env.UIQ_FRONTEND_E2E_RETRIES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  return process.env.CI ? 2 : 1;
}

function resolveOptionalRegex(envName: string): RegExp | undefined {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return new RegExp(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex in ${envName}: ${message}`);
  }
}

type ArtifactPolicy = "failure-only" | "full" | "off";

function resolveArtifactPolicy(): ArtifactPolicy {
  const raw = (process.env.UIQ_E2E_ARTIFACT_POLICY ?? "").trim().toLowerCase();
  if (!raw || raw === "failure-only") {
    return "failure-only";
  }
  if (raw === "full") {
    return "full";
  }
  if (raw === "off") {
    return "off";
  }
  throw new Error(`Invalid UIQ_E2E_ARTIFACT_POLICY '${raw}'. Use one of: failure-only, full, off.`);
}

const grep = resolveOptionalRegex("UIQ_FRONTEND_E2E_GREP");
const grepInvert = resolveOptionalRegex("UIQ_FRONTEND_E2E_GREP_INVERT");
const nonStubTags = ["@frontend-nonstub", "@nonstub"] as const;

function removeStatefulRegexFlags(flags: string): string {
  return flags.replaceAll("g", "").replaceAll("y", "");
}

function regexMatchesAnyTag(regex: RegExp | undefined, tags: readonly string[]): boolean {
  if (!regex) {
    return false;
  }
  const statelessRegex = new RegExp(regex.source, removeStatefulRegexFlags(regex.flags));
  return tags.some((tag) => statelessRegex.test(tag));
}

function argvTargetsNonStub(): boolean {
  const joinedArgs = process.argv.slice(2).join(" ").toLowerCase();
  return (
    joinedArgs.includes("@frontend-nonstub") ||
    joinedArgs.includes("@nonstub") ||
    joinedArgs.includes("non-stub")
  );
}

function shouldBootMockBackend(): boolean {
  const grepTargetsNonStub = regexMatchesAnyTag(grep, nonStubTags);
  const grepInvertsNonStub = regexMatchesAnyTag(grepInvert, nonStubTags);
  if (grepTargetsNonStub) {
    return false;
  }
  if (grepInvertsNonStub) {
    return true;
  }
  if (argvTargetsNonStub()) {
    return false;
  }
  return true;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

function buildRegexFromTags(tags: readonly string[]): RegExp {
  return new RegExp(tags.map((tag) => escapeRegexLiteral(tag)).join("|"));
}

const bootMockBackend = shouldBootMockBackend();
const runNonStubOnly = !bootMockBackend;
const effectiveGrepInvert =
  grepInvert ?? (bootMockBackend && !grep ? buildRegexFromTags(nonStubTags) : undefined);
const stubWebServerCommand = [
  "bash -lc '",
  "set -euo pipefail; ",
  `node "${frontendDir}/scripts/mock-backend.mjs" & `,
  'backend_pid="$!"; ',
  'cleanup(){ kill "${backend_pid}" >/dev/null 2>&1 || true; }; ',
  "trap cleanup EXIT INT TERM; ",
  `"${repoRoot}/scripts/lib/node-bin.sh" vite --config "${shellEscapedFrontendViteConfigPath}" --host 127.0.0.1 --port ${port} --strictPort`,
  "'",
].join("");
const nonStubWebServerCommand = [
  "bash -lc '",
  "set -euo pipefail; ",
  `cd "${repoRoot}"; `,
  `mkdir -p "${path.dirname(nonStubBackendLogPath)}"; `,
  'mkdir -p ".runtime-cache/automation"; ',
  `backend_origin="${shellEscapedBackendOrigin}"; `,
  'status="$(curl -s -o /dev/null -w "%{http_code}" ',
  `-H "x-automation-token: ${shellEscapedAutomationToken}" `,
  '-H "x-automation-client-id: frontend-e2e-bootstrap" ',
  '"${backend_origin}/api/automation/commands" || true)"; ',
  'backend_pid=""; ',
  'if [[ "$status" != "200" ]]; then ',
  `env DATABASE_URL="${shellEscapedDatabaseUrl}" "${repoRoot}/scripts/lib/python-exec.sh" alembic -c alembic.ini upgrade head >/dev/null 2>&1; `,
  `env AUTOMATION_API_TOKEN="${shellEscapedAutomationToken}" CORS_ALLOWED_ORIGINS="${shellEscapedBaseUrl}" AUTOMATION_REQUIRE_TOKEN=1 AUTOMATION_ALLOW_LOCAL_NO_TOKEN=0 DATABASE_URL="${shellEscapedDatabaseUrl}" "${repoRoot}/scripts/lib/python-exec.sh" uvicorn app.main:app --host 127.0.0.1 --port ${backendPort} >"${shellEscapedBackendLogPath}" 2>&1 & `,
  'backend_pid="$!"; ',
  "fi; ",
  'cleanup(){ if [[ -n "${backend_pid:-}" ]]; then kill "${backend_pid}" >/dev/null 2>&1 || true; fi; }; ',
  "trap cleanup EXIT INT TERM; ",
  "ready=0; ",
  "for attempt in $(seq 1 60); do ",
  'code="$(curl -s -o /dev/null -w "%{http_code}" ',
  `-H "x-automation-token: ${shellEscapedAutomationToken}" `,
  '-H "x-automation-client-id: frontend-e2e-bootstrap" ',
  `"${shellEscapedBackendOrigin}/api/automation/commands" || true)"; `,
  'if [[ "$code" == "200" ]]; then ready=1; break; fi; ',
  'if [[ "$attempt" == "1" || "$attempt" == "10" || "$attempt" == "30" || "$attempt" == "60" ]]; then ',
  'echo "[frontend-e2e-nonstub] waiting backend readiness (${attempt}/60, status=${code})"; ',
  "fi; ",
  "sleep 1; ",
  "done; ",
  'if [[ "$ready" != "1" ]]; then ',
  'echo "[frontend-e2e-nonstub] backend readiness failed" >&2; ',
  `tail -n 120 "${shellEscapedBackendLogPath}" 2>/dev/null || true; `,
  "exit 1; ",
  "fi; ",
  `"${repoRoot}/scripts/lib/node-bin.sh" vite --config "${shellEscapedFrontendViteConfigPath}" --host 127.0.0.1 --port ${port} --strictPort`,
  "'",
].join("");

type FrontendE2EMatrix = "local" | "pr" | "nightly";

function resolveMatrixProfile(): FrontendE2EMatrix {
  const raw = (process.env.UIQ_FRONTEND_E2E_MATRIX ?? "").trim().toLowerCase();
  if (!raw) {
    return process.env.CI ? "pr" : "local";
  }
  if (raw === "local" || raw === "pr" || raw === "nightly") {
    return raw;
  }
  throw new Error(`Invalid UIQ_FRONTEND_E2E_MATRIX '${raw}'. Use one of: local, pr, nightly.`);
}

const matrixProfile = resolveMatrixProfile();
const artifactPolicy = resolveArtifactPolicy();
const enableMobileSafari =
  (process.env.UIQ_FRONTEND_E2E_ENABLE_MOBILE_SAFARI ?? "").trim().toLowerCase() === "true";
const nightlyProjects = [
  { name: "frontend-chromium-light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
  { name: "frontend-chromium-dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
  { name: "frontend-firefox-light", use: { ...devices["Desktop Firefox"], colorScheme: "light" } },
  { name: "frontend-firefox-dark", use: { ...devices["Desktop Firefox"], colorScheme: "dark" } },
  { name: "frontend-webkit-light", use: { ...devices["Desktop Safari"], colorScheme: "light" } },
  { name: "frontend-webkit-dark", use: { ...devices["Desktop Safari"], colorScheme: "dark" } },
  { name: "frontend-mobile-chrome-light", use: { ...devices["Pixel 7"], colorScheme: "light" } },
  { name: "frontend-mobile-chrome-dark", use: { ...devices["Pixel 7"], colorScheme: "dark" } },
  ...(enableMobileSafari
    ? [
        {
          name: "frontend-mobile-safari-light",
          use: { ...devices["iPhone 13"], colorScheme: "light" },
        },
        {
          name: "frontend-mobile-safari-dark",
          use: { ...devices["iPhone 13"], colorScheme: "dark" },
        },
      ]
    : []),
];
const projects =
  matrixProfile === "nightly"
    ? nightlyProjects
    : matrixProfile === "pr"
      ? [
          {
            name: "frontend-chromium-light",
            use: { ...devices["Desktop Chrome"], colorScheme: "light" },
          },
          {
            name: "frontend-mobile-chrome-light",
            use: { ...devices["Pixel 7"], colorScheme: "light" },
          },
        ]
      : [
          {
            name: "frontend-chromium-light",
            use: { ...devices["Desktop Chrome"], colorScheme: "light" },
          },
        ];

export default defineConfig({
  testDir: ".",
  testMatch: runNonStubOnly ? "**/non-stub-*.spec.ts" : "**/*.spec.ts",
  outputDir: path.resolve(repoRoot, ".runtime-cache/test-results/frontend-e2e"),
  timeout: resolveTestTimeout(),
  retries: resolveRetries(),
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: resolveWorkers(),
  projects,
  grep,
  grepInvert: effectiveGrepInvert,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.resolve(repoRoot, ".runtime-cache/reports/playwright/frontend-e2e"),
        open: "never",
      },
    ],
  ],
  webServer: {
    command: bootMockBackend ? stubWebServerCommand : nonStubWebServerCommand,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      BACKEND_PORT: String(backendPort),
      VITE_DEFAULT_BASE_URL: backendOrigin,
      // Keep browser-side nonstub traffic on the frontend origin so Vite's
      // proxy can reach the real backend without a browser CORS hop.
      VITE_API_BASE_URL: "",
      UIQ_AUTOMATION_TOKEN: nonStubAutomationToken,
      AUTOMATION_API_TOKEN: nonStubAutomationToken,
      VITE_AUTOMATION_TOKEN: nonStubAutomationToken,
      AUTOMATION_REQUIRE_TOKEN: "1",
      AUTOMATION_ALLOW_LOCAL_NO_TOKEN: "0",
      CORS_ALLOWED_ORIGINS: baseURL,
    },
  },
  use: {
    baseURL,
    extraHTTPHeaders: bootMockBackend
      ? undefined
      : {
          "x-automation-token": nonStubAutomationToken,
          "x-automation-client-id": "frontend-e2e-browser",
        },
    headless: true,
    screenshot:
      artifactPolicy === "full" ? "on" : artifactPolicy === "off" ? "off" : "only-on-failure",
    trace:
      artifactPolicy === "full" ? "on" : artifactPolicy === "off" ? "off" : "retain-on-failure",
    video:
      artifactPolicy === "full" ? "on" : artifactPolicy === "off" ? "off" : "retain-on-failure",
  },
});
