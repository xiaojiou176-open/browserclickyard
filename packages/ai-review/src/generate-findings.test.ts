import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest } from "../../core/src/manifest/types.js";
import { buildAiReviewInput } from "./build-input.js";
import {
  AiReviewGenerationError,
  generateAiReviewReport,
  isSeverityAtOrAbove,
} from "./generate-findings.js";

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: "1.1",
    runId: "run-ai-review",
    target: { type: "web", name: "web.local" },
    profile: "nightly",
    git: { branch: "main", commit: "abc123", dirty: false },
    timing: {
      startedAt: "2026-02-21T00:00:00.000Z",
      finishedAt: "2026-02-21T00:00:10.000Z",
      durationMs: 10000,
    },
    execution: { maxParallelTasks: 2, stagesMs: {}, criticalPath: [] },
    states: [],
    evidenceIndex: [],
    reports: {},
    summary: { consoleError: 0, pageError: 0, http5xx: 0 },
    gateResults: { status: "passed", checks: [] },
    toolchain: { node: process.version },
    ...overrides,
  };
}

test("ai-review blocks when no candidate artifacts exist", () => {
  const manifest = baseManifest();
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  const report = generateAiReviewReport(input, { severityThreshold: "high" });
  assert.equal(report.gate.status, "blocked");
  assert.equal(report.gate.reasonCode, "gate.ai_review.blocked.no_candidate_artifacts");
});

test("ai-review fails when high-severity findings exist", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "page.error",
          expected: 0,
          actual: 1,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "logs/page-error.log",
        },
      ],
    },
  });
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  const report = generateAiReviewReport(input, { severityThreshold: "high" });
  assert.equal(report.gate.status, "failed");
  assert.equal(report.gate.reasonCode, "gate.ai_review.failed.high_severity_findings");
  assert.equal(report.generation.mode, "llm");
  assert.equal(report.generation.promptId, "ai_review.findings_summary");
  assert.equal(report.generation.promptVersion, "1.1.0");
  assert.ok(report.summary.highOrAbove >= 1);
  assert.match(report.findings[0]?.reason_code ?? "", /^(gate\.ai_review\.|ai\.gemini\.)/);
  assert.ok((report.findings[0]?.file_path ?? "").length > 0);
  assert.ok((report.findings[0]?.patch_hint ?? "").length > 0);
  assert.ok((report.findings[0]?.acceptance_check ?? "").length > 0);
  assert.ok(["critical", "high", "medium", "low"].includes(report.findings[0]?.risk_level ?? ""));
});

test("ai-review findings order is deterministic", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "visual.diff_pixels_max",
          expected: 0,
          actual: 10,
          severity: "MAJOR",
          status: "failed",
          reasonCode: "gate.visual_diff_pixels_max.failed.threshold_exceeded",
          evidencePath: "visual/report.json",
        },
        {
          id: "security.high_vuln",
          expected: 0,
          actual: 2,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.security_high_vuln.failed.threshold_exceeded",
          evidencePath: "security/report.json",
        },
      ],
    },
  });
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  const reportA = generateAiReviewReport(input, { severityThreshold: "high" });
  const reportB = generateAiReviewReport(input, { severityThreshold: "high" });
  assert.deepEqual(
    reportA.findings.map((item) => item.issue_id),
    reportB.findings.map((item) => item.issue_id),
  );
  assert.equal(isSeverityAtOrAbove("critical", "high"), true);
  assert.equal(isSeverityAtOrAbove("low", "high"), false);
});

test("ai-review supports explicit rule_fallback mode", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "page.error",
          expected: 0,
          actual: 1,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "logs/page-error.log",
        },
      ],
    },
  });
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  const report = generateAiReviewReport(input, {
    severityThreshold: "high",
    mode: "rule_fallback",
  });
  assert.equal(report.generation.mode, "rule_fallback");
  assert.equal(report.generation.model, "rule-fallback-v1");
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0]?.reason_code ?? "", /^gate\.ai_review\./);
});

test("ai-review fails fast when llm output violates prompt schema", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "page.error",
          expected: 0,
          actual: 1,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "logs/page-error.log",
        },
      ],
    },
  });
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  assert.throws(
    () =>
      generateAiReviewReport(input, {
        severityThreshold: "high",
        llmGenerate: () => ({
          model: "bad-model",
          output: {
            summary: "bad",
            findings: [{ issue_id: "AI-001-page-error", severity: "high", impact: "oops" }],
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof AiReviewGenerationError);
      assert.equal(error.reasonCode, "gate.ai_review.failed.llm_output_schema_invalid");
      return true;
    },
  );
});

test("ai-review fails fast when llm severity is unsupported", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "page.error",
          expected: 0,
          actual: 1,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "logs/page-error.log",
        },
      ],
    },
  });
  const input = buildAiReviewInput(manifest, { maxArtifacts: 40 });
  assert.throws(
    () =>
      generateAiReviewReport(input, {
        severityThreshold: "high",
        llmGenerate: () => ({
          model: "bad-model",
          output: {
            summary: "bad",
            findings: [
              {
                issue_id: "AI-001-page-error",
                severity: "urgent",
                impact: "oops",
                recommendation: "fix",
              },
            ],
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof AiReviewGenerationError);
      assert.equal(error.reasonCode, "gate.ai_review.failed.llm_output_schema_invalid");
      return true;
    },
  );
});
