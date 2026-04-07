import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import {
  detect3DSManualGate,
  isOtpStep,
  runStep,
  shouldCaptureScreenshotsForStep,
  waitPrecondition,
} from "./lib/replay-flow-execute.js";
import {
  parseProtectedProviderDomains,
  readJson,
  resolveFlowPath,
  resolveFromStepIndex,
  resolveProviderDomainForStep,
} from "./lib/replay-flow-parse.js";
import { loadResumeContext, persistResumeContext } from "./lib/replay-flow-resume.js";
import type {
  FlowDraft,
  ManualGateSignal,
  ReplayStepResult,
  SelectorAttempt,
} from "./lib/replay-flow-types.js";

async function main(): Promise<void> {
  const { flowPath, sessionDir } = await resolveFlowPath();
  const flow = await readJson<FlowDraft>(flowPath);
  const fromStepIndex = resolveFromStepIndex(flow);
  const fromStepId = flow.steps[fromStepIndex]?.step_id ?? null;
  const startUrl = process.env.START_URL?.trim() || flow.start_url;
  const replayPreconditions = process.env.FLOW_REPLAY_PRECONDITIONS === "true";
  const protectedProviderDomains = parseProtectedProviderDomains(
    process.env.FLOW_PROTECTED_PROVIDER_DOMAINS,
  );
  const explicitHeadless = process.env.HEADLESS;
  const headless = explicitHeadless ? explicitHeadless !== "false" : true;

  const browser = await chromium.launch({ headless });
  const resumeContext = await loadResumeContext(sessionDir);
  const shouldTryResume = fromStepIndex > 0 || process.env.FLOW_RESUME_CONTEXT === "true";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ...(shouldTryResume && resumeContext.storageStatePath
      ? { storageState: resumeContext.storageStatePath }
      : {}),
  });
  const page = await context.newPage();
  const results: ReplayStepResult[] = [];
  const evidenceDir = path.join(sessionDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const preconditionChecks: Array<{
    step_id: string;
    ok: boolean;
    detail: string;
    fallback_trail: SelectorAttempt[];
  }> = [];
  const manualGate: ManualGateSignal = {
    required: false,
    reason: null,
    reason_code: null,
    at_step_id: null,
    after_step_id: null,
    resume_from_step_id: null,
    provider_domain: null,
    gate_required_by_policy: false,
    signals: [],
    resume_hint: null,
  };

  try {
    const targetUrl =
      shouldTryResume && resumeContext.snapshot?.current_url
        ? resumeContext.snapshot.current_url
        : startUrl;
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    if (fromStepIndex > 0 && replayPreconditions) {
      for (const step of flow.steps.slice(0, fromStepIndex)) {
        const check = await waitPrecondition(page, step);
        preconditionChecks.push({ step_id: step.step_id, ...check });
      }
    }

    const replaySteps = flow.steps.slice(fromStepIndex);
    for (let replayIndex = 0; replayIndex < replaySteps.length; replayIndex += 1) {
      const step = replaySteps[replayIndex]!;
      const nextStepId = replaySteps[replayIndex + 1]?.step_id ?? null;
      const beforePath = path.join(evidenceDir, `${step.step_id}-before.png`);
      const afterPath = path.join(evidenceDir, `${step.step_id}-after.png`);
      const captureScreenshots = shouldCaptureScreenshotsForStep(step);
      if (captureScreenshots) {
        await page.screenshot({ path: beforePath, fullPage: true });
      }
      try {
        const result = await runStep(page, step, protectedProviderDomains);
        if (captureScreenshots) {
          await page.screenshot({ path: afterPath, fullPage: true });
          result.screenshot_before_path = beforePath;
          result.screenshot_after_path = afterPath;
        }
        results.push(result);
        if (result.manual_gate_required) {
          await persistResumeContext(context, page, sessionDir, "manual_gate", step.step_id);
          manualGate.required = true;
          manualGate.reason = result.detail;
          manualGate.reason_code =
            step.gate_reason ??
            (result.gate_required_by_policy
              ? "manual_gate_required_by_policy"
              : "flow_manual_gate_step");
          manualGate.at_step_id = step.step_id;
          manualGate.after_step_id = step.step_id;
          manualGate.resume_from_step_id = nextStepId;
          manualGate.provider_domain = result.provider_domain;
          manualGate.gate_required_by_policy = result.gate_required_by_policy;
          manualGate.signals = result.gate_required_by_policy
            ? ["provider-gate-policy"]
            : ["flow-manual-gate-step"];
          manualGate.resume_hint = result.gate_required_by_policy
            ? nextStepId
              ? `complete provider-hosted payment step manually, then rerun with FLOW_FROM_STEP_ID=${nextStepId}`
              : "complete provider-hosted payment step manually, then rerun without FLOW_FROM_STEP_ID"
            : nextStepId
              ? `complete challenge manually, then rerun with FLOW_FROM_STEP_ID=${nextStepId}`
              : "complete challenge manually, then rerun without FLOW_FROM_STEP_ID";
          break;
        }
        const challenge = isOtpStep(step)
          ? { required: false, signals: [] as string[] }
          : await detect3DSManualGate(page);
        if (challenge.required) {
          await persistResumeContext(context, page, sessionDir, "manual_gate", step.step_id);
          manualGate.required = true;
          manualGate.reason = "3DS challenge detected; manual completion required";
          manualGate.reason_code = "three_ds_challenge_detected";
          manualGate.after_step_id = step.step_id;
          manualGate.resume_from_step_id = nextStepId ?? step.step_id;
          manualGate.provider_domain = resolveProviderDomainForStep(
            step,
            page.url(),
            protectedProviderDomains,
          );
          manualGate.gate_required_by_policy = false;
          manualGate.signals = challenge.signals;
          manualGate.resume_hint = nextStepId
            ? `complete 3DS challenge manually, then rerun with FLOW_FROM_STEP_ID=${nextStepId}`
            : "complete 3DS challenge manually, then rerun with FLOW_FROM_STEP_ID set to the last step";
          break;
        }
        await persistResumeContext(context, page, sessionDir, "running", step.step_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          step_id: step.step_id,
          action: step.action,
          ok: false,
          detail: message,
          provider_domain: null,
          gate_required_by_policy: false,
          matched_selector: null,
          selector_index: null,
          duration_ms: 0,
          screenshot_before_path: shouldCaptureScreenshotsForStep(step) ? beforePath : null,
          screenshot_after_path: null,
          fallback_trail: [],
        });
        await persistResumeContext(context, page, sessionDir, "failed", step.step_id);
        break;
      }
    }

    if (!manualGate.required && results.length > 0 && results.every((item) => item.ok)) {
      await persistResumeContext(
        context,
        page,
        sessionDir,
        "success",
        results[results.length - 1]?.step_id ?? null,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const preconditionsOk = preconditionChecks.every((check) => check.ok);
  const success = preconditionsOk && !manualGate.required && results.every((item) => item.ok);
  const output = {
    generatedAt: new Date().toISOString(),
    status: manualGate.required ? "manual_gate" : success ? "success" : "failed",
    flowPath,
    startUrl,
    resumedFromStepId: fromStepId,
    resumedFromIndex: fromStepIndex,
    replayPreconditions,
    preconditionChecks,
    manualGate,
    success,
    stepResults: results,
  };
  const outputPath = path.join(sessionDir, "replay-flow-result.json");
  await writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");

  if (!success && !manualGate.required) {
    throw new Error(`flow replay failed, see ${outputPath}`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`replay-flow-draft failed: ${message}\n`);
  process.exitCode = 1;
});
