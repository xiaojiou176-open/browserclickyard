import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

type SessionMeta = {
  sessionId: string;
  eventLogPath: string;
  flowDraftPath: string;
  harPath: string | null;
  tracePath: string | null;
  storageStatePath: string | null;
  videoDir: string | null;
  capturePolicy: {
    allowSensitiveCapture: boolean;
    allowSensitiveTrace: boolean;
    allowSensitiveStorage: boolean;
    allowSensitiveInputValues: boolean;
    captureHar: boolean;
    captureVideo: boolean;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.resolve(AUTOMATION_ROOT, "..", ".runtime-cache", "automation");

function writeDriverFile(driverPath: string, code: string): void {
  writeFileSync(driverPath, code, "utf-8");
}

test("record-session uses secure capture defaults and marks protected payment steps", async () => {
  const sessionId = `secure-defaults-${randomUUID()}`;
  const driverDir = path.join(AUTOMATION_ROOT, ".runtime-cache", "test-drivers");
  mkdirSync(driverDir, { recursive: true });
  const driverPath = path.join(driverDir, `${sessionId}.ts`);
  const html = encodeURIComponent(
    '<html><body><input name="otp_code"/><input name="password"/><input name="cardnumber"/></body></html>',
  );
  const startUrl = `data:text/html,${html}`;
  writeDriverFile(
    driverPath,
    `export async function runMidsceneTakeover(context) {
  await context.page.goto(${JSON.stringify(startUrl)}, { waitUntil: 'networkidle' });
  await context.page.fill('input[name="otp_code"]', '123456');
  await context.page.fill('input[name="password"]', 'SuperSecret!');
  await context.page.fill('input[name="cardnumber"]', '4242424242424242');
}`,
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/record-session.ts",
      "--mode=midscene",
      `--driver=${driverPath}`,
    ],
    {
      cwd: AUTOMATION_ROOT,
      env: {
        ...process.env,
        SESSION_ID: sessionId,
        HEADLESS: "true",
        FLOW_ALLOW_SENSITIVE_CAPTURE: "false",
        FLOW_ALLOW_SENSITIVE_TRACE: "true",
        FLOW_ALLOW_SENSITIVE_STORAGE: "true",
        FLOW_ALLOW_SENSITIVE_INPUT_VALUES: "true",
      },
      encoding: "utf-8",
      timeout: 120000,
    },
  );

  expect(run.status).toBe(0);
  const meta = JSON.parse(run.stdout) as SessionMeta;
  expect(meta.capturePolicy.allowSensitiveCapture).toBe(false);
  expect(meta.capturePolicy.allowSensitiveTrace).toBe(false);
  expect(meta.capturePolicy.allowSensitiveStorage).toBe(false);
  expect(meta.capturePolicy.allowSensitiveInputValues).toBe(false);
  expect(meta.capturePolicy.captureHar).toBe(false);
  expect(meta.capturePolicy.captureVideo).toBe(false);
  expect(meta.harPath).toBeNull();
  expect(meta.tracePath).toBeNull();
  expect(meta.storageStatePath).toBeNull();
  expect(meta.videoDir).toBeNull();

  const events = JSON.parse(readFileSync(meta.eventLogPath, "utf-8")) as Array<{
    value?: string;
    target: { name?: string | null };
  }>;
  const otpEvent = events.find((item) => (item.target.name ?? "").includes("otp"));
  const passwordEvent = events.find((item) => (item.target.name ?? "").includes("password"));
  expect(otpEvent?.value).toBe("__redacted__");
  expect(passwordEvent?.value).toBe("__redacted__");

  const flow = JSON.parse(readFileSync(meta.flowDraftPath, "utf-8")) as {
    steps: Array<{
      step_id: string;
      action: string;
      value_ref?: string;
      gate_policy?: string;
      gate_reason?: string;
      target?: { selectors: Array<{ kind: string; value: string }> };
    }>;
  };
  const otpStep = flow.steps.find(
    (step) =>
      step.action === "type" &&
      (step.target?.selectors ?? []).some((selector) => selector.value.includes("otp_code")),
  );
  const passwordStep = flow.steps.find(
    (step) =>
      step.action === "type" &&
      (step.target?.selectors ?? []).some((selector) => selector.value.includes("password")),
  );
  const cardStep = flow.steps.find(
    (step) =>
      step.action === "type" &&
      (step.target?.selectors ?? []).some((selector) => selector.value.includes("cardnumber")),
  );
  expect(otpStep?.value_ref).toBe("${params.otp}");
  expect(passwordStep?.value_ref).toBe("${secrets.input}");
  expect(cardStep?.gate_policy).toBe("force_manual");
  expect(cardStep?.gate_reason).toBe("provider_protected_payment_step");

  const sessionDir = path.join(RUNTIME_ROOT, sessionId);
  expect(() => readFileSync(path.join(sessionDir, "trace.zip"), "utf-8")).toThrow();
  expect(() => readFileSync(path.join(sessionDir, "storage-state.json"), "utf-8")).toThrow();
});

test("record-session applies default gate policy for protected provider domains", async () => {
  const sessionId = `provider-domain-gate-${randomUUID()}`;
  const driverDir = path.join(AUTOMATION_ROOT, ".runtime-cache", "test-drivers");
  mkdirSync(driverDir, { recursive: true });
  const driverPath = path.join(driverDir, `${sessionId}.ts`);
  writeDriverFile(
    driverPath,
    `export async function runMidsceneTakeover(context) {
  await context.page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await context.page.evaluate(() => {
    document.body.innerHTML = '<input name="account_name" />';
  });
  await context.page.fill('input[name="account_name"]', 'demo-account');
}`,
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/record-session.ts",
      "--mode=midscene",
      `--driver=${driverPath}`,
    ],
    {
      cwd: AUTOMATION_ROOT,
      env: {
        ...process.env,
        SESSION_ID: sessionId,
        HEADLESS: "true",
        FLOW_PROTECTED_PROVIDER_DOMAINS: "example.com",
      },
      encoding: "utf-8",
      timeout: 120000,
    },
  );

  expect(run.status).toBe(0);
  const meta = JSON.parse(run.stdout) as SessionMeta;
  const flow = JSON.parse(readFileSync(meta.flowDraftPath, "utf-8")) as {
    steps: Array<{
      step_id: string;
      action: string;
      gate_policy?: string;
      gate_reason?: string;
      target?: { selectors: Array<{ kind: string; value: string }> };
    }>;
  };
  const accountStep = flow.steps.find(
    (step) =>
      step.action === "type" &&
      (step.target?.selectors ?? []).some((selector) => selector.value.includes("account_name")),
  );
  expect(accountStep?.gate_policy).toBe("force_manual");
  expect(accountStep?.gate_reason).toBe("provider_protected_payment_step");
});
