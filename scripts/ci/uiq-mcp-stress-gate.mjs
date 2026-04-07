#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const DEFAULT_TEST_CASES = [
  "pollRunToTerminal keeps polling auto provider and returns waiting_user",
  "pollRunToTerminal avoids duplicate OTP submit on resume",
  "register_orchestrate clone supports /api/runs envelope payload",
];
const DEFAULT_TEST_NAME_PATTERN = DEFAULT_TEST_CASES.map((value) => escapeRegExp(value)).join("|");
const checkId = "mcp_stress_flake_rate_max";
const TEST_FILE = "services/mcp-server/tests/mcp-core-fixes.test.ts";
const outputPrefix = "uiq-mcp-stress-gate";
const OUTPUT_LOG_SNIPPET_MAX = 2400;
const TIME_BUDGET_ENV_KEY = "UIQ_MCP_STRESS_TIME_BUDGET_MS";

function parseArgs(argv) {
  const options = {
    profile: "pr",
    iterations: 100,
    parallel: 1,
    strict: false,
    outDir: ".runtime-cache/artifacts/ci",
    testNamePattern: DEFAULT_TEST_NAME_PATTERN,
    flakeRateMax: undefined,
    timeBudgetMs: undefined,
    timeBudgetSource: "none",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--profile" && next) {
      options.profile = next;
    }
    if (token === "--iterations" && next) {
      options.iterations = Number(next);
    }
    if (token === "--parallel" && next) {
      options.parallel = Number(next);
    }
    if (token === "--strict" && next) {
      options.strict = parseBoolean(next, "--strict");
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--test-name-pattern" && next) {
      options.testNamePattern = next;
    }
    if (token === "--flake-rate-max" && next) {
      options.flakeRateMax = Number(next);
    }
    if (token === "--time-budget-ms" && next) {
      options.timeBudgetMs = Number(next);
      options.timeBudgetSource = "cli";
    }
  }
  if (options.timeBudgetMs === undefined) {
    const rawBudget = process.env[TIME_BUDGET_ENV_KEY];
    if (typeof rawBudget === "string" && rawBudget.trim().length > 0) {
      options.timeBudgetMs = Number(rawBudget);
      options.timeBudgetSource = "env";
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("invalid --iterations, expected integer >= 1");
  }
  if (!Number.isInteger(options.parallel) || options.parallel < 1) {
    throw new Error("invalid --parallel, expected integer >= 1");
  }
  if (!options.testNamePattern || options.testNamePattern.trim().length === 0) {
    throw new Error("invalid --test-name-pattern, expected non-empty value");
  }
  if (
    options.flakeRateMax !== undefined &&
    (!Number.isFinite(options.flakeRateMax) || options.flakeRateMax < 0)
  ) {
    throw new Error("invalid --flake-rate-max, expected number >= 0");
  }
  if (
    options.timeBudgetMs !== undefined &&
    (!Number.isInteger(options.timeBudgetMs) || options.timeBudgetMs < 1)
  ) {
    throw new Error("invalid --time-budget-ms, expected integer >= 1");
  }
  return options;
}

function parseBoolean(raw, key) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`invalid ${key}, expected true|false`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimLog(value, maxLength = OUTPUT_LOG_SNIPPET_MAX) {
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...<truncated>`;
}

function buildReasonCode(status, reason) {
  return `gate.${checkId}.${status}.${reason}`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(6));
}

function resolveThreshold(options) {
  if (options.flakeRateMax !== undefined) {
    return {
      threshold: Number(options.flakeRateMax),
      thresholdSource: "cli",
      profilePath: null,
      profileReadError: "",
    };
  }
  const profilePath = resolve("profiles", `${options.profile}.yaml`);
  try {
    const profile = YAML.parse(readFileSync(profilePath, "utf8"));
    const raw = profile?.gates?.flakeRateMax;
    const threshold = Number(raw);
    if (Number.isFinite(threshold) && threshold >= 0) {
      return {
        threshold,
        thresholdSource: "profile",
        profilePath,
        profileReadError: "",
      };
    }
    return {
      threshold: undefined,
      thresholdSource: "profile",
      profilePath,
      profileReadError: "missing_or_invalid_gates_flakeRateMax",
    };
  } catch (error) {
    return {
      threshold: undefined,
      thresholdSource: "profile",
      profilePath,
      profileReadError: error instanceof Error ? error.message : String(error),
    };
  }
}

function runSingleIteration({ iteration, testNamePattern }) {
  return new Promise((resolveResult) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    // Important: Node test filters only apply when --test-name-pattern is parsed before test files.
    const args = ["--import", "tsx", "--test", "--test-name-pattern", testNamePattern, TEST_FILE];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", (error) => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      resolveResult({
        iteration,
        status: "failed",
        exitCode: null,
        signal: null,
        durationMs,
        startedAt,
        finishedAt,
        reason: "spawn_error",
        stdout: trimLog(stdout),
        stderr: trimLog(
          `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        ),
      });
    });

    child.on("close", (code, signal) => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      resolveResult({
        iteration,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        signal: signal ?? null,
        durationMs,
        startedAt,
        finishedAt,
        reason: code === 0 ? "ok" : "test_failed",
        stdout: trimLog(stdout),
        stderr: trimLog(stderr),
      });
    });
  });
}

async function runIterations(options) {
  const results = new Array(options.iterations);
  let next = 0;
  const workerCount = Math.min(options.parallel, options.iterations);

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= options.iterations) {
        return;
      }
      results[index] = await runSingleIteration({
        iteration: index + 1,
        testNamePattern: options.testNamePattern,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function evaluateGate({ total, failed, threshold, durationMs, timeBudgetMs }) {
  const flakeRate = total > 0 ? failed / total : 0;
  const hasTimeBudget = Number.isInteger(timeBudgetMs);
  const timeBudgetExceeded = hasTimeBudget ? durationMs > timeBudgetMs : false;
  const timeBudgetStatus = !hasTimeBudget
    ? "not_configured"
    : timeBudgetExceeded
      ? "exceeded"
      : "within_budget";
  if (timeBudgetExceeded) {
    return {
      status: "failed",
      reasonCode: buildReasonCode("failed", "time_budget_exceeded"),
      flakeRate: formatRate(flakeRate),
      threshold: threshold === undefined ? null : Number(threshold),
      durationMs,
      timeBudgetMs: Number(timeBudgetMs),
      timeBudgetStatus,
    };
  }
  if (threshold === undefined) {
    return {
      status: "blocked",
      reasonCode: buildReasonCode("blocked", "missing_profile_threshold"),
      flakeRate: formatRate(flakeRate),
      threshold: null,
      durationMs,
      timeBudgetMs: hasTimeBudget ? Number(timeBudgetMs) : null,
      timeBudgetStatus,
    };
  }
  if (total === 0) {
    return {
      status: "blocked",
      reasonCode: buildReasonCode("blocked", "no_iterations_executed"),
      flakeRate: formatRate(flakeRate),
      threshold: Number(threshold),
      durationMs,
      timeBudgetMs: hasTimeBudget ? Number(timeBudgetMs) : null,
      timeBudgetStatus,
    };
  }
  const passed = flakeRate <= threshold;
  return {
    status: passed ? "passed" : "failed",
    reasonCode: passed
      ? buildReasonCode("passed", "threshold_met")
      : buildReasonCode("failed", "threshold_exceeded"),
    flakeRate: formatRate(flakeRate),
    threshold: Number(threshold),
    durationMs,
    timeBudgetMs: hasTimeBudget ? Number(timeBudgetMs) : null,
    timeBudgetStatus,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ MCP Stress Gate");
  lines.push(`- Profile: \`${report.profile}\``);
  lines.push(`- Strict Mode: ${report.strict ? "true" : "false"}`);
  lines.push(`- Test File: \`${report.testFile}\``);
  lines.push(`- Test Name Pattern: \`${report.testNamePattern}\``);
  lines.push(`- Iterations: ${report.execution.iterations}`);
  lines.push(`- Parallel: ${report.execution.parallel}`);
  lines.push(`- Threshold Source: \`${report.thresholdSource}\``);
  lines.push(`- flakeRateMax: ${report.gate.threshold ?? "n/a"}`);
  lines.push(`- Time Budget Source: \`${report.timeBudget.source}\``);
  lines.push(`- timeBudgetMs: ${report.gate.timeBudgetMs ?? "n/a"}`);
  lines.push(`- durationMs: ${report.gate.durationMs}`);
  lines.push(`- Time Budget Status: \`${report.gate.timeBudgetStatus}\``);
  lines.push(`- Passed Iterations: ${report.execution.passedIterations}`);
  lines.push(`- Failed Iterations: ${report.execution.failedIterations}`);
  lines.push(`- flakeRate: ${report.gate.flakeRate ?? "n/a"}`);
  lines.push(`- Gate Status: **${report.gate.status}**`);
  lines.push(`- reasonCode: \`${report.gate.reasonCode}\``);
  if (report.profileReadError) {
    lines.push(`- Profile Read Error: \`${report.profileReadError}\``);
  }
  lines.push("");
  lines.push("### Failed Iterations");
  if (report.execution.failedIterationDetails.length === 0) {
    lines.push("- none");
  } else {
    for (const item of report.execution.failedIterationDetails) {
      lines.push(
        `- #${item.iteration} exit=${item.exitCode ?? "null"} signal=${item.signal ?? "none"} durationMs=${item.durationMs}`,
      );
    }
  }
  lines.push("");
  lines.push(`- JSON Artifact: \`${report.artifacts.json}\``);
  lines.push(`- Markdown Artifact: \`${report.artifacts.markdown}\``);
  return `${lines.join("\n")}\n`;
}

function appendStepSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, text, { encoding: "utf8", flag: "a" });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedMs = Date.now();
  const thresholdInfo = resolveThreshold(options);
  const iterationResults = await runIterations(options);
  const finishedMs = Date.now();
  const passedIterations = iterationResults.filter((item) => item.status === "passed").length;
  const failedIterations = iterationResults.filter((item) => item.status !== "passed").length;
  const gate = evaluateGate({
    total: iterationResults.length,
    failed: failedIterations,
    threshold: thresholdInfo.threshold,
    durationMs: finishedMs - startedMs,
    timeBudgetMs: options.timeBudgetMs,
  });

  mkdirSync(resolve(options.outDir), { recursive: true });
  const outJson = resolve(options.outDir, `${outputPrefix}-${options.profile}.json`);
  const outMd = resolve(options.outDir, `${outputPrefix}-${options.profile}.md`);
  const report = {
    profile: options.profile,
    strict: options.strict,
    testFile: TEST_FILE,
    testNamePattern: options.testNamePattern,
    defaultCases: DEFAULT_TEST_CASES,
    thresholdSource: thresholdInfo.thresholdSource,
    profilePath: thresholdInfo.profilePath,
    profileReadError: thresholdInfo.profileReadError,
    timeBudget: {
      source: options.timeBudgetSource,
      envKey: TIME_BUDGET_ENV_KEY,
    },
    execution: {
      iterations: options.iterations,
      parallel: options.parallel,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      passedIterations,
      failedIterations,
      failedIterationDetails: iterationResults
        .filter((item) => item.status !== "passed")
        .map((item) => ({
          iteration: item.iteration,
          status: item.status,
          exitCode: item.exitCode,
          signal: item.signal,
          reason: item.reason,
          durationMs: item.durationMs,
        })),
      iterationsDetail: iterationResults,
    },
    gate,
    artifacts: {
      json: outJson,
      markdown: outMd,
    },
  };
  const markdown = renderMarkdown(report);

  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outMd, markdown, "utf8");
  appendStepSummary(markdown);

  if (options.strict && gate.status === "failed") {
    process.exit(1);
  }
}

await main();
