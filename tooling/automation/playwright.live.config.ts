import { defineConfig } from "@playwright/test";

const defaultWorkers = process.env.CI ? "2" : "50%";
const MAX_RETRIES = 2;
const TRUE_PATTERN = /^(1|true|yes|on)$/i;

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

function resolveRetries(): number {
  const raw = process.env.UIQ_LIVE_RETRIES ?? "0";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid live retries value '${raw}'. Use integer in range 0-${MAX_RETRIES}.`);
  }
  return Math.min(parsed, MAX_RETRIES);
}

function resolveAllowInsecureCerts(): boolean {
  return TRUE_PATTERN.test(process.env.UIQ_LIVE_ALLOW_INSECURE_CERTS ?? "");
}

function resolveHeadless(): boolean {
  const raw = process.env.HEADLESS?.trim();
  if (!raw) {
    return true;
  }
  return TRUE_PATTERN.test(raw);
}

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  workers: resolveWorkers(),
  retries: resolveRetries(),
  maxFailures: 1,
  outputDir: "../../.runtime-cache/automation/live-test-results",
  reporter: [["list"]],
  use: {
    headless: resolveHeadless(),
    ignoreHTTPSErrors: resolveAllowInsecureCerts(),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
