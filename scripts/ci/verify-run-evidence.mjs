#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseArgs(argv) {
  const options = {
    profile: "",
    runsDir: ".runtime-cache/artifacts/runs",
    runId: "",
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
    if (token === "--run-id" && next) {
      options.runId = next;
    }
  }
  if (!options.profile) {
    throw new Error("missing --profile");
  }
  if (options.runId && !SAFE_RUN_ID_PATTERN.test(options.runId)) {
    throw new Error("invalid --run-id, expected pattern [A-Za-z0-9._-]+");
  }
  return options;
}

function findLatestManifest(runsDir) {
  const root = resolve(runsDir);
  const manifests = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = resolve(root, entry.name, "manifest.json");
    try {
      manifests.push({ path: manifest, mtimeMs: statSync(manifest).mtimeMs });
    } catch {
      // ignore runs without manifest
    }
  }
  manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return manifests[0]?.path;
}

function resolveManifestFromRunId(runsDir, runId) {
  const root = resolve(runsDir);
  const candidate = resolve(root, runId, "manifest.json");
  const relPath = relative(root, candidate);
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`run-id resolves outside runsDir: ${runId}`);
  }
  return candidate;
}

function resolveArtifact(runDir, artifactPath) {
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    return null;
  }
  const normalizedRunDir = resolve(runDir);
  const candidate = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : resolve(normalizedRunDir, artifactPath);
  const relPath = relative(normalizedRunDir, candidate);
  const isInsideRunDir =
    relPath === "" ||
    (!relPath.startsWith("..") && !isAbsolute(relPath) && !relPath.startsWith(`..${sep}`));
  if (!isInsideRunDir) {
    return null;
  }
  return candidate;
}

function existsFile(path) {
  if (!path) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeArtifactForCompare(runDir, artifactPath) {
  const resolved = resolveArtifact(runDir, artifactPath);
  if (!resolved) {
    return "";
  }
  return resolved.split("\\").join("/");
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isAiReviewSeverity(value) {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function hasAllowedAiReviewReasonCodePrefix(value) {
  return (
    value.startsWith("gate.ai_fix.") ||
    value.startsWith("gate.ai_review.") ||
    value.startsWith("ai.gemini.")
  );
}

function validateAiReviewReportSchema(report, expected) {
  const issues = [];
  if (report?.schemaVersion !== "1.0") {
    issues.push("schemaVersion must be '1.0'");
  }
  if (normalizeText(report?.runId) !== expected.runId) {
    issues.push(`runId must match manifest.runId (${expected.runId})`);
  }
  if (normalizeText(report?.profile) !== expected.profile) {
    issues.push(`profile must match manifest.profile (${expected.profile})`);
  }

  const gateStatus = report?.gate?.status;
  if (!(gateStatus === "passed" || gateStatus === "failed" || gateStatus === "blocked")) {
    issues.push("gate.status must be one of passed|failed|blocked");
  }
  if (normalizeText(report?.gate?.reasonCode).length === 0) {
    issues.push("gate.reasonCode must be a non-empty string");
  }

  const totalFindings = report?.summary?.totalFindings;
  const highOrAbove = report?.summary?.highOrAbove;
  const candidateArtifacts = report?.summary?.candidateArtifacts;
  if (!isNonNegativeInteger(totalFindings)) {
    issues.push("summary.totalFindings must be a non-negative integer");
  }
  if (!isNonNegativeInteger(highOrAbove)) {
    issues.push("summary.highOrAbove must be a non-negative integer");
  }
  if (!isNonNegativeInteger(candidateArtifacts)) {
    issues.push("summary.candidateArtifacts must be a non-negative integer");
  }
  if (
    isNonNegativeInteger(totalFindings) &&
    Array.isArray(report?.findings) &&
    totalFindings !== report.findings.length
  ) {
    issues.push("summary.totalFindings must equal findings.length");
  }

  if (!Array.isArray(report?.findings)) {
    issues.push("findings must be an array");
  } else {
    for (const [index, finding] of report.findings.entries()) {
      const label = `findings[${index}]`;
      if (normalizeText(finding?.issue_id).length === 0) {
        issues.push(`${label}.issue_id must be non-empty`);
      }
      if (!isAiReviewSeverity(finding?.severity)) {
        issues.push(`${label}.severity must be critical|high|medium|low`);
      }
      if (!isAiReviewSeverity(finding?.risk_level)) {
        issues.push(`${label}.risk_level must be critical|high|medium|low`);
      }
      const reasonCode = normalizeText(finding?.reason_code);
      if (reasonCode.length === 0) {
        issues.push(`${label}.reason_code must be non-empty`);
      } else if (!hasAllowedAiReviewReasonCodePrefix(reasonCode)) {
        issues.push(`${label}.reason_code has invalid prefix`);
      }
      if (normalizeText(finding?.file_path).length === 0) {
        issues.push(`${label}.file_path must be non-empty`);
      }
      if (!Array.isArray(finding?.evidence)) {
        issues.push(`${label}.evidence must be an array`);
      } else if (finding.evidence.some((item) => normalizeText(item).length === 0)) {
        issues.push(`${label}.evidence must contain non-empty paths`);
      }
    }
  }
  return issues;
}

function isGeminiGateStatus(value) {
  return value === "passed" || value === "failed" || value === "blocked";
}

function validateGeminiGateReportSchema(report, expected) {
  const issues = [];
  if (normalizeText(report?.checkId) !== expected.expectedCheckId) {
    issues.push(`checkId must equal '${expected.expectedCheckId}'`);
  }
  if (!isGeminiGateStatus(report?.status)) {
    issues.push("status must be one of passed|failed|blocked");
  } else if (report.status !== expected.manifestStatus) {
    issues.push(`status must match gate check status (${expected.manifestStatus})`);
  }
  const reasonCode = normalizeText(report?.reasonCode);
  if (reasonCode.length === 0) {
    issues.push("reasonCode must be a non-empty string");
  } else if (expected.manifestReasonCode.length > 0 && reasonCode !== expected.manifestReasonCode) {
    issues.push("reasonCode must match gate check reasonCode");
  }
  return issues;
}

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, markdown, { encoding: "utf8", flag: "a" });
}

function resolveManifestPath(options) {
  if (options.runId) {
    return resolveManifestFromRunId(options.runsDir, options.runId);
  }
  const latestManifest = findLatestManifest(options.runsDir);
  if (!latestManifest) {
    throw new Error(`no manifest found under ${options.runsDir}`);
  }
  return latestManifest;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(options);
  const runDir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const profilePath = resolve("configs", "profiles", `${options.profile}.yaml`);
  const profile = YAML.parse(readFileSync(profilePath, "utf8"));
  const profileSteps = Array.isArray(profile?.steps) ? profile.steps : [];
  const checks = Array.isArray(manifest?.gateResults?.checks) ? manifest.gateResults.checks : [];
  const evidenceIndex = Array.isArray(manifest?.evidenceIndex) ? manifest.evidenceIndex : [];
  const evidenceIndexReportRef =
    normalizeText(manifest?.reports?.evidenceIndex) || "reports/evidence.index.json";
  const evidenceIndexReportPath = resolveArtifact(runDir, evidenceIndexReportRef);
  const diagnosticsIndexReportRef =
    normalizeText(manifest?.reports?.diagnosticsIndex) || "reports/diagnostics.index.json";
  const diagnosticsIndexReportPath = resolveArtifact(runDir, diagnosticsIndexReportRef);
  const failures = [];
  const manifestRunId = normalizeText(manifest?.runId);
  const manifestProfile = normalizeText(manifest?.profile);
  if (options.runId && manifestRunId !== options.runId) {
    failures.push(
      `manifest.runId mismatch: expected '${options.runId}', got '${manifestRunId || "<none>"}'`,
    );
  }
  if (manifestProfile !== options.profile) {
    failures.push(
      `manifest.profile mismatch: expected '${options.profile}', got '${manifestProfile || "<none>"}'`,
    );
  }
  const failedOrBlockedEntries = checks
    .map((check, index) => ({ check, index }))
    .filter(({ check }) => check?.status === "failed" || check?.status === "blocked");
  const evidenceIndexNormalizedPaths = new Set(
    evidenceIndex
      .map((item) => normalizeArtifactForCompare(runDir, item?.path))
      .filter((path) => path.length > 0),
  );
  const checksMissingEvidence = new Set();
  let missingEvidenceAllChecks = 0;
  let missingEvidenceFailedOrBlocked = 0;
  let missingIndexFailedOrBlocked = 0;
  let missingReasonCodeFailedOrBlocked = 0;
  let evidenceIndexFileFailures = 0;
  let missingIndexedArtifactFiles = 0;
  let diagnosticsIndexFailures = 0;

  if (!existsFile(evidenceIndexReportPath)) {
    evidenceIndexFileFailures += 1;
    failures.push(`run evidence index file is missing: ${evidenceIndexReportRef || "<none>"}`);
  } else {
    try {
      const parsedEvidenceIndex = JSON.parse(readFileSync(evidenceIndexReportPath, "utf8"));
      const fileRunId = normalizeText(parsedEvidenceIndex?.runId);
      const fileItems = Array.isArray(parsedEvidenceIndex?.items) ? parsedEvidenceIndex.items : [];
      const filePaths = new Set(
        fileItems
          .map((item) => normalizeArtifactForCompare(runDir, item?.path))
          .filter((path) => path.length > 0),
      );
      if (fileRunId !== manifestRunId) {
        evidenceIndexFileFailures += 1;
        failures.push(
          `run evidence index runId mismatch: expected ${manifestRunId}, got ${fileRunId || "<none>"}`,
        );
      }
      if (fileItems.length !== evidenceIndex.length) {
        evidenceIndexFileFailures += 1;
        failures.push(
          `run evidence index item count mismatch: manifest=${evidenceIndex.length}, file=${fileItems.length}`,
        );
      }
      for (const item of evidenceIndex) {
        const normalizedPath = normalizeArtifactForCompare(runDir, item?.path);
        if (normalizedPath.length > 0 && !filePaths.has(normalizedPath)) {
          evidenceIndexFileFailures += 1;
          failures.push(`run evidence index file missing manifest evidence path: ${item?.path}`);
        }
      }
    } catch {
      evidenceIndexFileFailures += 1;
      failures.push(`run evidence index is not valid JSON: ${evidenceIndexReportRef}`);
    }
  }

  for (const item of evidenceIndex) {
    const evidenceRef = item?.path;
    const evidencePath = resolveArtifact(runDir, evidenceRef);
    if (!existsFile(evidencePath)) {
      missingIndexedArtifactFiles += 1;
      failures.push(
        `manifest.evidenceIndex references a missing artifact file: ${evidenceRef ?? "<none>"}`,
      );
    }
  }

  if (!existsFile(diagnosticsIndexReportPath)) {
    diagnosticsIndexFailures += 1;
    failures.push(`run diagnostics index file is missing: ${diagnosticsIndexReportRef || "<none>"}`);
  } else {
    try {
      const parsedDiagnosticsIndex = JSON.parse(readFileSync(diagnosticsIndexReportPath, "utf8"));
      const fileRunId = normalizeText(parsedDiagnosticsIndex?.runId);
      const fileProfile = normalizeText(parsedDiagnosticsIndex?.profile);
      if (fileRunId !== manifestRunId) {
        diagnosticsIndexFailures += 1;
        failures.push(
          `run diagnostics index runId mismatch: expected ${manifestRunId}, got ${fileRunId || "<none>"}`,
        );
      }
      if (fileProfile !== manifestProfile) {
        diagnosticsIndexFailures += 1;
        failures.push(
          `run diagnostics index profile mismatch: expected ${manifestProfile}, got ${fileProfile || "<none>"}`,
        );
      }
      const reportEntries = Object.entries(parsedDiagnosticsIndex?.reports ?? {});
      for (const [label, reportRef] of reportEntries) {
        const reportPath = resolveArtifact(runDir, reportRef);
        if (!existsFile(reportPath)) {
          diagnosticsIndexFailures += 1;
          failures.push(
            `run diagnostics index references a missing report file (${label}): ${reportRef ?? "<none>"}`,
          );
        }
      }
    } catch {
      diagnosticsIndexFailures += 1;
      failures.push(`run diagnostics index is not valid JSON: ${diagnosticsIndexReportRef}`);
    }
  }

  for (const [index, check] of checks.entries()) {
    const evidencePath = resolveArtifact(runDir, check?.evidencePath);
    if (!existsFile(evidencePath)) {
      const checkId = check?.id ?? "unknown";
      const checkStatus = check?.status ?? "unknown";
      const reasonCode = normalizeText(check?.reasonCode);
      missingEvidenceAllChecks += 1;
      checksMissingEvidence.add(index);
      if (checkStatus === "failed" || checkStatus === "blocked") {
        failures.push(
          `failed/blocked check '${checkId}' missing valid evidence (status=${checkStatus}, reasonCode=${reasonCode || "<none>"}): ${check?.evidencePath ?? "<none>"}`,
        );
      } else {
        failures.push(
          `missing evidence for check '${checkId}': ${check?.evidencePath ?? "<none>"}`,
        );
      }
    }
  }

  for (const { check, index } of failedOrBlockedEntries) {
    const checkId = check?.id ?? "unknown";
    const checkStatus = check?.status ?? "unknown";
    const reasonCode = normalizeText(check?.reasonCode);
    const evidenceRef = normalizeArtifactForCompare(runDir, check?.evidencePath);

    if (checksMissingEvidence.has(index)) {
      missingEvidenceFailedOrBlocked += 1;
    }

    const indexed = evidenceRef.length > 0 && evidenceIndexNormalizedPaths.has(evidenceRef);
    if (!indexed) {
      missingIndexFailedOrBlocked += 1;
      failures.push(
        `failed/blocked check '${checkId}' evidencePath not indexed in manifest.evidenceIndex[].path (status=${checkStatus}, reasonCode=${reasonCode || "<none>"}): ${check?.evidencePath ?? "<none>"}`,
      );
    }

    if (!reasonCode) {
      missingReasonCodeFailedOrBlocked += 1;
      failures.push(`failed/blocked check '${checkId}' missing reasonCode (status=${checkStatus})`);
    }
  }

  const stepToCheck = new Map([
    ["unit", "test.unit"],
    ["contract", "test.contract"],
    ["ct", "test.ct"],
    ["e2e", "test.e2e"],
  ]);
  for (const [step, checkId] of stepToCheck.entries()) {
    if (!profileSteps.includes(step)) {
      continue;
    }
    const matched = checks.find((item) => item.id === checkId);
    if (!matched) {
      failures.push(`missing required test check '${checkId}' for profile step '${step}'`);
      continue;
    }
    if (matched.status !== "passed") {
      failures.push(`required test check '${checkId}' not passed (status=${matched.status})`);
    }
  }

  if (profileSteps.includes("capture")) {
    const states = Array.isArray(manifest?.states) ? manifest.states : [];
    if (states.length === 0) {
      failures.push("capture step requested but manifest.states is empty");
    }
    const screenshotEvidence = states
      .map((state) => resolveArtifact(runDir, state?.artifacts?.screenshot))
      .filter((path) => existsFile(path));
    if (screenshotEvidence.length === 0) {
      failures.push("capture step requested but no screenshot artifact exists");
    }
  }

  if (profileSteps.includes("desktop_business_regression")) {
    const desktopBusinessPath = manifest?.reports?.desktopBusiness;
    const resolvedDesktopBusiness = resolveArtifact(runDir, desktopBusinessPath);
    if (!existsFile(resolvedDesktopBusiness)) {
      failures.push("desktop_business_regression requested but reports.desktopBusiness is missing");
    }
    const desktopBusinessGate = checks.find((item) => item.id === "desktop.business_regression");
    if (!desktopBusinessGate) {
      failures.push(
        "desktop_business_regression requested but gate check 'desktop.business_regression' is missing",
      );
    }
  }

  const aiReviewEnabledByProfile = profile?.aiReview?.enabled === true;
  const aiReviewEnabledByManifest = manifest?.diagnostics?.aiReview?.enabled === true;
  const aiReviewEnabled = aiReviewEnabledByProfile || aiReviewEnabledByManifest;
  let aiReviewMissingReport = 0;
  let aiReviewSchemaFailures = 0;
  let geminiGateSchemaFailures = 0;
  let geminiGateMissingReport = 0;

  if (aiReviewEnabled) {
    const reportRef = normalizeText(manifest?.reports?.aiReview);
    const diagnosticsReportRef = normalizeText(manifest?.diagnostics?.aiReview?.reportPath);

    if (!reportRef) {
      aiReviewMissingReport += 1;
      failures.push("aiReview enabled but manifest.reports.aiReview is missing");
    }
    if (!diagnosticsReportRef) {
      aiReviewMissingReport += 1;
      failures.push("aiReview enabled but manifest.diagnostics.aiReview.reportPath is missing");
    }
    if (reportRef && diagnosticsReportRef && reportRef !== diagnosticsReportRef) {
      aiReviewSchemaFailures += 1;
      failures.push(
        `aiReview report path mismatch between reports.aiReview ('${reportRef}') and diagnostics.aiReview.reportPath ('${diagnosticsReportRef}')`,
      );
    }

    const reportPath = resolveArtifact(runDir, reportRef || diagnosticsReportRef);
    if (!existsFile(reportPath)) {
      aiReviewMissingReport += 1;
      failures.push(
        `aiReview enabled but report file is missing: ${reportRef || diagnosticsReportRef || "<none>"}`,
      );
    } else {
      let parsedReport;
      try {
        parsedReport = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        aiReviewSchemaFailures += 1;
        failures.push(`aiReview report is not valid JSON: ${reportRef || diagnosticsReportRef}`);
      }
      if (parsedReport) {
        const schemaIssues = validateAiReviewReportSchema(parsedReport, {
          runId: manifestRunId,
          profile: manifestProfile,
        });
        if (schemaIssues.length > 0) {
          aiReviewSchemaFailures += 1;
          failures.push(
            `aiReview report schema invalid (${reportRef || diagnosticsReportRef}): ${schemaIssues.join("; ")}`,
          );
        }
      }
    }
  }

  const geminiGateReportCheckIds = new Map([
    ["ai_review.gemini_accuracy", "gemini_accuracy_min"],
    ["ai_review.gemini_concurrency", "gemini_parallel_consistency_min"],
  ]);
  for (const [index, check] of checks.entries()) {
    const expectedCheckId = geminiGateReportCheckIds.get(check?.id);
    if (!expectedCheckId) {
      continue;
    }
    const evidencePath = resolveArtifact(runDir, check?.evidencePath);
    if (!existsFile(evidencePath)) {
      if (!checksMissingEvidence.has(index)) {
        geminiGateMissingReport += 1;
        failures.push(
          `gemini gate check '${check?.id ?? "unknown"}' missing report artifact: ${check?.evidencePath ?? "<none>"}`,
        );
      }
      continue;
    }
    let parsedReport;
    try {
      parsedReport = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch {
      geminiGateSchemaFailures += 1;
      failures.push(
        `gemini gate report is not valid JSON (${check?.id ?? "unknown"}): ${check?.evidencePath ?? "<none>"}`,
      );
      continue;
    }
    const schemaIssues = validateGeminiGateReportSchema(parsedReport, {
      expectedCheckId,
      manifestStatus: check?.status,
      manifestReasonCode: normalizeText(check?.reasonCode),
    });
    if (schemaIssues.length > 0) {
      geminiGateSchemaFailures += 1;
      failures.push(
        `gemini gate report schema invalid (${check?.id ?? "unknown"}): ${schemaIssues.join("; ")}`,
      );
    }
  }

  const lines = [];
  lines.push("### Run Evidence Verification");
  lines.push(`- Profile: \`${options.profile}\``);
  if (options.runId) {
    lines.push(`- Requested runId: \`${options.runId}\``);
  }
  lines.push(`- Manifest runId: \`${manifestRunId || "<none>"}\``);
  lines.push(`- Manifest: \`${manifestPath}\``);
  lines.push(`- Evidence index report: \`${evidenceIndexReportRef}\``);
  lines.push(`- Total checks: ${checks.length}`);
  lines.push(`- Failed/blocked checks: ${failedOrBlockedEntries.length}`);
  lines.push(`- Missing evidence: ${missingEvidenceFailedOrBlocked}`);
  lines.push(`- Missing index: ${missingIndexFailedOrBlocked}`);
  lines.push(`- Missing reasonCode: ${missingReasonCodeFailedOrBlocked}`);
  lines.push(`- Evidence index file failures: ${evidenceIndexFileFailures}`);
  lines.push(`- Missing indexed artifact files: ${missingIndexedArtifactFiles}`);
  lines.push(`- Diagnostics index failures: ${diagnosticsIndexFailures}`);
  lines.push(`- Missing evidence (all checks, legacy rule): ${missingEvidenceAllChecks}`);
  lines.push(`- AI review enabled: ${aiReviewEnabled ? "true" : "false"}`);
  lines.push(`- AI review missing report: ${aiReviewMissingReport}`);
  lines.push(`- AI review schema failures: ${aiReviewSchemaFailures}`);
  lines.push(`- Gemini gate missing report: ${geminiGateMissingReport}`);
  lines.push(`- Gemini gate schema failures: ${geminiGateSchemaFailures}`);
  lines.push(`- Result: ${failures.length === 0 ? "pass" : "fail"}`);
  if (failures.length > 0) {
    lines.push("- Failures:");
    for (const failure of failures) {
      lines.push(`  - ${failure}`);
    }
  }
  console.log(lines.join("\n"));
  appendStepSummary(`${lines.join("\n")}\n`);

  if (failures.length > 0) {
    console.error(`[verify-run-evidence] failed (${failures.length} issue(s))`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(2);
  }

  console.log("[verify-run-evidence] passed");
}

main();
