import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { runStep, shouldCaptureScreenshotsForStep } from "./lib/replay-flow-execute.js";
import {
  parseProtectedProviderDomains,
  readJson,
  resolveFlowPath,
} from "./lib/replay-flow-parse.js";
import { loadResumeContext, persistResumeContext } from "./lib/replay-flow-resume.js";
import type { FlowDraft } from "./lib/replay-flow-types.js";

const LOAD_RESUME_CONTEXT_BY_DEFAULT = true;

async function main(): Promise<void> {
  const stepId = (process.env.FLOW_STEP_ID ?? "").trim();
  if (!stepId) {
    throw new Error("FLOW_STEP_ID is required");
  }

  const { flowPath, sessionDir } = await resolveFlowPath();
  const flow = await readJson<FlowDraft>(flowPath);
  const step = flow.steps.find((item) => item.step_id === stepId);
  if (!step) {
    throw new Error(`step not found: ${stepId}`);
  }

  const startUrl = process.env.START_URL?.trim() || flow.start_url;
  const explicitHeadless = process.env.HEADLESS;
  const headless = explicitHeadless ? explicitHeadless !== "false" : true;
  const shouldLoadResumeContext = LOAD_RESUME_CONTEXT_BY_DEFAULT;
  const protectedProviderDomains = parseProtectedProviderDomains(
    process.env.FLOW_PROTECTED_PROVIDER_DOMAINS,
  );

  const resumeContext = await loadResumeContext(sessionDir);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ...(shouldLoadResumeContext && resumeContext.storageStatePath
      ? { storageState: resumeContext.storageStatePath }
      : {}),
  });
  const page = await context.newPage();

  const evidenceDir = path.join(sessionDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  try {
    const targetUrl =
      step.action !== "navigate" && shouldLoadResumeContext && resumeContext.snapshot?.current_url
        ? resumeContext.snapshot.current_url
        : startUrl;
    await page.goto(targetUrl, { waitUntil: "networkidle" });

    const captureScreenshots = shouldCaptureScreenshotsForStep(step);
    const beforePath = path.join(evidenceDir, `${stepId}-before.png`);
    if (captureScreenshots) {
      await page.screenshot({ path: beforePath, fullPage: true });
    }

    const result = await runStep(page, step, protectedProviderDomains);

    const afterPath = path.join(evidenceDir, `${stepId}-after.png`);
    if (captureScreenshots) {
      await page.screenshot({ path: afterPath, fullPage: true });
      result.screenshot_before_path = beforePath;
      result.screenshot_after_path = afterPath;
    }

    const output = {
      generatedAt: new Date().toISOString(),
      flowPath,
      startUrl,
      stepId,
      ...result,
    };
    const outputPath = path.join(sessionDir, "replay-flow-step-result.json");
    await writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");

    const status = result.manual_gate_required ? "manual_gate" : result.ok ? "running" : "failed";
    await persistResumeContext(context, page, sessionDir, status, step.step_id);

    if (!result.ok && !result.manual_gate_required) {
      throw new Error(`step replay failed, see ${outputPath}`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`replay-flow-step failed: ${message}\n`);
  process.exitCode = 1;
});
