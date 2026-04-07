#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const DEFAULT_DYNAMIC_FIELDS = ["perfLcpMs", "perfFcpMs", "loadP95Ms", "loadFailedRequests"];
const FLAKE_FAILURE_STATUSES = new Set(["failed", "timedout", "interrupted", "blocked", "flaky"]);

function parseArgs(argv) {
  const options = {
    profile: "",
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    strict: false,
    baselineRunsDir: ".runtime-cache/artifacts/nightly-baseline",
    baselineProfile: "nightly",
    baselineWindow: 5,
    dynamicBaseline: undefined,
    dynamicFields: [...DEFAULT_DYNAMIC_FIELDS],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--profile" && next) {
      options.profile = next;
    }
    if (token === "--runs-dir" && next) {
      options.runsDir = next;
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--strict" && next) {
      options.strict = parseBoolean(next, "--strict");
    }
    if (token === "--baseline-runs-dir" && next) {
      options.baselineRunsDir = next;
    }
    if (token === "--baseline-profile" && next) {
      options.baselineProfile = next;
    }
    if (token === "--baseline-window" && next) {
      options.baselineWindow = Number(next);
    }
    if (token === "--dynamic-baseline" && next) {
      options.dynamicBaseline = parseBoolean(next, "--dynamic-baseline");
    }
    if (token === "--dynamic-fields" && next) {
      options.dynamicFields = parseCsv(next);
    }
  }
  if (!options.profile) {
    throw new Error("missing --profile");
  }
  if (!Number.isInteger(options.baselineWindow) || options.baselineWindow < 1) {
    throw new Error("invalid --baseline-window");
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

function parseCsv(raw) {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [...DEFAULT_DYNAMIC_FIELDS];
}

function findLatestManifest(runsDir) {
  const absRunsDir = resolve(runsDir);
  const candidates = [];
  for (const entry of readdirSync(absRunsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = resolve(absRunsDir, entry.name, "manifest.json");
    try {
      candidates.push({ manifestPath, mtimeMs: statSync(manifestPath).mtimeMs });
    } catch {
      // ignore directories without manifest
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.manifestPath;
}

function walkJsonFiles(rootDir, out = []) {
  if (!existsSync(rootDir)) {
    return out;
  }
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(fullPath);
    }
  }
  return out;
}

function normalizeStatus(raw) {
  const value = String(raw || "")
    .toLowerCase()
    .trim();
  if (!value) {
    return "";
  }
  if (["passed", "pass", "ok", "success", "expected"].includes(value)) {
    return "passed";
  }
  if (["failed", "fail", "error", "broken"].includes(value)) {
    return "failed";
  }
  if (["timedout", "timeout", "timed_out"].includes(value)) {
    return "timedout";
  }
  if (["interrupted", "aborted", "canceled", "cancelled"].includes(value)) {
    return "interrupted";
  }
  if (["blocked"].includes(value)) {
    return "blocked";
  }
  if (["flaky"].includes(value)) {
    return "flaky";
  }
  if (["skipped", "skip", "pending", "disabled"].includes(value)) {
    return "skipped";
  }
  return "";
}

function maybeNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function maybeString(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return "";
}

function extractTestId(record) {
  const titlePath = Array.isArray(record?.titlePath)
    ? record.titlePath
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .join(" > ")
    : "";
  return maybeString(
    record?.testId,
    record?.test_id,
    titlePath,
    record?.fullTitle,
    record?.fullName,
    record?.title,
    record?.name,
    record?.id,
  );
}

function isLikelyTestRecord(record) {
  const keys = Object.keys(record || {});
  const testSignals = [
    "testId",
    "test_id",
    "title",
    "fullTitle",
    "fullName",
    "titlePath",
    "retry",
    "attempt",
    "results",
    "testResults",
    "projectName",
    "file",
    "location",
  ];
  return testSignals.some((key) => keys.includes(key));
}

function collectAttemptsFromRecord(record, sourceFile, objectPath, sequence) {
  if (!record || typeof record !== "object" || !isLikelyTestRecord(record)) {
    return [];
  }
  const testId = extractTestId(record);
  if (!testId) {
    return [];
  }
  const attempts = [];
  const arrays = [];
  if (Array.isArray(record.results)) {
    arrays.push(record.results);
  }
  if (Array.isArray(record.testResults)) {
    arrays.push(record.testResults);
  }
  let emittedFromNested = false;
  for (const resultList of arrays) {
    resultList.forEach((result, index) => {
      if (!result || typeof result !== "object") {
        return;
      }
      const status = normalizeStatus(
        result.status ?? result.outcome ?? result.state ?? result.result,
      );
      if (!status) {
        return;
      }
      emittedFromNested = true;
      attempts.push({
        testId,
        status,
        rawStatus: String(result.status ?? result.outcome ?? result.state ?? result.result ?? ""),
        attempt: maybeNumber(result.retry, result.attempt, index) ?? index,
        sourceFile,
        sourcePath: objectPath,
        sequence,
      });
    });
  }
  if (!emittedFromNested) {
    const status = normalizeStatus(
      record.status ?? record.outcome ?? record.state ?? record.result,
    );
    if (!status) {
      return [];
    }
    attempts.push({
      testId,
      status,
      rawStatus: String(record.status ?? record.outcome ?? record.state ?? record.result ?? ""),
      attempt: maybeNumber(record.retry, record.attempt, 0) ?? 0,
      sourceFile,
      sourcePath: objectPath,
      sequence,
    });
  }
  return attempts;
}

function collectTestAttemptsFromJson(root, sourceFile) {
  const attempts = [];
  const dedupe = new Set();
  const stack = [{ value: root, path: "$" }];
  let sequence = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { value, path } = current;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push({ value: value[i], path: `${path}[${i}]` });
      }
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    sequence += 1;
    const recordAttempts = collectAttemptsFromRecord(value, sourceFile, path, sequence);
    for (const item of recordAttempts) {
      const key = `${item.sourceFile}|${item.sourcePath}|${item.testId}|${item.attempt}|${item.status}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      attempts.push(item);
    }
    for (const [key, child] of Object.entries(value)) {
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return attempts;
}

function analyzeFlakeAttempts(attempts) {
  const grouped = new Map();
  for (const item of attempts) {
    if (!grouped.has(item.testId)) {
      grouped.set(item.testId, []);
    }
    grouped.get(item.testId).push(item);
  }
  const flakyTests = [];
  for (const [testId, items] of grouped.entries()) {
    const sorted = [...items].sort((a, b) => a.attempt - b.attempt || a.sequence - b.sequence);
    const statuses = sorted.map((item) => item.status);
    const unique = Array.from(new Set(statuses));
    const hasPass = statuses.includes("passed");
    const hasFailure = statuses.some((status) => FLAKE_FAILURE_STATUSES.has(status));
    const firstFailureIndex = statuses.findIndex((status) => FLAKE_FAILURE_STATUSES.has(status));
    const lastPassIndex = statuses.lastIndexOf("passed");
    const retryPass =
      hasPass &&
      (sorted.some((item) => item.status === "passed" && item.attempt > 0) ||
        (firstFailureIndex >= 0 && lastPassIndex > firstFailureIndex));
    const statusFluctuation = unique.length > 1 && (hasPass || hasFailure);
    const explicitFlaky = statuses.includes("flaky");
    const flaky = retryPass || statusFluctuation || explicitFlaky;
    if (!flaky) {
      continue;
    }
    flakyTests.push({
      testId,
      statuses: unique,
      attemptCount: sorted.length,
      retryPass,
      statusFluctuation,
      explicitFlaky,
      sourceFile: sorted[0]?.sourceFile || "",
    });
  }
  flakyTests.sort((a, b) => b.attemptCount - a.attemptCount || a.testId.localeCompare(b.testId));
  return {
    totalTests: grouped.size,
    flakyCount: flakyTests.length,
    flakyTests,
  };
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  const factor = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * factor;
}

function formatNumber(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizeFieldId(field) {
  return field.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`);
}

function fieldReasonCode(field, status, reason) {
  return `gate.dynamic_${normalizeFieldId(field)}.${status}.${reason}`;
}

function evaluateFlakeGate(flakeRateMax, totalTests, flakyCount) {
  const flakeRate = totalTests > 0 ? flakyCount / totalTests : 0;
  if (flakeRateMax === undefined) {
    return {
      status: "blocked",
      reasonCode: "gate.flake_rate_max.blocked.missing_profile_threshold",
      threshold: null,
      flakeRate: formatNumber(flakeRate, 6),
    };
  }
  if (totalTests === 0) {
    return {
      status: "blocked",
      reasonCode: "gate.flake_rate_max.blocked.no_test_attempt_data",
      threshold: Number(flakeRateMax),
      flakeRate: formatNumber(flakeRate, 6),
    };
  }
  const passed = flakeRate <= flakeRateMax;
  return {
    status: passed ? "passed" : "failed",
    reasonCode: passed
      ? "gate.flake_rate_max.passed.threshold_met"
      : "gate.flake_rate_max.failed.threshold_exceeded",
    threshold: Number(flakeRateMax),
    flakeRate: formatNumber(flakeRate, 6),
  };
}

function collectBaselineManifests(rootDir, profile, window) {
  const manifestFiles = walkJsonFiles(rootDir).filter((path) => path.endsWith("/manifest.json"));
  const manifests = [];
  for (const manifestPath of manifestFiles) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (String(raw?.profile || "") !== profile) {
        continue;
      }
      const finishedAt = Date.parse(String(raw?.timing?.finishedAt || ""));
      const fallbackTime = statSync(manifestPath).mtimeMs;
      manifests.push({
        manifestPath,
        runId: String(raw?.runId || "unknown"),
        finishedAtMs: Number.isFinite(finishedAt) ? finishedAt : fallbackTime,
        summary: raw?.summary && typeof raw.summary === "object" ? raw.summary : {},
      });
    } catch {
      // ignore unreadable manifest
    }
  }
  manifests.sort((a, b) => b.finishedAtMs - a.finishedAtMs);
  return manifests.slice(0, window);
}

function evaluateDynamicBaseline(currentManifest, options) {
  const enabled =
    options.dynamicBaseline !== undefined ? options.dynamicBaseline : options.profile === "pr";
  if (!enabled) {
    return {
      enabled: false,
      overall: {
        status: "blocked",
        reasonCode: "gate.dynamic_baseline.blocked.not_enabled",
      },
      checks: [],
      sampledRuns: [],
    };
  }

  const sampledRuns = collectBaselineManifests(
    options.baselineRunsDir,
    options.baselineProfile,
    options.baselineWindow,
  );
  const checks = [];
  const summary =
    currentManifest?.summary && typeof currentManifest.summary === "object"
      ? currentManifest.summary
      : {};

  for (const field of options.dynamicFields) {
    const currentValue = Number(summary[field]);
    if (!Number.isFinite(currentValue)) {
      checks.push({
        field,
        status: "blocked",
        reasonCode: fieldReasonCode(field, "blocked", "current_metric_missing"),
        current: null,
        median: null,
        p90: null,
        threshold: null,
        sampleCount: 0,
      });
      continue;
    }
    const samples = sampledRuns
      .map((run) => Number(run.summary?.[field]))
      .filter((value) => Number.isFinite(value));
    if (samples.length === 0) {
      checks.push({
        field,
        status: "blocked",
        reasonCode: fieldReasonCode(field, "blocked", "no_baseline_samples"),
        current: formatNumber(currentValue),
        median: null,
        p90: null,
        threshold: null,
        sampleCount: 0,
      });
      continue;
    }
    const median = quantile(samples, 0.5);
    const p90 = quantile(samples, 0.9);
    const threshold = p90;
    const passed = currentValue <= threshold;
    checks.push({
      field,
      status: passed ? "passed" : "failed",
      reasonCode: fieldReasonCode(
        field,
        passed ? "passed" : "failed",
        passed ? "within_p90_baseline" : "exceeds_p90_baseline",
      ),
      current: formatNumber(currentValue),
      median: formatNumber(median),
      p90: formatNumber(p90),
      threshold: formatNumber(threshold),
      sampleCount: samples.length,
    });
  }

  const failed = checks.filter((item) => item.status === "failed");
  const evaluated = checks.filter((item) => item.status === "passed" || item.status === "failed");
  const blocked = checks.filter((item) => item.status === "blocked");
  let overallStatus = "passed";
  let overallReasonCode = "gate.dynamic_baseline.passed.threshold_met";
  if (failed.length > 0) {
    overallStatus = "failed";
    overallReasonCode = "gate.dynamic_baseline.failed.threshold_exceeded";
  } else if (evaluated.length === 0) {
    overallStatus = "blocked";
    overallReasonCode =
      sampledRuns.length === 0
        ? "gate.dynamic_baseline.blocked.no_baseline_data"
        : (blocked[0]?.reasonCode ?? "gate.dynamic_baseline.blocked.no_evaluable_fields");
  } else if (blocked.length > 0) {
    overallStatus = "passed";
    overallReasonCode = "gate.dynamic_baseline.passed.partial_fields_evaluated";
  }

  return {
    enabled: true,
    baselineProfile: options.baselineProfile,
    baselineRunsDir: resolve(options.baselineRunsDir),
    baselineWindow: options.baselineWindow,
    overall: {
      status: overallStatus,
      reasonCode: overallReasonCode,
    },
    checks,
    sampledRuns: sampledRuns.map((run) => ({
      runId: run.runId,
      manifestPath: run.manifestPath,
      finishedAtMs: run.finishedAtMs,
    })),
  };
}

function appendStepSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, text, { encoding: "utf8", flag: "a" });
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ Flake Budget + Dynamic Baseline");
  lines.push(`- Profile: \`${report.profile}\``);
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Strict Mode: ${report.strict ? "true" : "false"}`);
  lines.push(`- Overall Gate Status: **${report.overallStatus}**`);
  lines.push("");
  lines.push("### Flake Gate");
  lines.push(`- Total Tests Observed: ${report.flake.totalTests}`);
  lines.push(`- Flaky Tests: ${report.flake.flakyCount}`);
  lines.push(`- Flake Rate: ${report.flake.gate.flakeRate ?? "n/a"}`);
  lines.push(`- Threshold (flakeRateMax): ${report.flake.gate.threshold ?? "n/a"}`);
  lines.push(`- Gate Status: **${report.flake.gate.status}**`);
  lines.push(`- reasonCode: \`${report.flake.gate.reasonCode}\``);
  if (report.flake.flakyTests.length > 0) {
    lines.push("- Top Flaky Tests:");
    for (const flaky of report.flake.flakyTests.slice(0, 10)) {
      lines.push(
        `  - ${flaky.testId} | attempts=${flaky.attemptCount} | statuses=${flaky.statuses.join(",")}`,
      );
    }
  }
  lines.push("");
  lines.push("### Dynamic Baseline");
  lines.push(`- Enabled: ${report.dynamicBaseline.enabled ? "true" : "false"}`);
  lines.push(`- Gate Status: **${report.dynamicBaseline.overall.status}**`);
  lines.push(`- reasonCode: \`${report.dynamicBaseline.overall.reasonCode}\``);
  if (report.dynamicBaseline.enabled) {
    lines.push(`- Baseline Profile: \`${report.dynamicBaseline.baselineProfile}\``);
    lines.push(`- Baseline Window: ${report.dynamicBaseline.baselineWindow}`);
    lines.push(`- Sampled Baseline Runs: ${report.dynamicBaseline.sampledRuns.length}`);
    for (const check of report.dynamicBaseline.checks) {
      lines.push(
        `- ${check.field}: current=${check.current ?? "n/a"}, median=${check.median ?? "n/a"}, p90=${check.p90 ?? "n/a"}, threshold=${check.threshold ?? "n/a"}, status=${check.status}, reasonCode=${check.reasonCode}`,
      );
    }
  }
  lines.push("");
  lines.push(`- Manifest: \`${report.manifestPath}\``);
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = findLatestManifest(options.runsDir);
  if (!manifestPath) {
    throw new Error(`no manifest found under ${options.runsDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runDir = dirname(manifestPath);
  const runId = String(manifest?.runId || "unknown");

  const profilePath = resolve("profiles", `${options.profile}.yaml`);
  const profile = YAML.parse(readFileSync(profilePath, "utf8"));
  const flakeRateMaxRaw = profile?.gates?.flakeRateMax;
  const flakeRateMax = Number.isFinite(Number(flakeRateMaxRaw))
    ? Number(flakeRateMaxRaw)
    : undefined;

  const jsonFiles = walkJsonFiles(runDir);
  const testAttempts = [];
  for (const file of jsonFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    testAttempts.push(...collectTestAttemptsFromJson(parsed, file));
  }

  const flakeStats = analyzeFlakeAttempts(testAttempts);
  const flakeGate = evaluateFlakeGate(flakeRateMax, flakeStats.totalTests, flakeStats.flakyCount);
  const dynamicBaseline = evaluateDynamicBaseline(manifest, options);

  const blockingFailures = [];
  if (flakeGate.status === "failed") {
    blockingFailures.push("flake_rate_max");
  }
  if (dynamicBaseline.overall.status === "failed") {
    blockingFailures.push("dynamic_baseline");
  }
  const overallStatus = blockingFailures.length > 0 ? "failed" : "passed";

  const report = {
    profile: options.profile,
    runId,
    strict: options.strict,
    manifestPath,
    runDir,
    overallStatus,
    blockingFailures,
    flake: {
      totalTests: flakeStats.totalTests,
      flakyCount: flakeStats.flakyCount,
      flakyTests: flakeStats.flakyTests,
      gate: flakeGate,
    },
    dynamicBaseline,
  };

  mkdirSync(resolve(options.outDir), { recursive: true });
  const outJson = resolve(options.outDir, `uiq-${options.profile}-flake-budget.json`);
  const outMd = resolve(options.outDir, `uiq-${options.profile}-flake-budget.md`);
  const markdown = renderMarkdown(report);
  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outMd, markdown, "utf8");
  appendStepSummary(markdown);

  if (options.strict && blockingFailures.length > 0) {
    process.exit(2);
  }
}

main();
