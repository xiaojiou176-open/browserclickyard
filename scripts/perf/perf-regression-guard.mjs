#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    baseline: "contracts/perf/baseline.json",
    reportDir: ".runtime-cache/artifacts/runs",
    mode: "warn",
    window: 1,
    outDir: ".runtime-cache/artifacts/perf",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--baseline" && next) {
      args.baseline = next;
      i += 1;
    } else if (key === "--report" && next) {
      args.report = next;
      i += 1;
    } else if (key === "--report-dir" && next) {
      args.reportDir = next;
      i += 1;
    } else if (key === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (key === "--window" && next) {
      args.window = Number(next);
      i += 1;
    } else if (key === "--out-dir" && next) {
      args.outDir = next;
      i += 1;
    }
  }
  return args;
}

function walkJsonFiles(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function collectMetricValues(data, key, out = []) {
  if (data == null) {
    return out;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      collectMetricValues(item, key, out);
    }
    return out;
  }
  if (typeof data !== "object") {
    return out;
  }
  for (const [k, v] of Object.entries(data)) {
    if (k.toLowerCase() === key && typeof v === "number" && Number.isFinite(v)) {
      out.push(v);
    }
    collectMetricValues(v, key, out);
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseReportMetrics(raw) {
  const lcpCandidates = [];
  const inpCandidates = [];
  const clsCandidates = [];

  if (raw?.metrics && typeof raw.metrics === "object") {
    if (typeof raw.metrics.lcp === "number") {
      lcpCandidates.push(raw.metrics.lcp);
    }
    if (typeof raw.metrics.inp === "number") {
      inpCandidates.push(raw.metrics.inp);
    }
    if (typeof raw.metrics.cls === "number") {
      clsCandidates.push(raw.metrics.cls);
    }
  }

  collectMetricValues(raw, "lcp", lcpCandidates);
  collectMetricValues(raw, "inp", inpCandidates);
  collectMetricValues(raw, "cls", clsCandidates);

  const pick = (arr) => (arr.length > 0 ? arr[0] : null);

  return {
    lcp: pick(lcpCandidates),
    inp: pick(inpCandidates),
    cls: pick(clsCandidates),
  };
}

function fmt(n) {
  return typeof n === "number" ? Number(n.toFixed(4)) : null;
}

const args = parseArgs(process.argv);
const strictMode = args.mode === "strict";

function failOrWarn(_message, { code = 1 } = {}) {
  if (strictMode) {
    process.exit(code);
  }
  process.exit(0);
}

let baseline = null;
if (!fs.existsSync(args.baseline)) {
  failOrWarn(`baseline not found at ${args.baseline}`);
}

try {
  baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
} catch (_error) {
  process.exit(1);
}

const reportFiles = [];
if (args.report) {
  reportFiles.push(args.report);
} else {
  const files = walkJsonFiles(args.reportDir).filter((f) =>
    f.endsWith(`${path.sep}perf${path.sep}lighthouse.json`),
  );
  files.sort((a, b) => {
    const am = fs.statSync(a).mtimeMs;
    const bm = fs.statSync(b).mtimeMs;
    return bm - am;
  });
  reportFiles.push(...files.slice(0, Math.max(1, args.window)));
}

if (reportFiles.length === 0) {
  failOrWarn("no perf report found");
}

if (reportFiles.length < args.window) {
  failOrWarn(
    `requested ${args.window} runs but only ${reportFiles.length} report(s) were available`,
  );
}

const runs = [];
const parseErrors = [];
for (const file of reportFiles) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    runs.push({ file, metrics: parseReportMetrics(raw) });
  } catch (error) {
    const safeError = error instanceof Error ? error.message : String(error);
    parseErrors.push(`${file}: ${safeError}`);
  }
}

if (runs.length === 0) {
  failOrWarn("reports were unreadable");
}

if (parseErrors.length > 0 && strictMode) {
  for (const _err of parseErrors) {
  }
  process.exit(1);
}

const current = {};
for (const metric of ["lcp", "inp", "cls"]) {
  const values = runs.map((r) => r.metrics[metric]).filter((v) => typeof v === "number");
  current[metric] = values.length > 0 ? median(values) : null;
}

const base = baseline.metrics ?? {};
const thresholds = {
  lcpRegressionRatio: baseline.thresholds?.lcpRegressionRatio ?? 0.15,
  inpRegressionRatio: baseline.thresholds?.inpRegressionRatio ?? 0.2,
  clsRegressionDelta: baseline.thresholds?.clsRegressionDelta ?? 0.03,
};

const findings = [];
if (typeof base.lcp === "number" && typeof current.lcp === "number") {
  const max = base.lcp * (1 + thresholds.lcpRegressionRatio);
  if (current.lcp > max) {
    findings.push(
      `LCP regression: current=${fmt(current.lcp)} baseline=${fmt(base.lcp)} limit=${fmt(max)}`,
    );
  }
}
if (typeof base.inp === "number" && typeof current.inp === "number") {
  const max = base.inp * (1 + thresholds.inpRegressionRatio);
  if (current.inp > max) {
    findings.push(
      `INP regression: current=${fmt(current.inp)} baseline=${fmt(base.inp)} limit=${fmt(max)}`,
    );
  }
}
if (typeof base.cls === "number" && typeof current.cls === "number") {
  const max = base.cls + thresholds.clsRegressionDelta;
  if (current.cls > max) {
    findings.push(
      `CLS regression: current=${fmt(current.cls)} baseline=${fmt(base.cls)} limit=${fmt(max)}`,
    );
  }
}

if (!fs.existsSync(args.outDir)) {
  fs.mkdirSync(args.outDir, { recursive: true });
}

const report = {
  mode: args.mode,
  baselineFile: args.baseline,
  reportFiles,
  sampledRuns: runs.map((r) => ({ file: r.file, metrics: r.metrics })),
  baselineMetrics: base,
  currentMetricsMedian: current,
  thresholds,
  findings,
  warning:
    reportFiles.length < args.window
      ? `Requested ${args.window} runs but only ${reportFiles.length} report(s) were available.`
      : null,
};

const jsonOut = path.join(args.outDir, "perf-regression-report.json");
const mdOut = path.join(args.outDir, "perf-regression-report.md");

fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  "# Performance Regression Report",
  "",
  `- Mode: ${args.mode}`,
  `- Baseline: ${args.baseline}`,
  `- Sampled Reports: ${reportFiles.length}`,
  `- Current (median): LCP=${fmt(current.lcp) ?? "n/a"}, INP=${fmt(current.inp) ?? "n/a"}, CLS=${fmt(current.cls) ?? "n/a"}`,
  "",
];
if (report.warning) {
  lines.push(`- Warning: ${report.warning}`, "");
}
if (findings.length > 0) {
  lines.push("## Regressions", ...findings.map((f) => `- ${f}`));
} else {
  lines.push("## Regressions", "- None");
}
lines.push("", `JSON report: ${jsonOut}`);
fs.writeFileSync(mdOut, `${lines.join("\n")}\n`);

if (findings.length > 0) {
  if (args.mode === "strict") {
    process.exit(1);
  }
}
