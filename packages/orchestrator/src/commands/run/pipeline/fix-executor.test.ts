import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { executeFixExecutor } from "./fix-executor.js";

function createTempRunDir(prefix: string): string {
  const baseDir = mkdtempSync(resolve(tmpdir(), prefix));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  return baseDir;
}

test("fix executor keeps files unchanged in report_only mode and emits fix report", () => {
  const baseDir = createTempRunDir("uiq-fix-exec-report-only-");
  try {
    const filePath = "packages/sample/file.ts";
    const absoluteFilePath = resolve(baseDir, filePath);
    mkdirSync(resolve(baseDir, "packages/sample"), { recursive: true });
    writeFileSync(absoluteFilePath, "const value = 'old';\n", "utf8");

    const result = executeFixExecutor({
      baseDir,
      mode: "report_only",
      allowlist: ["packages"],
      findings: [
        {
          issue_id: "AI-001",
          severity: "high",
          impact: "sample",
          evidence: [],
          repro: "sample",
          recommendation: "sample",
          acceptance: "sample",
          reason_code: "gate.ai_review.finding.sample",
          file_path: filePath,
          patch_hint: "replace::old::new",
          acceptance_check: "sample",
          risk_level: "high",
        },
      ],
    });

    assert.equal(result.mode, "report_only");
    assert.equal(result.summary.totalTasks, 1);
    assert.equal(result.summary.planned, 1);
    assert.equal(result.summary.applied, 0);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.gate.status, "passed");
    assert.equal(readFileSync(absoluteFilePath, "utf8"), "const value = 'old';\n");
    const persisted = JSON.parse(
      readFileSync(resolve(baseDir, "reports/fix-result.json"), "utf8"),
    ) as {
      summary: { planned: number };
    };
    assert.equal(persisted.summary.planned, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("fix executor applies replace patch in auto mode when file is allowlisted", () => {
  const baseDir = createTempRunDir("uiq-fix-exec-auto-");
  try {
    const filePath = "packages/sample/file.ts";
    const absoluteFilePath = resolve(baseDir, filePath);
    mkdirSync(resolve(baseDir, "packages/sample"), { recursive: true });
    writeFileSync(absoluteFilePath, "const value = 'old';\n", "utf8");

    const result = executeFixExecutor({
      baseDir,
      mode: "auto",
      allowlist: ["packages"],
      findings: [
        {
          issue_id: "AI-002",
          severity: "high",
          impact: "sample",
          evidence: [],
          repro: "sample",
          recommendation: "sample",
          acceptance: "sample",
          reason_code: "gate.ai_review.finding.sample",
          file_path: filePath,
          patch_hint: "replace::old::new",
          acceptance_check: "sample",
          risk_level: "high",
        },
      ],
    });

    assert.equal(result.summary.applied, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.gate.status, "passed");
    assert.equal(readFileSync(absoluteFilePath, "utf8"), "const value = 'new';\n");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("fix executor fails in auto mode for paths outside allowlist", () => {
  const baseDir = createTempRunDir("uiq-fix-exec-allowlist-");
  try {
    const filePath = "docs/sample.md";
    const absoluteFilePath = resolve(baseDir, filePath);
    mkdirSync(resolve(baseDir, "docs"), { recursive: true });
    writeFileSync(absoluteFilePath, "old\n", "utf8");

    const result = executeFixExecutor({
      baseDir,
      mode: "auto",
      allowlist: ["packages"],
      findings: [
        {
          issue_id: "AI-003",
          severity: "medium",
          impact: "sample",
          evidence: [],
          repro: "sample",
          recommendation: "sample",
          acceptance: "sample",
          reason_code: "gate.ai_review.finding.sample",
          file_path: filePath,
          patch_hint: "replace::old::new",
          acceptance_check: "sample",
          risk_level: "medium",
        },
      ],
    });

    assert.equal(result.gate.status, "failed");
    assert.match(result.gate.reasonCode, /^gate\.ai_fix\.failed\./);
    assert.equal(result.summary.failed, 1);
    assert.equal(readFileSync(absoluteFilePath, "utf8"), "old\n");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("fix executor passes when there are no tasks to execute", () => {
  const baseDir = createTempRunDir("uiq-fix-exec-empty-");
  try {
    const result = executeFixExecutor({
      baseDir,
      mode: "report_only",
      allowlist: ["packages"],
      findings: [],
    });
    assert.equal(result.summary.totalTasks, 0);
    assert.equal(result.gate.status, "passed");
    assert.equal(result.gate.reasonCode, "gate.ai_fix.passed.no_tasks");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
