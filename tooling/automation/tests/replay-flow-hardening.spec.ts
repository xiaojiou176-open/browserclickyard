import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

type FlowStep = {
  step_id: string;
  action: string;
  url?: string;
  value_ref?: string;
  gate_policy?: string;
  gate_reason?: string;
  target?: {
    selectors: Array<{ kind: "role" | "css" | "id" | "name"; value: string; score: number }>;
  };
};

type FlowDraft = {
  flow_id: string;
  session_id: string;
  start_url: string;
  steps: FlowStep[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.resolve(AUTOMATION_ROOT, "..", ".runtime-cache", "automation");

function createSession(flow: Omit<FlowDraft, "flow_id" | "session_id">): {
  sessionId: string;
  sessionDir: string;
} {
  const sessionId = `hardening-${randomUUID()}`;
  const sessionDir = path.join(RUNTIME_ROOT, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const draft: FlowDraft = {
    flow_id: `flow-${sessionId}`,
    session_id: sessionId,
    ...flow,
  };
  writeFileSync(path.join(sessionDir, "flow-draft.json"), JSON.stringify(draft, null, 2), "utf-8");
  pointLatestSession(sessionDir, sessionId);
  return { sessionId, sessionDir };
}

function runReplayFlowDraft(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
  return spawnSync("pnpm", ["node", "--import", "tsx", "scripts/replay-flow-draft.ts"], {
    cwd: AUTOMATION_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function runReplayFlowStep(env: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
  return spawnSync("pnpm", ["node", "--import", "tsx", "scripts/replay-flow-step.ts"], {
    cwd: AUTOMATION_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function pointLatestSession(sessionDir: string, sessionId: string): void {
  writeFileSync(
    path.join(RUNTIME_ROOT, "latest-session.json"),
    JSON.stringify({ sessionDir, sessionId }, null, 2),
    "utf-8",
  );
}

test("unsupported action fails explicitly and fast-stops following steps", async () => {
  const { sessionDir } = createSession({
    start_url: "data:text/html,<html><body><h1>demo</h1></body></html>",
    steps: [
      {
        step_id: "s1",
        action: "navigate",
        url: "data:text/html,<html><body><h1>demo</h1></body></html>",
      },
      { step_id: "s2", action: "unknown_action" },
      {
        step_id: "s3",
        action: "click",
        target: { selectors: [{ kind: "css", value: "button", score: 10 }] },
      },
    ],
  });

  const run = runReplayFlowDraft({
    HEADLESS: "true",
  });

  expect(run.status).not.toBe(0);
  const output = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    stepResults: Array<{ step_id: string; ok: boolean; detail: string }>;
  };
  const failedStep = output.stepResults.find((item) => item.step_id === "s2");
  const skippedStep = output.stepResults.find((item) => item.step_id === "s3");
  expect(failedStep?.ok).toBe(false);
  expect(failedStep?.detail).toContain("unsupported action");
  expect(skippedStep).toBeUndefined();
});

test("FLOW_FROM_STEP_ID not found returns explicit error", async () => {
  createSession({
    start_url: "data:text/html,<html><body>demo</body></html>",
    steps: [
      { step_id: "s1", action: "navigate", url: "data:text/html,<html><body>demo</body></html>" },
    ],
  });

  const run = runReplayFlowDraft({
    FLOW_FROM_STEP_ID: "missing-step",
    HEADLESS: "true",
  });

  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("FLOW_FROM_STEP_ID not found");
});

test("role selector executes and sensitive OTP type step does not capture screenshots by default", async () => {
  const html = encodeURIComponent(
    `<html><body><input name="otp" /><button>Submit</button></body></html>`,
  );
  const url = `data:text/html,${html}`;
  const { sessionDir } = createSession({
    start_url: url,
    steps: [
      { step_id: "s1", action: "navigate", url },
      {
        step_id: "s2",
        action: "type",
        value_ref: "${params.otp}",
        target: { selectors: [{ kind: "name", value: "otp", score: 90 }] },
      },
      {
        step_id: "s3",
        action: "click",
        target: { selectors: [{ kind: "role", value: "button[name='Submit']", score: 90 }] },
      },
    ],
  });

  const run = runReplayFlowDraft({
    FLOW_OTP_CODE: "123456",
    HEADLESS: "true",
  });

  expect(run.status).toBe(0);
  const output = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    success: boolean;
    manualGate: { required: boolean };
    stepResults: Array<{
      step_id: string;
      ok: boolean;
      screenshot_before_path: string | null;
      screenshot_after_path: string | null;
    }>;
  };
  expect(output.success).toBe(true);
  expect(output.manualGate.required).toBe(false);
  const otpStep = output.stepResults.find((item) => item.step_id === "s2");
  expect(otpStep?.ok).toBe(true);
  expect(otpStep?.screenshot_before_path).toBeNull();
  expect(otpStep?.screenshot_after_path).toBeNull();
});

test("manual gate OTP fallback uses selector hint even without otp value_ref", async () => {
  const html = encodeURIComponent(`<html><body><input name="otp_code" /></body></html>`);
  const url = `data:text/html,${html}`;
  const { sessionDir } = createSession({
    start_url: url,
    steps: [
      { step_id: "s1", action: "navigate", url },
      {
        step_id: "s2",
        action: "manual_gate",
        value_ref: "${params.input}",
        target: { selectors: [{ kind: "name", value: "otp_code", score: 90 }] },
      },
    ],
  });

  const run = runReplayFlowDraft({
    FLOW_OTP_CODE: "654321",
    HEADLESS: "true",
  });

  expect(run.status).toBe(0);
  const output = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    success: boolean;
    stepResults: Array<{ step_id: string; ok: boolean; action: string; detail: string }>;
  };
  const otpStep = output.stepResults.find((item) => item.step_id === "s2");
  expect(output.success).toBe(true);
  expect(otpStep?.ok).toBe(true);
  expect(otpStep?.action).toBe("type");
  expect(otpStep?.detail).toContain("filled OTP");
});

test("force_manual policy gate returns manual_gate status with provider metadata and skips following steps", async () => {
  const { sessionDir } = createSession({
    start_url: "https://example.com",
    steps: [
      { step_id: "s1", action: "navigate", url: "https://example.com" },
      {
        step_id: "s2",
        action: "type",
        value_ref: "${params.input}",
        gate_policy: "force_manual",
        gate_reason: "provider_protected_payment_step",
        target: { selectors: [{ kind: "name", value: "account_name", score: 90 }] },
      },
      {
        step_id: "s3",
        action: "click",
        target: { selectors: [{ kind: "role", value: "button[name='Continue']", score: 90 }] },
      },
    ],
  });

  const run = runReplayFlowDraft({
    FLOW_PROTECTED_PROVIDER_DOMAINS: "example.com",
    HEADLESS: "true",
  });

  expect(run.status).toBe(0);
  const output = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    status: string;
    success: boolean;
    manualGate: {
      required: boolean;
      reason_code: string | null;
      resume_from_step_id: string | null;
      provider_domain: string | null;
      gate_required_by_policy: boolean;
    };
    stepResults: Array<{
      step_id: string;
      manual_gate_required?: boolean;
      gate_required_by_policy: boolean;
      provider_domain: string | null;
    }>;
  };
  expect(output.status).toBe("manual_gate");
  expect(output.success).toBe(false);
  expect(output.manualGate.required).toBe(true);
  expect(output.manualGate.reason_code).toBe("provider_protected_payment_step");
  expect(output.manualGate.resume_from_step_id).toBe("s3");
  expect(output.manualGate.provider_domain).toBe("example.com");
  expect(output.manualGate.gate_required_by_policy).toBe(true);

  const gatedStep = output.stepResults.find((item) => item.step_id === "s2");
  const skippedStep = output.stepResults.find((item) => item.step_id === "s3");
  expect(gatedStep?.manual_gate_required).toBe(true);
  expect(gatedStep?.gate_required_by_policy).toBe(true);
  expect(gatedStep?.provider_domain).toBe("example.com");
  expect(skippedStep).toBeUndefined();
});

test("manual gate persists resume context and replay-flow-step can resume from snapshot URL", async () => {
  const blockedStart = "http://127.0.0.1:9/unreachable";
  const resumeUrl = `data:text/html,${encodeURIComponent('<html><body><input name="otp" /></body></html>')}`;
  const { sessionDir } = createSession({
    start_url: blockedStart,
    steps: [
      { step_id: "s1", action: "manual_gate" },
      {
        step_id: "s2",
        action: "type",
        value_ref: "${params.otp}",
        target: { selectors: [{ kind: "name", value: "otp", score: 90 }] },
      },
    ],
  });

  const runDraft = runReplayFlowDraft({
    START_URL: resumeUrl,
    HEADLESS: "true",
  });
  expect(runDraft.status).toBe(0);
  const draftOutput = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    status: string;
    manualGate: {
      reason_code: string | null;
      resume_from_step_id: string | null;
      gate_required_by_policy: boolean;
    };
  };
  expect(draftOutput.status).toBe("manual_gate");
  expect(draftOutput.manualGate.reason_code).toBe("flow_manual_gate_step");
  expect(draftOutput.manualGate.resume_from_step_id).toBe("s2");
  expect(draftOutput.manualGate.gate_required_by_policy).toBe(false);
  const storagePath = path.join(sessionDir, "replay-resume-storage-state.json");
  const snapshotPath = path.join(sessionDir, "replay-resume-session.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as { current_url: string };
  expect(readFileSync(storagePath, "utf-8").length).toBeGreaterThan(0);
  expect(snapshot.current_url).toContain("data:text/html");

  const runStep = runReplayFlowStep({
    FLOW_STEP_ID: "s2",
    FLOW_OTP_CODE: "246810",
    HEADLESS: "true",
  });
  expect(runStep.status).toBe(0);
  const stepOutput = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-step-result.json"), "utf-8"),
  ) as {
    ok: boolean;
    detail: string;
  };
  expect(stepOutput.ok).toBe(true);
  expect(stepOutput.detail).toContain("filled");
});

test("replay-flow-step treats force_manual policy as manual gate without hard failure", async () => {
  const { sessionDir } = createSession({
    start_url: "https://example.com",
    steps: [
      { step_id: "s1", action: "navigate", url: "https://example.com" },
      {
        step_id: "s2",
        action: "type",
        value_ref: "${params.input}",
        gate_policy: "force_manual",
        gate_reason: "provider_protected_payment_step",
        target: { selectors: [{ kind: "name", value: "account_name", score: 90 }] },
      },
    ],
  });

  const runStep = runReplayFlowStep({
    FLOW_STEP_ID: "s2",
    FLOW_PROTECTED_PROVIDER_DOMAINS: "example.com",
    HEADLESS: "true",
  });
  expect(runStep.status).toBe(0);

  const stepOutput = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-step-result.json"), "utf-8"),
  ) as {
    ok: boolean;
    manual_gate_required?: boolean;
    gate_required_by_policy: boolean;
    provider_domain: string | null;
    detail: string;
  };
  expect(stepOutput.ok).toBe(false);
  expect(stepOutput.manual_gate_required).toBe(true);
  expect(stepOutput.gate_required_by_policy).toBe(true);
  expect(stepOutput.provider_domain).toBe("example.com");
  expect(stepOutput.detail).toContain("manual gate required by policy");
});
