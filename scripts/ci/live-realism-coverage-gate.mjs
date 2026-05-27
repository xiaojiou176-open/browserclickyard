#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const ALLOWED_RUNNERS = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "macos-latest",
  "macos-14",
]);

function loadWorkflow(path) {
  return YAML.parse(readFileSync(resolve(path), "utf8"));
}

function normalizeRunsOn(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function getEnvironmentName(job) {
  if (typeof job?.environment === "string") {
    return job.environment;
  }
  if (typeof job?.environment?.name === "string") {
    return job.environment.name;
  }
  return "";
}

function findStep(job, matcher) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.find((step) => matcher(step));
}

function hasWorkflowDispatch(workflow) {
  return Boolean(workflow?.on && Object.prototype.hasOwnProperty.call(workflow.on, "workflow_dispatch"));
}

function hasSchedule(workflow) {
  return Array.isArray(workflow?.on?.schedule) && workflow.on.schedule.length > 0;
}

function expect(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function expectJob(path, workflow, jobName, failures) {
  const job = workflow?.jobs?.[jobName];
  if (!job) {
    failures.push(`[sensitive-workflow-governance] ${path}: missing job '${jobName}'`);
    return null;
  }
  return job;
}

function expectManualOnlyTrigger(path, workflow, failures) {
  expect(
    hasWorkflowDispatch(workflow),
    `[sensitive-workflow-governance] ${path}: workflow_dispatch trigger is required`,
    failures,
  );
  expect(
    !hasSchedule(workflow),
    `[sensitive-workflow-governance] ${path}: schedule trigger must be removed for manual-only sensitive workflows`,
    failures,
  );
}

function expectRunner(path, jobName, job, failures) {
  const runsOn = normalizeRunsOn(job?.["runs-on"]);
  expect(
    runsOn.length === 1 && ALLOWED_RUNNERS.has(runsOn[0]),
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must use one GitHub-hosted runner label`,
    failures,
  );
}

function expectEnvironment(path, jobName, job, environmentName, failures) {
  expect(
    getEnvironmentName(job) === environmentName,
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must bind environment '${environmentName}'`,
    failures,
  );
}

function expectNoSensitiveSteps(path, jobName, job, failures) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const forbiddenRunNeedles = [
    "pnpm test:live:web",
    "pnpm test:live:llm",
    "node scripts/ai/check-provider-readiness.mjs --strict",
    "pnpm mutation:effective",
  ];

  for (const step of steps) {
    const run = typeof step?.run === "string" ? step.run : "";
    const name = String(step?.name ?? "<unnamed-step>");
    for (const needle of forbiddenRunNeedles) {
      if (run.includes(needle)) {
        failures.push(
          `[sensitive-workflow-governance] ${path}: deterministic job '${jobName}' must not run sensitive/manual step '${name}' (${needle})`,
        );
      }
    }
  }
}

function validateLiveRealism(failures) {
  const path = ".github/workflows/live-realism.yml";
  const workflow = loadWorkflow(path);
  expectManualOnlyTrigger(path, workflow, failures);
  const job = expectJob(path, workflow, "live-realism", failures);
  if (!job) {
    return;
  }

  expectRunner(path, "live-realism", job, failures);
  expectEnvironment(path, "live-realism", job, "owner-approved-sensitive", failures);

  const liveWeb = findStep(job, (step) => typeof step?.run === "string" && step.run.includes("pnpm test:live:web"));
  expect(
    Boolean(liveWeb),
    `[sensitive-workflow-governance] ${path}: job 'live-realism' must include pnpm test:live:web`,
    failures,
  );
  if (liveWeb) {
    expect(
      String(liveWeb.env?.UIQ_LIVE_EXTERNAL_ENABLED) === "true",
      `[sensitive-workflow-governance] ${path}: live web step must set UIQ_LIVE_EXTERNAL_ENABLED=true`,
      failures,
    );
  }

  const liveLlm = findStep(job, (step) => typeof step?.run === "string" && step.run.includes("pnpm test:live:llm"));
  expect(
    Boolean(liveLlm),
    `[sensitive-workflow-governance] ${path}: job 'live-realism' must include pnpm test:live:llm`,
    failures,
  );
  if (liveLlm) {
    expect(
      String(liveLlm.env?.UIQ_LIVE_LLM_ENABLED) === "true",
      `[sensitive-workflow-governance] ${path}: live llm step must set UIQ_LIVE_LLM_ENABLED=true`,
      failures,
    );
    expect(
      typeof liveLlm.env?.GEMINI_API_KEY === "string" &&
        liveLlm.env.GEMINI_API_KEY.includes("secrets.GEMINI_API_KEY"),
      `[sensitive-workflow-governance] ${path}: live llm step must source GEMINI_API_KEY from secrets.GEMINI_API_KEY`,
      failures,
    );
  }
}

function validateManualObservability(path, jobName, inputName, failures) {
  const workflow = loadWorkflow(path);
  const job = expectJob(path, workflow, jobName, failures);
  if (!job) {
    return;
  }

  expect(
    hasWorkflowDispatch(workflow),
    `[sensitive-workflow-governance] ${path}: workflow_dispatch trigger is required for '${jobName}'`,
    failures,
  );
  expect(
    String(job.if ?? "").includes("workflow_dispatch") && String(job.if ?? "").includes(inputName),
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must stay gated behind workflow_dispatch + ${inputName}`,
    failures,
  );
  expectRunner(path, jobName, job, failures);
  expectEnvironment(path, jobName, job, "owner-approved-sensitive", failures);

  const providerReadiness = findStep(
    job,
    (step) => typeof step?.run === "string" && step.run.includes("check-provider-readiness.mjs --strict"),
  );
  expect(
    Boolean(providerReadiness),
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must include provider readiness gate`,
    failures,
  );
  if (providerReadiness) {
    expect(
      typeof providerReadiness.env?.GEMINI_API_KEY === "string" &&
        providerReadiness.env.GEMINI_API_KEY.includes("secrets.GEMINI_API_KEY"),
      `[sensitive-workflow-governance] ${path}: provider readiness step in '${jobName}' must source GEMINI_API_KEY from secrets.GEMINI_API_KEY`,
      failures,
    );
  }

  const liveWeb = findStep(job, (step) => typeof step?.run === "string" && step.run.includes("pnpm test:live:web"));
  expect(
    Boolean(liveWeb),
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must include pnpm test:live:web`,
    failures,
  );
  if (liveWeb) {
    expect(
      String(liveWeb.env?.UIQ_LIVE_EXTERNAL_ENABLED) === "true",
      `[sensitive-workflow-governance] ${path}: live web step in '${jobName}' must set UIQ_LIVE_EXTERNAL_ENABLED=true`,
      failures,
    );
  }

  const liveLlm = findStep(job, (step) => typeof step?.run === "string" && step.run.includes("pnpm test:live:llm"));
  expect(
    Boolean(liveLlm),
    `[sensitive-workflow-governance] ${path}: job '${jobName}' must include pnpm test:live:llm`,
    failures,
  );
  if (liveLlm) {
    expect(
      String(liveLlm.env?.UIQ_LIVE_LLM_ENABLED) === "true",
      `[sensitive-workflow-governance] ${path}: live llm step in '${jobName}' must set UIQ_LIVE_LLM_ENABLED=true`,
      failures,
    );
  }
}

function validateDeterministicNightlyWeekly(path, jobName, removedJobs, failures) {
  const workflow = loadWorkflow(path);
  const job = expectJob(path, workflow, jobName, failures);
  if (job) {
    expectRunner(path, jobName, job, failures);
    expectNoSensitiveSteps(path, jobName, job, failures);
  }

  for (const removedJobName of removedJobs) {
    expect(
      !workflow?.jobs?.[removedJobName],
      `[sensitive-workflow-governance] ${path}: legacy sensitive job '${removedJobName}' must be removed from deterministic workflow`,
      failures,
    );
  }
}

function validateBranchProtectionAudit(failures) {
  const path = ".github/workflows/branch-protection-audit.yml";
  const workflow = loadWorkflow(path);
  expectManualOnlyTrigger(path, workflow, failures);
  const job = expectJob(path, workflow, "branch-protection-audit", failures);
  if (!job) {
    return;
  }

  expectRunner(path, "branch-protection-audit", job, failures);
  expectEnvironment(path, "branch-protection-audit", job, "owner-approved-sensitive", failures);
  expect(
    typeof job.env?.GH_TOKEN === "string" &&
      job.env.GH_TOKEN.includes("secrets.BRANCH_PROTECTION_AUDIT_TOKEN"),
    `[sensitive-workflow-governance] ${path}: job 'branch-protection-audit' must source GH_TOKEN from secrets.BRANCH_PROTECTION_AUDIT_TOKEN`,
    failures,
  );
}

function validateDesktopSmoke(failures) {
  const path = ".github/workflows/desktop-smoke.yml";
  const workflow = loadWorkflow(path);
  expectManualOnlyTrigger(path, workflow, failures);
  const job = expectJob(path, workflow, "desktop-smoke", failures);
  if (!job) {
    return;
  }

  expect(
    normalizeRunsOn(job?.["runs-on"]).length === 1 &&
      normalizeRunsOn(job?.["runs-on"])[0].startsWith("macos"),
    `[sensitive-workflow-governance] ${path}: job 'desktop-smoke' must use a macOS GitHub-hosted runner`,
    failures,
  );
  expectEnvironment(path, "desktop-smoke", job, "owner-approved-sensitive", failures);
}

function main() {
  const failures = [];

  validateLiveRealism(failures);
  validateManualObservability(
    ".github/workflows/nightly.yml",
    "nightly-manual-observability",
    "run_manual_observability",
    failures,
  );
  validateDeterministicNightlyWeekly(
    ".github/workflows/nightly.yml",
    "nightly-gate",
    ["desktop-regression-macos"],
    failures,
  );
  validateBranchProtectionAudit(failures);
  validateDesktopSmoke(failures);

  if (failures.length > 0) {
    console.error(`[sensitive-workflow-governance] FAIL (${failures.length} issue(s))`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("[sensitive-workflow-governance] PASS");
}

main();
