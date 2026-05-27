#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const manifestSchema = readFileSync(
  resolve(repoRoot, "packages/core/src/manifest/manifest.schema.json"),
  "utf8",
);
const verifyRunEvidence = readFileSync(resolve(repoRoot, "scripts/ci/verify-run-evidence.mjs"), "utf8");
const profileFinalize = readFileSync(
  resolve(repoRoot, "packages/orchestrator/src/commands/run/profile-finalize.ts"),
  "utf8",
);
const runReporting = readFileSync(
  resolve(repoRoot, "packages/orchestrator/src/commands/run/run-reporting.ts"),
  "utf8",
);
const generatedDoc = readFileSync(resolve(repoRoot, "docs/reference/logging-governance.md"), "utf8");
const runtimeTruthSampleRoot = resolve(
  repoRoot,
  "scripts/tests/fixtures/runtime-truth-sample/run-sample",
);
const runtimeTruthSampleManifest = JSON.parse(
  readFileSync(resolve(runtimeTruthSampleRoot, "manifest.json"), "utf8"),
);
const runtimeTruthSampleEvidenceIndex = JSON.parse(
  readFileSync(resolve(runtimeTruthSampleRoot, "reports/evidence.index.json"), "utf8"),
);
const runtimeTruthSampleDiagnosticsIndex = JSON.parse(
  readFileSync(resolve(runtimeTruthSampleRoot, "reports/diagnostics.index.json"), "utf8"),
);

const failures = [];

if (!manifestSchema.includes('"runId"')) {
  failures.push("manifest schema must require runId");
}
if (
  !profileFinalize.includes("evidenceIndexPath") &&
  !runReporting.includes("reports/evidence.index.json")
) {
  failures.push("run evidence pipeline must materialize reports/evidence.index.json");
}
if (!verifyRunEvidence.includes("reports/evidence.index.json")) {
  failures.push("verify-run-evidence must validate reports/evidence.index.json");
}
if (!generatedDoc.includes("reports/evidence.index.json")) {
  failures.push("logging governance reference must document reports/evidence.index.json");
}

if (runtimeTruthSampleManifest.runId !== runtimeTruthSampleEvidenceIndex.runId) {
  failures.push("runtime truth sample evidence index must reuse manifest runId");
}
if (runtimeTruthSampleManifest.profile !== runtimeTruthSampleEvidenceIndex.profile) {
  failures.push("runtime truth sample evidence index must reuse manifest profile");
}
if (
  runtimeTruthSampleManifest.target?.type !== runtimeTruthSampleEvidenceIndex.target?.type ||
  runtimeTruthSampleManifest.target?.name !== runtimeTruthSampleEvidenceIndex.target?.name
) {
  failures.push("runtime truth sample evidence index must reuse manifest target");
}
if (!Array.isArray(runtimeTruthSampleEvidenceIndex.items) || runtimeTruthSampleEvidenceIndex.items.length === 0) {
  failures.push("runtime truth sample evidence index must contain at least one item");
}

const manifestEvidenceById = new Map(
  (runtimeTruthSampleManifest.evidenceIndex ?? []).map((item) => [item.id, item]),
);
for (const item of runtimeTruthSampleEvidenceIndex.items ?? []) {
  if (!item?.id || !item?.source || !item?.evidenceClass || !item?.path) {
    failures.push("runtime truth sample evidence index items must define id/source/evidenceClass/path");
    continue;
  }
  const manifestItem = manifestEvidenceById.get(item.id);
  if (!manifestItem) {
    failures.push(`runtime truth sample evidence index item missing from manifest.evidenceIndex: ${item.id}`);
    continue;
  }
  if (manifestItem.source !== item.source) {
    failures.push(`runtime truth sample evidence source mismatch for ${item.id}`);
  }
  if (manifestItem.kind !== item.evidenceClass) {
    failures.push(`runtime truth sample evidence class mismatch for ${item.id}`);
  }
  if (manifestItem.path !== item.path) {
    failures.push(`runtime truth sample evidence path mismatch for ${item.id}`);
  }
}

if (runtimeTruthSampleDiagnosticsIndex.runId !== runtimeTruthSampleManifest.runId) {
  failures.push("runtime truth sample diagnostics index must reuse manifest runId");
}
if (runtimeTruthSampleDiagnosticsIndex.profile !== runtimeTruthSampleManifest.profile) {
  failures.push("runtime truth sample diagnostics index must reuse manifest profile");
}
if (
  runtimeTruthSampleDiagnosticsIndex.target?.type !== runtimeTruthSampleManifest.target?.type ||
  runtimeTruthSampleDiagnosticsIndex.target?.name !== runtimeTruthSampleManifest.target?.name
) {
  failures.push("runtime truth sample diagnostics index must reuse manifest target");
}
if (
  runtimeTruthSampleDiagnosticsIndex.reports?.evidenceIndex !==
  runtimeTruthSampleManifest.reports?.evidenceIndex
) {
  failures.push("runtime truth sample diagnostics index must point at manifest reports.evidenceIndex");
}
if (
  !Number.isInteger(runtimeTruthSampleDiagnosticsIndex.diagnostics?.execution?.maxParallelTasks) ||
  runtimeTruthSampleDiagnosticsIndex.diagnostics.execution.maxParallelTasks < 1
) {
  failures.push("runtime truth sample diagnostics execution.maxParallelTasks must be a positive integer");
}
if (
  !Array.isArray(runtimeTruthSampleDiagnosticsIndex.diagnostics?.execution?.criticalPath) ||
  runtimeTruthSampleDiagnosticsIndex.diagnostics.execution.criticalPath.length === 0
) {
  failures.push("runtime truth sample diagnostics execution.criticalPath must be non-empty");
}

if (failures.length > 0) {
  console.error(`[check-run-correlation-contract] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-run-correlation-contract] PASS");
