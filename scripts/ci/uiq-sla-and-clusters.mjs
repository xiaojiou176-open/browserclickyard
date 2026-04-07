#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    profile: "",
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    strictSla: false,
    slaMs: undefined,
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
    if (token === "--strict-sla" && next) {
      options.strictSla = next === "true";
    }
    if (token === "--sla-ms" && next) {
      options.slaMs = Number(next);
    }
  }
  if (!options.profile) {
    throw new Error("missing --profile");
  }
  if (options.slaMs !== undefined && (!Number.isFinite(options.slaMs) || options.slaMs < 0)) {
    throw new Error("invalid --sla-ms");
  }
  return options;
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
      const stats = statSync(manifestPath);
      candidates.push({ manifestPath, mtimeMs: stats.mtimeMs });
    } catch {
      // ignore
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.manifestPath;
}

function clusterBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ Ops Summary");
  lines.push(`- Profile: \`${report.profile}\``);
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Gate Status: **${report.gateStatus}**`);
  lines.push(`- Duration: **${report.durationMs} ms**`);
  if (report.sla?.enabled) {
    lines.push(`- SLA: ${report.sla.limitMs} ms (${report.sla.passed ? "pass" : "fail"})`);
  }
  if (report.flakeBudget) {
    lines.push(
      `- Flake Gate: **${report.flakeBudget.flakeStatus}** (${report.flakeBudget.flakeReasonCode})`,
    );
    lines.push(
      `- Dynamic Baseline: **${report.flakeBudget.dynamicStatus}** (${report.flakeBudget.dynamicReasonCode})`,
    );
  }
  lines.push("");
  lines.push("### Stage Durations (Top 10)");
  if (report.stageDurations.length === 0) {
    lines.push("- none");
  } else {
    for (const stage of report.stageDurations) {
      lines.push(`- ${stage.stage}: ${stage.durationMs} ms`);
    }
  }
  lines.push("");
  lines.push("### Failure Clusters (reasonCode)");
  if (report.failureClusters.reasonCode.length === 0) {
    lines.push("- none");
  } else {
    for (const item of report.failureClusters.reasonCode) {
      lines.push(`- ${item.key}: ${item.count}`);
    }
  }
  lines.push("");
  lines.push("### Failure Clusters (checkId)");
  if (report.failureClusters.checkId.length === 0) {
    lines.push("- none");
  } else {
    for (const item of report.failureClusters.checkId) {
      lines.push(`- ${item.key}: ${item.count}`);
    }
  }
  lines.push("");
  lines.push("### Failure Clusters (stepId)");
  if (report.failureClusters.stepId.length === 0) {
    lines.push("- none");
  } else {
    for (const item of report.failureClusters.stepId) {
      lines.push(`- ${item.key}: ${item.count}`);
    }
  }
  if (report.securityClusters.byRule.length > 0 || report.securityClusters.byComponent.length > 0) {
    lines.push("");
    lines.push("### Security Clusters");
    if (report.securityClusters.byRule.length > 0) {
      lines.push("- byRule:");
      for (const item of report.securityClusters.byRule.slice(0, 5)) {
        lines.push(`  - ${item.key}: ${item.count}`);
      }
    }
    if (report.securityClusters.byComponent.length > 0) {
      lines.push("- byComponent:");
      for (const item of report.securityClusters.byComponent.slice(0, 5)) {
        lines.push(`  - ${item.key}: ${item.count}`);
      }
    }
  }
  if (report.flakeBudget) {
    lines.push("");
    lines.push("### Flake + Dynamic Baseline");
    lines.push(`- report: ${report.flakeBudget.path}`);
    lines.push(
      `- flake: status=${report.flakeBudget.flakeStatus}, rate=${report.flakeBudget.flakeRate ?? "n/a"}, threshold=${report.flakeBudget.flakeThreshold ?? "n/a"}, reasonCode=${report.flakeBudget.flakeReasonCode}`,
    );
    lines.push(
      `- dynamic baseline: status=${report.flakeBudget.dynamicStatus}, reasonCode=${report.flakeBudget.dynamicReasonCode}, sampledRuns=${report.flakeBudget.sampledRuns}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function appendStepSummary(text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, text, { encoding: "utf8", flag: "a" });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = findLatestManifest(options.runsDir);
  if (!manifestPath) {
    throw new Error(`no manifest found under ${options.runsDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runId = String(manifest.runId || "unknown");
  const gateStatus = String(manifest?.gateResults?.status || "unknown");
  const durationMs = Number(manifest?.timing?.durationMs || 0);
  const stagesMs =
    manifest?.execution?.stagesMs && typeof manifest.execution.stagesMs === "object"
      ? manifest.execution.stagesMs
      : {};

  const stageDurations = Object.entries(stagesMs)
    .map(([stage, value]) => ({ stage, durationMs: Number(value || 0) }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  const failedChecks = Array.isArray(manifest?.gateResults?.checks)
    ? manifest.gateResults.checks.filter(
        (check) => check.status === "failed" || check.status === "blocked",
      )
    : [];
  const failureLocations = Array.isArray(manifest?.diagnostics?.failureLocations)
    ? manifest.diagnostics.failureLocations
    : [];

  const reasonClusters = clusterBy(failedChecks, (check) =>
    String(check.reasonCode || "unspecified"),
  );
  const checkIdClusters = clusterBy(failedChecks, (check) => String(check.id || "unknown"));
  const stepClusters = clusterBy(failureLocations, (item) => String(item.stepId || "unknown"));
  const securityByRule = Array.isArray(manifest?.diagnostics?.security?.clusters?.byRule)
    ? manifest.diagnostics.security.clusters.byRule.map((item) => ({
        key: String(item.key),
        count: Number(item.count || 0),
      }))
    : [];
  const securityByComponent = Array.isArray(manifest?.diagnostics?.security?.clusters?.byComponent)
    ? manifest.diagnostics.security.clusters.byComponent.map((item) => ({
        key: String(item.key),
        count: Number(item.count || 0),
      }))
    : [];

  const slaEnabled = options.slaMs !== undefined;
  const slaPassed = !slaEnabled || durationMs <= Number(options.slaMs);
  const flakeBudgetPath = resolve(options.outDir, `uiq-${options.profile}-flake-budget.json`);
  let flakeBudget = null;
  if (existsSync(flakeBudgetPath)) {
    try {
      const raw = JSON.parse(readFileSync(flakeBudgetPath, "utf8"));
      flakeBudget = {
        path: flakeBudgetPath,
        flakeStatus: String(raw?.flake?.gate?.status || "unknown"),
        flakeReasonCode: String(raw?.flake?.gate?.reasonCode || "unspecified"),
        flakeRate: Number.isFinite(Number(raw?.flake?.gate?.flakeRate))
          ? Number(raw.flake.gate.flakeRate)
          : null,
        flakeThreshold: Number.isFinite(Number(raw?.flake?.gate?.threshold))
          ? Number(raw.flake.gate.threshold)
          : null,
        dynamicStatus: String(raw?.dynamicBaseline?.overall?.status || "unknown"),
        dynamicReasonCode: String(raw?.dynamicBaseline?.overall?.reasonCode || "unspecified"),
        sampledRuns: Array.isArray(raw?.dynamicBaseline?.sampledRuns)
          ? raw.dynamicBaseline.sampledRuns.length
          : 0,
      };
    } catch {
      flakeBudget = {
        path: flakeBudgetPath,
        flakeStatus: "unknown",
        flakeReasonCode: "flake_budget_parse_failed",
        flakeRate: null,
        flakeThreshold: null,
        dynamicStatus: "unknown",
        dynamicReasonCode: "flake_budget_parse_failed",
        sampledRuns: 0,
      };
    }
  }
  const report = {
    profile: options.profile,
    runId,
    manifestPath,
    gateStatus,
    durationMs,
    stageDurations,
    failureClusters: {
      reasonCode: reasonClusters,
      checkId: checkIdClusters,
      stepId: stepClusters,
    },
    securityClusters: {
      byRule: securityByRule,
      byComponent: securityByComponent,
    },
    sla: slaEnabled
      ? {
          enabled: true,
          limitMs: Number(options.slaMs),
          strict: options.strictSla,
          passed: slaPassed,
        }
      : { enabled: false },
    flakeBudget,
  };

  mkdirSync(resolve(options.outDir), { recursive: true });
  const outJson = resolve(options.outDir, `uiq-${options.profile}-ops-summary.json`);
  const outMd = resolve(options.outDir, `uiq-${options.profile}-ops-summary.md`);
  const markdown = renderMarkdown(report);

  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outMd, markdown, "utf8");
  appendStepSummary(markdown);

  if (options.strictSla && slaEnabled && !slaPassed) {
    process.exit(2);
  }
}

main();
