import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

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
})().catch(() => process.exit(4));
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
  throw new Error(`Unable to allocate tests/web-harness e2e port from ${startPort}.`);
}

function resolveWebPort(): number {
  const explicit = Number.parseInt(
    process.env.UIQ_WEB_APP_E2E_PORT ?? process.env.UIQ_WEB_PORT ?? "",
    10,
  );
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  const selected = findAvailablePort(44173, 200);
  process.env.UIQ_WEB_APP_E2E_PORT = String(selected);
  process.env.UIQ_WEB_PORT = String(selected);
  return selected;
}

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const webPort = resolveWebPort();
const webBaseUrl =
  readNonEmptyEnv("UIQ_WEB_APP_E2E_BASE_URL") ??
  readNonEmptyEnv("UIQ_BASE_URL") ??
  `http://127.0.0.1:${webPort}`;
const defaultWorkers = process.env.CI ? "1" : "1";
const defaultRetries = process.env.CI ? 1 : 0;
const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFilePath), "../../../../");
const webViteConfigPath = resolve(repoRoot, "tests/web-harness/vite.config.ts");
const quotedWebViteConfigPath = JSON.stringify(webViteConfigPath);

function resolveWorkers(): number | string {
  const raw = process.env.UIQ_PLAYWRIGHT_E2E_WORKERS ?? defaultWorkers;
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

function resolveRetries(): number {
  const raw = process.env.UIQ_WEB_E2E_RETRIES ?? String(defaultRetries);
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 2) {
    return parsed;
  }
  throw new Error(`Invalid UIQ_WEB_E2E_RETRIES '${raw}'. Use integer in range 0-2.`);
}

type WebE2EMatrix = "local" | "pr" | "nightly";

function resolveMatrixProfile(): WebE2EMatrix {
  const raw = (process.env.UIQ_WEB_E2E_MATRIX ?? "").trim().toLowerCase();
  if (!raw) {
    return process.env.CI ? "pr" : "local";
  }
  if (raw === "local" || raw === "pr" || raw === "nightly") {
    return raw;
  }
  throw new Error(`Invalid UIQ_WEB_E2E_MATRIX '${raw}'. Use one of: local, pr, nightly.`);
}

const matrixProfile = resolveMatrixProfile();
const nightlyProjects = [
  { name: "web-chromium-light", use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
  { name: "web-chromium-dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
  { name: "web-firefox-light", use: { ...devices["Desktop Firefox"], colorScheme: "light" } },
  { name: "web-firefox-dark", use: { ...devices["Desktop Firefox"], colorScheme: "dark" } },
  { name: "web-webkit-light", use: { ...devices["Desktop Safari"], colorScheme: "light" } },
  { name: "web-webkit-dark", use: { ...devices["Desktop Safari"], colorScheme: "dark" } },
  { name: "web-mobile-chrome-light", use: { ...devices["Pixel 7"], colorScheme: "light" } },
  { name: "web-mobile-chrome-dark", use: { ...devices["Pixel 7"], colorScheme: "dark" } },
  { name: "web-mobile-safari-light", use: { ...devices["iPhone 13"], colorScheme: "light" } },
  { name: "web-mobile-safari-dark", use: { ...devices["iPhone 13"], colorScheme: "dark" } },
];
const projects =
  matrixProfile === "nightly"
    ? nightlyProjects
    : matrixProfile === "pr"
      ? [
          {
            name: "web-chromium-light",
            use: { ...devices["Desktop Chrome"], colorScheme: "light" },
          },
          { name: "web-mobile-chrome-light", use: { ...devices["Pixel 7"], colorScheme: "light" } },
        ]
      : [
          {
            name: "web-chromium-light",
            use: { ...devices["Desktop Chrome"], colorScheme: "light" },
          },
        ];

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: resolve(repoRoot, ".runtime-cache/test-results/apps-web-e2e"),
  timeout: 45_000,
  retries: resolveRetries(),
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: resolveWorkers(),
  projects,
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: resolve(repoRoot, ".runtime-cache/reports/playwright/apps-web-e2e"), open: "never" },
    ],
  ],
  webServer: {
    command: `bash scripts/lib/node-bin.sh vite --config ${quotedWebViteConfigPath} --host 127.0.0.1 --port ${webPort} --strictPort`,
    cwd: repoRoot,
    url: `${webBaseUrl}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  use: {
    baseURL: webBaseUrl,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
});
