import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { readManifest, writeManifest } from "./io.js";
import type { Manifest } from "./types.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "uiq-manifest-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeManifest/readManifest round-trip v1.1", () => {
  withTempDir((dir) => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    mkdirSync(resolve(dir, "logs"), { recursive: true });
    writeFileSync(resolve(dir, "reports/summary.json"), "{}", "utf8");
    writeFileSync(resolve(dir, "reports/fix-plan.md"), "# fix plan", "utf8");
    writeFileSync(resolve(dir, "reports/fix-result.md"), "# fix result", "utf8");
    writeFileSync(resolve(dir, "reports/post-fix-regression.md"), "# post-fix", "utf8");
    writeFileSync(resolve(dir, "logs/capture.log"), "", "utf8");

    const manifest: Manifest = {
      schemaVersion: "1.1",
      runId: "run-test",
      target: { type: "web", name: "web.local" },
      profile: "pr",
      git: { branch: "main", commit: "abc123", dirty: false },
      timing: {
        startedAt: "2026-02-21T00:00:00.000Z",
        finishedAt: "2026-02-21T00:00:10.000Z",
        durationMs: 10000,
      },
      execution: { maxParallelTasks: 2, stagesMs: { capture: 1200 }, criticalPath: ["capture"] },
      states: [
        {
          id: "home",
          source: "routes",
          steps: ["goto:/"],
          artifacts: { log: "logs/capture.log" },
        },
      ],
      evidenceIndex: [
        { id: "report.summary", source: "report", kind: "report", path: "reports/summary.json" },
        { id: "state.home.log", source: "state", kind: "log", path: "logs/capture.log" },
      ],
      reports: {
        report: "reports/summary.json",
        fixPlan: "reports/fix-plan.md",
        fixResult: "reports/fix-result.md",
        postFixRegression: "reports/post-fix-regression.md",
      },
      summary: {
        consoleError: 0,
        pageError: 0,
        http5xx: 0,
        fixIterations: 2,
        fixConverged: true,
        cacheStats: { hit: 3, miss: 1, hitRate: 0.75 },
      },
      gateResults: {
        status: "passed",
        checks: [
          {
            id: "console.error",
            expected: 0,
            actual: 0,
            severity: "BLOCKER",
            status: "passed",
            reasonCode: "gate.console_error.passed.ok",
            evidencePath: "reports/summary.json",
          },
        ],
      },
      toolchain: { node: process.version },
    };

    const manifestPath = writeManifest(dir, manifest);
    const read = readManifest(manifestPath);
    assert.equal(read.schemaCompatibility, "v1.1");
    assert.equal(read.manifest.schemaVersion, "1.1");
    assert.equal(read.missingEvidence.length, 0);
    assert.equal(read.manifest.summary.fixIterations, 2);
    assert.equal(read.manifest.summary.fixConverged, true);
    assert.equal(read.manifest.summary.cacheStats?.hit, 3);
    assert.equal(read.manifest.summary.cacheStats?.miss, 1);
    assert.equal(read.manifest.summary.cacheStats?.hits, 3);
    assert.equal(read.manifest.summary.cacheStats?.misses, 1);
    assert.equal(read.manifest.reports.fixPlan, "reports/fix-plan.md");
    assert.equal(read.manifest.reports.fixResult, "reports/fix-result.md");
    assert.equal(read.manifest.reports.postFixRegression, "reports/post-fix-regression.md");
  });
});

test("readManifest normalizes legacy manifest to v1.1", () => {
  withTempDir((dir) => {
    mkdirSync(resolve(dir, "reports"), { recursive: true });
    writeFileSync(resolve(dir, "reports/summary.json"), "{}", "utf8");

    const legacy = {
      runId: "legacy-run",
      target: { type: "web", name: "web.local" },
      profile: "nightly",
      git: { branch: "main", commit: "def456", dirty: true },
      timing: {
        startedAt: "2026-02-21T00:00:00.000Z",
        finishedAt: "2026-02-21T00:00:20.000Z",
        durationMs: 20000,
      },
      states: [],
      reports: { report: "reports/summary.json" },
      summary: {
        consoleError: 0,
        pageError: 0,
        http5xx: 0,
        cacheStats: { hits: 4, misses: 1, hitRate: 0.8 },
      },
      gateResults: {
        status: "failed",
        checks: [
          {
            id: "console.error",
            expected: 0,
            actual: 1,
            severity: "BLOCKER",
            status: "failed",
            evidencePath: "reports/summary.json",
          },
        ],
      },
      toolchain: { node: process.version },
    };

    const path = resolve(dir, "manifest.json");
    writeFileSync(path, JSON.stringify(legacy, null, 2), "utf8");

    const read = readManifest(path);
    assert.equal(read.schemaCompatibility, "legacy_v1");
    assert.equal(read.manifest.schemaVersion, "1.1");
    assert.equal(read.manifest.schemaCompatibility, "legacy_v1");
    const firstCheck = read.manifest.gateResults.checks[0];
    assert.ok(firstCheck);
    assert.ok(firstCheck.reasonCode?.startsWith("gate.console_error.failed"));
    assert.ok(read.manifest.execution);
    assert.ok(read.manifest.execution.maxParallelTasks >= 1);
    assert.equal(read.manifest.summary.cacheStats?.hit, 4);
    assert.equal(read.manifest.summary.cacheStats?.miss, 1);
    assert.equal(read.manifest.summary.cacheStats?.hitRate, 0.8);
  });
});
