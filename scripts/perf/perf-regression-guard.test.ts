import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts/perf/perf-regression-guard.mjs");

function runGuard(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

function writeBaseline(root: string) {
  const baselinePath = path.join(root, "baseline.json");
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        metrics: { lcp: 1000, inp: 100, cls: 0.05 },
        thresholds: { lcpRegressionRatio: 0.15, inpRegressionRatio: 0.2, clsRegressionDelta: 0.03 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return baselinePath;
}

function writeReport(root: string, metricValue = 900) {
  const reportDir = path.join(root, "reports", "a", "perf");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "lighthouse.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify({ metrics: { lcp: metricValue, inp: 90, cls: 0.04 } })}\n`,
    "utf8",
  );
  return { reportDir: path.join(root, "reports"), reportPath };
}

test("strict mode fails when baseline is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-guard-missing-baseline-"));
  const result = runGuard([
    "--mode",
    "strict",
    "--baseline",
    path.join(root, "missing.json"),
    "--report-dir",
    root,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline not found/i);
});

test("warn mode does not fail when baseline is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-guard-warn-missing-baseline-"));
  const result = runGuard([
    "--mode",
    "warn",
    "--baseline",
    path.join(root, "missing.json"),
    "--report-dir",
    root,
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /baseline not found/i);
});

test("strict mode fails when no report exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-guard-no-report-"));
  const baselinePath = writeBaseline(root);
  const result = runGuard([
    "--mode",
    "strict",
    "--baseline",
    baselinePath,
    "--report-dir",
    path.join(root, "empty-reports"),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no perf report found/i);
});

test("strict mode fails when sample count is lower than window", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-guard-sample-window-"));
  const baselinePath = writeBaseline(root);
  const { reportDir } = writeReport(root);
  const result = runGuard([
    "--mode",
    "strict",
    "--baseline",
    baselinePath,
    "--report-dir",
    reportDir,
    "--window",
    "2",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requested 2 runs but only 1 report/);
});

test("strict mode fails on parse issues", () => {
  const root = mkdtempSync(path.join(tmpdir(), "perf-guard-parse-fail-"));
  const baselinePath = writeBaseline(root);
  const reportPath = path.join(root, "broken-report.json");
  writeFileSync(reportPath, "{this is invalid json}\n", "utf8");
  const result = runGuard(["--mode", "strict", "--baseline", baselinePath, "--report", reportPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reports were unreadable|strict mode parse failures/i);
});
