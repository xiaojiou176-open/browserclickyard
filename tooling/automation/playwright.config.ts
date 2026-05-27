import { URL } from "node:url";
import { defineConfig } from "@playwright/test";

function parseBaseUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const envBaseUrl = parseBaseUrl(process.env.BASE_URL);
const backendPort = Number(
  envBaseUrl?.port || process.env.AUTOMATION_BACKEND_PORT || process.env.BACKEND_PORT || "17380",
);
const backendBaseUrl = envBaseUrl?.origin ?? `http://127.0.0.1:${backendPort}`;
const defaultWorkers = process.env.CI ? "4" : "50%";

function resolveWorkers(): number | string {
  const raw = defaultWorkers;
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

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  workers: resolveWorkers(),
  outputDir: "../../.runtime-cache/automation/test-results",
  webServer: {
    command: `../../scripts/lib/python-exec.sh uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
    url: `${backendBaseUrl}/health/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: backendBaseUrl,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../.runtime-cache/automation/playwright-report", open: "never" }],
  ],
});
