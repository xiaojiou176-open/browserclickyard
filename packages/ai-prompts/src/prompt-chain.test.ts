import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPromptDefinition, listPromptDefinitions } from "./registry.js";
import { renderPrompt } from "./render.js";
import { formatValidationIssues, validatePromptInput, validatePromptOutput } from "./validate.js";

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__snapshots__/ai_review.findings_summary@1.1.0.prompt.txt",
);

const validVariables = {
  runId: "run-20260222",
  profile: "nightly",
  targetType: "web",
  targetName: "demo.local",
  severityThreshold: "high",
  candidateArtifacts: 3,
  failedChecksJson: '[{"id":"page.error","status":"failed"}]',
};

test("registry exposes ai_review prompt with deterministic latest version", () => {
  const definitions = listPromptDefinitions();
  const target = definitions.find((item) => item.id === "ai_review.findings_summary");
  assert.ok(target);
  assert.equal(target.version, "1.1.0");

  const byVersion = getPromptDefinition("ai_review.findings_summary", "1.1.0");
  const latest = getPromptDefinition("ai_review.findings_summary");
  assert.equal(byVersion.version, "1.1.0");
  assert.equal(latest.version, "1.1.0");
});

test("schema validation rejects invalid prompt input", () => {
  const definition = getPromptDefinition("ai_review.findings_summary", "1.1.0");
  const invalid = {
    ...validVariables,
    candidateArtifacts: "3",
  };
  const result = validatePromptInput(definition, invalid);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid input");
  }
  assert.match(formatValidationIssues(result.issues), /\$\.candidateArtifacts: Expected number/);
});

test("schema validation accepts strict output payload", () => {
  const definition = getPromptDefinition("ai_review.findings_summary", "1.1.0");
  const output = {
    summary: "1 finding",
    findings: [
      {
        issue_id: "AI-001-page-error",
        severity: "high",
        impact: "Page error happened",
        recommendation: "Fix page runtime error",
        reason_code: "ai.gemini.review.finding.page-error",
        file_path: "logs/page-error.log",
        patch_hint: "Patch failing runtime branch in page handler.",
        acceptance_check: "Re-run gate and ensure page.error is passed.",
        risk_level: "high",
      },
    ],
  };
  const result = validatePromptOutput(definition, output);
  assert.equal(result.ok, true);
});

test("schema validation rejects unexpected output properties", () => {
  const definition = getPromptDefinition("ai_review.findings_summary", "1.1.0");
  const output = {
    summary: "1 finding",
    findings: [
      {
        issue_id: "AI-001-page-error",
        severity: "high",
        impact: "Page error happened",
        recommendation: "Fix page runtime error",
        reason_code: "gate.ai_review.finding.page-error",
        file_path: "logs/page-error.log",
        patch_hint: "Patch failing runtime branch in page handler.",
        acceptance_check: "Re-run gate and ensure page.error is passed.",
        risk_level: "high",
        extra: "not-allowed",
      },
    ],
    extras: true,
  };
  const result = validatePromptOutput(definition, output);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid output");
  }
  assert.match(formatValidationIssues(result.issues), /Unexpected property/);
});

test("rendered prompt matches golden snapshot", () => {
  const rendered = renderPrompt("ai_review.findings_summary", validVariables, "1.1.0");
  const expected = readFileSync(SNAPSHOT_PATH, "utf8");
  assert.equal(`${rendered}\n`, expected);
});
