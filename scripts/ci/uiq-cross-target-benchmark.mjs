#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_TARGETS = ["web", "tauri", "swift"];
const DEFAULT_KEY_GATE_IDS = new Set([
  "runtime.healthcheck",
  "test.unit",
  "test.contract",
  "test.ct",
  "test.e2e",
  "a11y.serious_max",
  "perf.lcp_ms_max",
  "perf.fcp_ms_max",
  "visual.diff_pixels_max",
  "load.failed_requests",
  "load.p95_ms",
  "load.rps_min",
  "security.high_vuln",
  "desktop.readiness",
  "desktop.smoke",
  "desktop.e2e",
  "desktop.soak",
]);

function parseArgs(argv) {
  const options = {
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    profile: "",
    lookbackDays: 7,
    limit: 100,
    targets: DEFAULT_TARGETS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--runs-dir" && next) {
      options.runsDir = next;
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--profile" && next) {
      options.profile = next;
    }
    if (token === "--lookback-days" && next) {
      options.lookbackDays = Number(next);
    }
    if (token === "--limit" && next) {
      options.limit = Number(next);
    }
    if (token === "--targets" && next) {
      options.targets = next
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
    }
  }

  if (!Number.isFinite(options.lookbackDays) || options.lookbackDays < 1) {
    throw new Error("invalid --lookback-days");
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("invalid --limit");
  }
  if (options.targets.length === 0) {
    throw new Error("invalid --targets");
  }
  return options;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBinary(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  const num = toFiniteNumber(value);
  if (num === null) {
    return null;
  }
  return num > 0 ? 1 : 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const num = toFiniteNumber(value);
    if (num !== null) {
      return num;
    }
  }
  return null;
}

function normalizeGateStatus(status) {
  if (status === "passed" || status === "failed" || status === "blocked") {
    return status;
  }
  if (status === "success" || status === "ok") {
    return "passed";
  }
  if (status === "error") {
    return "failed";
  }
  return "unknown";
}

function clampRatio(value) {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function round(value, precision = 4) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function findManifests(runsDir) {
  const absRunsDir = resolve(runsDir);
  const manifests = [];
  for (const entry of readdirSync(absRunsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = resolve(absRunsDir, entry.name, "manifest.json");
    try {
      const stats = statSync(manifestPath);
      manifests.push({
        manifestPath,
        runDirName: entry.name,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // ignore run dirs without manifest
    }
  }
  manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return manifests;
}

function parseTimestamp(value, fallbackMs) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackMs;
}

function inferTargetType(manifest, runId) {
  const direct =
    typeof manifest?.target?.type === "string" ? manifest.target.type.toLowerCase() : "";
  if (DEFAULT_TARGETS.includes(direct)) {
    return direct;
  }

  const signal = `${runId} ${manifest?.target?.name || ""}`.toLowerCase();
  if (signal.includes("tauri")) {
    return "tauri";
  }
  if (signal.includes("swift") || signal.includes("xcode") || signal.includes("macos")) {
    return "swift";
  }
  if (signal.includes("web")) {
    return "web";
  }
  return "unknown";
}

function extractChecks(manifest) {
  if (!Array.isArray(manifest?.gateResults?.checks)) {
    return [];
  }
  return manifest.gateResults.checks
    .filter((item) => isRecord(item) && typeof item.id === "string")
    .map((item) => ({
      id: String(item.id),
      status: normalizeGateStatus(item.status),
    }));
}

function extractDesktopInteractionChecks(manifest) {
  const diagnostics = isRecord(manifest?.diagnostics) ? manifest.diagnostics : {};
  const desktopE2E = isRecord(diagnostics.desktopE2E) ? diagnostics.desktopE2E : {};
  if (!Array.isArray(desktopE2E.checks)) {
    return [];
  }
  return desktopE2E.checks
    .filter((check) => isRecord(check) && typeof check.status === "string")
    .map((check) => normalizeGateStatus(check.status));
}

function extractRunMetrics(manifest, checks) {
  const summary = isRecord(manifest?.summary) ? manifest.summary : {};
  const diagnostics = isRecord(manifest?.diagnostics) ? manifest.diagnostics : {};
  const crossTarget = isRecord(diagnostics.crossTarget) ? diagnostics.crossTarget : {};
  const desktopSoak = isRecord(diagnostics.desktopSoak) ? diagnostics.desktopSoak : {};

  let startupAvailable = toBinary(summary.startupAvailable);
  if (startupAvailable === null) {
    startupAvailable = toBinary(crossTarget.startupAvailable);
  }
  if (startupAvailable === null) {
    const startupChecks = checks.filter(
      (check) => check.id === "runtime.healthcheck" || check.id === "desktop.readiness",
    );
    if (startupChecks.length > 0) {
      startupAvailable = startupChecks.every((check) => check.status === "passed") ? 1 : 0;
    }
  }

  let interactionPassed = toFiniteNumber(crossTarget.interactionPassed);
  let interactionTotal = toFiniteNumber(crossTarget.interactionTotal);
  let interactionPassRatio = firstFiniteNumber(
    summary.interactionPassRatio,
    crossTarget.interactionPassRatio,
  );

  if (interactionPassRatio !== null) {
    interactionPassRatio = clampRatio(interactionPassRatio);
  }

  if (
    interactionPassed !== null &&
    interactionTotal !== null &&
    interactionTotal > 0 &&
    interactionPassRatio === null
  ) {
    interactionPassRatio = clampRatio(interactionPassed / interactionTotal);
  }

  if (
    (interactionPassed === null || interactionTotal === null || interactionTotal === 0) &&
    interactionPassRatio === null
  ) {
    const desktopInteractionStatuses = extractDesktopInteractionChecks(manifest);
    if (desktopInteractionStatuses.length > 0) {
      interactionTotal = desktopInteractionStatuses.length;
      interactionPassed = desktopInteractionStatuses.filter((status) => status === "passed").length;
      interactionPassRatio = clampRatio(interactionPassed / interactionTotal);
    }
  }

  if (
    (interactionPassed === null || interactionTotal === null || interactionTotal === 0) &&
    interactionPassRatio === null
  ) {
    const fallbackChecks = checks.filter(
      (check) => check.id === "test.e2e" || check.id === "desktop.e2e",
    );
    if (fallbackChecks.length > 0) {
      interactionTotal = fallbackChecks.length;
      interactionPassed = fallbackChecks.filter((check) => check.status === "passed").length;
      interactionPassRatio = clampRatio(interactionPassed / interactionTotal);
    }
  }

  let keyGatePassed = toFiniteNumber(crossTarget.keyGatePassed);
  let keyGateTotal = toFiniteNumber(crossTarget.keyGateTotal);
  let keyGatePassRatio = firstFiniteNumber(summary.keyGatePassRatio, crossTarget.keyGatePassRatio);

  if (keyGatePassRatio !== null) {
    keyGatePassRatio = clampRatio(keyGatePassRatio);
  }

  if (
    keyGatePassed !== null &&
    keyGateTotal !== null &&
    keyGateTotal > 0 &&
    keyGatePassRatio === null
  ) {
    keyGatePassRatio = clampRatio(keyGatePassed / keyGateTotal);
  }

  if (
    (keyGatePassed === null || keyGateTotal === null || keyGateTotal === 0) &&
    keyGatePassRatio === null
  ) {
    const selectedKeyChecks = checks.filter((check) => DEFAULT_KEY_GATE_IDS.has(check.id));
    const effectiveKeyChecks = selectedKeyChecks.length > 0 ? selectedKeyChecks : checks;
    if (effectiveKeyChecks.length > 0) {
      keyGateTotal = effectiveKeyChecks.length;
      keyGatePassed = effectiveKeyChecks.filter((check) => check.status === "passed").length;
      keyGatePassRatio = clampRatio(keyGatePassed / keyGateTotal);
    }
  }

  const crashCount = firstFiniteNumber(
    summary.crashCount,
    crossTarget.crashCount,
    desktopSoak.crashCount,
  );
  const rssGrowthMb = firstFiniteNumber(
    summary.rssGrowthMb,
    crossTarget.rssGrowthMb,
    desktopSoak.rssGrowthMb,
  );
  const cpuAvg = firstFiniteNumber(summary.cpuAvg, crossTarget.cpuAvg, desktopSoak.cpuAvgPercent);

  return {
    startupAvailable,
    interactionPassed,
    interactionTotal,
    interactionPassRatio,
    keyGatePassed,
    keyGateTotal,
    keyGatePassRatio,
    crashCount,
    rssGrowthMb,
    cpuAvg,
  };
}

function createTargetAccumulator(targetType) {
  return {
    targetType,
    runCount: 0,
    latestRunId: null,
    latestFinishedAt: null,
    latestTimestamp: 0,
    gateStatusCounts: {
      passed: 0,
      failed: 0,
      blocked: 0,
      unknown: 0,
    },
    startup: { sum: 0, count: 0 },
    interaction: { passed: 0, total: 0 },
    keyGate: { passed: 0, total: 0 },
    crash: { sum: 0, count: 0 },
    rss: { sum: 0, count: 0 },
    cpu: { sum: 0, count: 0 },
  };
}

function addRunToAccumulator(acc, run) {
  acc.runCount += 1;
  if (run.finishedAtMs >= acc.latestTimestamp) {
    acc.latestTimestamp = run.finishedAtMs;
    acc.latestRunId = run.runId;
    acc.latestFinishedAt = run.finishedAt;
  }
  acc.gateStatusCounts[run.gateStatus] += 1;

  if (run.metrics.startupAvailable !== null) {
    acc.startup.sum += run.metrics.startupAvailable;
    acc.startup.count += 1;
  }

  if (
    run.metrics.interactionTotal !== null &&
    run.metrics.interactionTotal > 0 &&
    run.metrics.interactionPassed !== null
  ) {
    acc.interaction.passed += run.metrics.interactionPassed;
    acc.interaction.total += run.metrics.interactionTotal;
  } else if (run.metrics.interactionPassRatio !== null) {
    acc.interaction.passed += run.metrics.interactionPassRatio;
    acc.interaction.total += 1;
  }

  if (
    run.metrics.keyGateTotal !== null &&
    run.metrics.keyGateTotal > 0 &&
    run.metrics.keyGatePassed !== null
  ) {
    acc.keyGate.passed += run.metrics.keyGatePassed;
    acc.keyGate.total += run.metrics.keyGateTotal;
  } else if (run.metrics.keyGatePassRatio !== null) {
    acc.keyGate.passed += run.metrics.keyGatePassRatio;
    acc.keyGate.total += 1;
  }

  if (run.metrics.crashCount !== null) {
    acc.crash.sum += run.metrics.crashCount;
    acc.crash.count += 1;
  }
  if (run.metrics.rssGrowthMb !== null) {
    acc.rss.sum += run.metrics.rssGrowthMb;
    acc.rss.count += 1;
  }
  if (run.metrics.cpuAvg !== null) {
    acc.cpu.sum += run.metrics.cpuAvg;
    acc.cpu.count += 1;
  }
}

function finalizeTargetAccumulator(acc) {
  const missing = acc.runCount === 0;
  return {
    targetType: acc.targetType,
    status: missing ? "missing" : "ok",
    runCount: acc.runCount,
    latestRunId: acc.latestRunId,
    latestFinishedAt: acc.latestFinishedAt,
    gateStatusCounts: acc.gateStatusCounts,
    startupAvailableRate: acc.startup.count > 0 ? round(acc.startup.sum / acc.startup.count) : null,
    interactionPassRatio:
      acc.interaction.total > 0 ? round(acc.interaction.passed / acc.interaction.total) : null,
    keyGatePassRatio: acc.keyGate.total > 0 ? round(acc.keyGate.passed / acc.keyGate.total) : null,
    crashCountAvg: acc.crash.count > 0 ? round(acc.crash.sum / acc.crash.count, 2) : null,
    rssGrowthMbAvg: acc.rss.count > 0 ? round(acc.rss.sum / acc.rss.count, 2) : null,
    cpuAvg: acc.cpu.count > 0 ? round(acc.cpu.sum / acc.cpu.count, 2) : null,
    notes: missing ? ["no run artifact for this target in selected window"] : [],
  };
}

function formatRatio(value) {
  if (value === null) {
    return "n/a";
  }
  return `${round(value * 100, 2)}%`;
}

function formatNumber(value) {
  if (value === null) {
    return "n/a";
  }
  return String(value);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ Cross-Target Weekly Benchmark");
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- Runs Dir: \`${report.source.runsDir}\``);
  lines.push(`- Profile Filter: \`${report.source.profileFilter || "(none)"}\``);
  lines.push(`- Lookback: \`${report.source.lookbackDays}\` days`);
  lines.push(`- Runs Used: \`${report.totals.runsUsed}\``);
  lines.push(
    `- Target Coverage: \`${report.coverage.presentTargets.length}/${report.expectedTargets.length}\``,
  );
  if (report.coverage.missingTargets.length > 0) {
    lines.push(
      `- Missing Targets: ${report.coverage.missingTargets.map((item) => `\`${item}\``).join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    "| target | status | runs | startup_available | interaction_pass_rate | crash_count(avg) | rss_growth_mb(avg) | cpu_avg | key_gate_pass_ratio | latest_run | gate_status_counts |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|");

  for (const target of report.expectedTargets) {
    const item = report.targets[target];
    lines.push(
      `| ${target} | ${item.status} | ${item.runCount} | ${formatRatio(item.startupAvailableRate)} | ${formatRatio(item.interactionPassRatio)} | ${formatNumber(item.crashCountAvg)} | ${formatNumber(item.rssGrowthMbAvg)} | ${formatNumber(item.cpuAvg)} | ${formatRatio(item.keyGatePassRatio)} | ${item.latestRunId || "-"} | passed:${item.gateStatusCounts.passed} failed:${item.gateStatusCounts.failed} blocked:${item.gateStatusCounts.blocked} unknown:${item.gateStatusCounts.unknown} |`,
    );
  }

  if (Object.keys(report.unknownTargets).length > 0) {
    lines.push("");
    lines.push("### Unknown Target Buckets");
    for (const [target, item] of Object.entries(report.unknownTargets)) {
      lines.push(`- ${target}: runs=${item.runCount}, latest=${item.latestRunId || "-"}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, markdown, { encoding: "utf8", flag: "a" });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const absRunsDir = resolve(options.runsDir);
  const manifestCandidates = findManifests(absRunsDir);
  const nowMs = Date.now();
  const cutoffMs = nowMs - options.lookbackDays * 24 * 60 * 60 * 1000;

  const selectedRuns = [];
  for (const candidate of manifestCandidates) {
    const manifest = JSON.parse(readFileSync(candidate.manifestPath, "utf8"));
    const runId =
      typeof manifest?.runId === "string" && manifest.runId.length > 0
        ? manifest.runId
        : candidate.runDirName;
    const finishedAtMs = parseTimestamp(
      manifest?.timing?.finishedAt ?? manifest?.timing?.startedAt,
      candidate.mtimeMs,
    );
    if (finishedAtMs < cutoffMs) {
      continue;
    }

    const profile = typeof manifest?.profile === "string" ? manifest.profile : "";
    if (options.profile && profile !== options.profile) {
      continue;
    }

    const checks = extractChecks(manifest);
    const gateStatus = normalizeGateStatus(manifest?.gateResults?.status);
    const metrics = extractRunMetrics(manifest, checks);
    const targetType = inferTargetType(manifest, runId);

    selectedRuns.push({
      runId,
      profile,
      manifestPath: candidate.manifestPath,
      finishedAt: new Date(finishedAtMs).toISOString(),
      finishedAtMs,
      gateStatus,
      targetType,
      metrics,
    });

    if (selectedRuns.length >= options.limit) {
      break;
    }
  }

  const expectedTargetSet = new Set(options.targets);
  const targetAccumulators = {};
  for (const target of options.targets) {
    targetAccumulators[target] = createTargetAccumulator(target);
  }
  const unknownAccumulators = {};

  for (const run of selectedRuns) {
    if (expectedTargetSet.has(run.targetType)) {
      addRunToAccumulator(targetAccumulators[run.targetType], run);
      continue;
    }
    if (!unknownAccumulators[run.targetType]) {
      unknownAccumulators[run.targetType] = createTargetAccumulator(run.targetType);
    }
    addRunToAccumulator(unknownAccumulators[run.targetType], run);
  }

  const finalizedTargets = {};
  for (const [target, acc] of Object.entries(targetAccumulators)) {
    finalizedTargets[target] = finalizeTargetAccumulator(acc);
  }

  const finalizedUnknownTargets = {};
  for (const [target, acc] of Object.entries(unknownAccumulators)) {
    finalizedUnknownTargets[target] = finalizeTargetAccumulator(acc);
  }

  const missingTargets = options.targets.filter(
    (target) => finalizedTargets[target].runCount === 0,
  );
  const presentTargets = options.targets.filter((target) => finalizedTargets[target].runCount > 0);

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      runsDir: absRunsDir,
      profileFilter: options.profile || null,
      lookbackDays: options.lookbackDays,
      limit: options.limit,
    },
    expectedTargets: options.targets,
    coverage: {
      presentTargets,
      missingTargets,
      targetCoverageRatio:
        options.targets.length > 0 ? round(presentTargets.length / options.targets.length) : 0,
    },
    totals: {
      manifestsDiscovered: manifestCandidates.length,
      runsUsed: selectedRuns.length,
    },
    targets: finalizedTargets,
    unknownTargets: finalizedUnknownTargets,
    runs: selectedRuns.map((run) => ({
      runId: run.runId,
      profile: run.profile || null,
      manifestPath: run.manifestPath,
      targetType: run.targetType,
      gateStatus: run.gateStatus,
      finishedAt: run.finishedAt,
      metrics: {
        startupAvailable: run.metrics.startupAvailable,
        interactionPassRatio:
          run.metrics.interactionPassRatio !== null
            ? round(run.metrics.interactionPassRatio)
            : null,
        crashCount: run.metrics.crashCount,
        rssGrowthMb: run.metrics.rssGrowthMb,
        cpuAvg: run.metrics.cpuAvg,
        keyGatePassRatio:
          run.metrics.keyGatePassRatio !== null ? round(run.metrics.keyGatePassRatio) : null,
      },
    })),
  };

  const markdown = renderMarkdown(report);
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const outJson = resolve(outDir, "uiq-cross-target-benchmark.json");
  const outMd = resolve(outDir, "uiq-cross-target-benchmark.md");

  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outMd, markdown, "utf8");
  appendStepSummary(markdown);
}

main();
