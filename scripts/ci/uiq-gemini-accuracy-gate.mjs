#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const CHECK_ID = "gemini_accuracy_min";
const DEFAULT_REPORT_REL_PATH =
  process.env.UIQ_GEMINI_REPORT_REL_PATH || "reports/ui-ux-gemini-report.json";
const DEFAULT_DIFF_AUDIT_REPORT = ".runtime-cache/artifacts/uiux/gemini-uiux-diff-audit.json";

function parseBoolean(raw, key) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`invalid ${key}, expected true|false`);
}

function parseArgs(argv) {
  const options = {
    profile: "pr",
    strict: false,
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    artifact: "",
    accuracyMin: undefined,
    sampleSizeMin: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--profile" && next) {
      options.profile = next;
    }
    if (token === "--strict" && next) {
      options.strict = parseBoolean(next, "--strict");
    }
    if (token === "--runs-dir" && next) {
      options.runsDir = next;
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--artifact" && next) {
      options.artifact = next;
    }
    if (token === "--accuracy-min" && next) {
      options.accuracyMin = Number(next);
    }
    if (token === "--sample-size-min" && next) {
      options.sampleSizeMin = Number(next);
    }
  }
  if (
    options.accuracyMin !== undefined &&
    (!Number.isFinite(options.accuracyMin) || options.accuracyMin < 0 || options.accuracyMin > 1)
  ) {
    throw new Error("invalid --accuracy-min, expected number in [0,1]");
  }
  if (
    options.sampleSizeMin !== undefined &&
    (!Number.isInteger(options.sampleSizeMin) || options.sampleSizeMin < 1)
  ) {
    throw new Error("invalid --sample-size-min, expected integer >= 1");
  }
  return options;
}

function readProfileThresholds(profileName) {
  const profilePath = resolve("profiles", `${profileName}.yaml`);
  try {
    const profile = YAML.parse(readFileSync(profilePath, "utf8"));
    return {
      accuracyMin: Number.isFinite(Number(profile?.geminiAccuracyMin))
        ? Number(profile.geminiAccuracyMin)
        : undefined,
      sampleSizeMin: Number.isInteger(Number(profile?.geminiSampleSizeMin))
        ? Number(profile.geminiSampleSizeMin)
        : undefined,
      aiReviewEnabled: profile?.aiReview?.enabled === true,
      profilePath,
      profileReadError: "",
    };
  } catch (error) {
    return {
      accuracyMin: undefined,
      sampleSizeMin: undefined,
      aiReviewEnabled: undefined,
      profilePath,
      profileReadError: error instanceof Error ? error.message : String(error),
    };
  }
}

function findLatestRunDir(runsDir) {
  const absRunsDir = resolve(runsDir);
  if (!existsSync(absRunsDir)) {
    return "";
  }
  const candidates = [];
  for (const entry of readdirSync(absRunsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = resolve(absRunsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    candidates.push({ runId: entry.name, mtimeMs: statSync(manifestPath).mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.runId || "";
}

function resolveArtifactPath(options) {
  if (options.artifact) {
    return { artifactPath: resolve(options.artifact), runId: "manual", source: "manual" };
  }
  const runId = findLatestRunDir(options.runsDir);
  const runArtifactPath = runId ? resolve(options.runsDir, runId, DEFAULT_REPORT_REL_PATH) : "";
  if (runArtifactPath && existsSync(runArtifactPath)) {
    return {
      artifactPath: runArtifactPath,
      runId,
      source: "run-report",
    };
  }
  const fallbackArtifactPath = resolve(DEFAULT_DIFF_AUDIT_REPORT);
  if (existsSync(fallbackArtifactPath)) {
    return {
      artifactPath: fallbackArtifactPath,
      runId: runId || "",
      source: "uiux-diff-audit",
    };
  }
  return {
    artifactPath: runArtifactPath || fallbackArtifactPath,
    runId: runId || "",
    source: runArtifactPath ? "run-report" : "uiux-diff-audit",
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readRunManifest(runsDir, runId) {
  if (!runId || runId === "manual") {
    return null;
  }
  const manifestPath = resolve(runsDir, runId, "manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    return readJson(manifestPath);
  } catch {
    return null;
  }
}

function resolveUpstreamGeminiFailure(manifest) {
  const checks = Array.isArray(manifest?.gateResults?.checks) ? manifest.gateResults.checks : [];
  for (const check of checks) {
    const reasonCode = typeof check?.reasonCode === "string" ? check.reasonCode.trim() : "";
    const actual = typeof check?.actual === "string" ? check.actual : "";
    const mentionsGemini =
      reasonCode.startsWith("ai.gemini.") ||
      actual.includes("Gemini multimodal UI/UX report generation failed") ||
      actual.includes("API_KEY_SERVICE_BLOCKED");
    if (!mentionsGemini) {
      continue;
    }
    return {
      reasonCode: reasonCode || buildReasonCode("failed", "artifact_generation_failed"),
      actual: actual || null,
    };
  }
  return null;
}

function normalizeRatio(raw) {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  if (numeric >= 0 && numeric <= 1) {
    return Number(numeric.toFixed(6));
  }
  if (numeric > 1 && numeric <= 100) {
    return Number((numeric / 100).toFixed(6));
  }
  return undefined;
}

function pickNumber(payload, probes) {
  for (const path of probes) {
    const segments = path.split(".");
    let cursor = payload;
    let ok = true;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== "object" || !(segment in cursor)) {
        ok = false;
        break;
      }
      cursor = cursor[segment];
    }
    if (!ok) {
      continue;
    }
    const numeric = Number(cursor);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function buildReasonCode(status, reason) {
  return `gate.${CHECK_ID}.${status}.${reason}`;
}

function evaluateGate({ accuracy, sampleSize, accuracyMin, sampleSizeMin }) {
  if (accuracyMin === undefined || sampleSizeMin === undefined) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "missing_threshold") };
  }
  if (accuracy === undefined) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "missing_accuracy_metric") };
  }
  if (sampleSize === undefined) {
    return {
      status: "failed",
      reasonCode: buildReasonCode("failed", "missing_sample_size_metric"),
    };
  }
  if (sampleSize < sampleSizeMin) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "sample_size_too_small") };
  }
  if (accuracy < accuracyMin) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "threshold_not_met") };
  }
  return { status: "passed", reasonCode: buildReasonCode("passed", "threshold_met") };
}

function resolveMetrics(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      rawAccuracy: undefined,
      accuracy: undefined,
      sampleSize: undefined,
      metricSource: "none",
    };
  }
  const rawAccuracy = pickNumber(payload, [
    "summary.accuracy",
    "accuracy",
    "metrics.accuracy",
    "summary.overall_score",
    "overall_score",
  ]);
  const sampleSize = pickNumber(payload, [
    "summary.sample_size",
    "summary.sampleSize",
    "summary.total_samples",
    "summary.totalSamples",
    "sample_size",
    "sampleSize",
    "metrics.sampleSize",
    "metrics.sample_size",
  ]);
  const normalizedAccuracy = normalizeRatio(rawAccuracy);
  if (normalizedAccuracy !== undefined && sampleSize !== undefined) {
    return {
      rawAccuracy,
      accuracy: normalizedAccuracy,
      sampleSize,
      metricSource: "structured",
    };
  }

  const diffAuditPassed =
    payload?.passed === true ||
    payload?.result?.passed === true ||
    payload?.result?.passed === false ||
    payload?.passed === false;
  if (diffAuditPassed) {
    const passed = payload?.passed === true || payload?.result?.passed === true;
    const inferredSampleSize =
      (Array.isArray(payload?.targets) && payload.targets.length) ||
      (Array.isArray(payload?.result?.issues) && payload.result.issues.length) ||
      1;
    return {
      rawAccuracy: passed ? 1 : 0,
      accuracy: passed ? 1 : 0,
      sampleSize: inferredSampleSize,
      metricSource: "uiux-diff-fallback",
    };
  }
  return {
    rawAccuracy,
    accuracy: normalizedAccuracy,
    sampleSize,
    metricSource: "partial",
  };
}

function writeArtifacts({ outDir, profile, report }) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, `uiq-gemini-accuracy-gate-${profile}.json`);
  const mdPath = resolve(outDir, `uiq-gemini-accuracy-gate-${profile}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = [
    "# Gemini Accuracy Gate",
    "",
    `- profile: ${profile}`,
    `- status: ${report.status}`,
    `- reasonCode: ${report.reasonCode}`,
    `- accuracy: ${report.metrics.accuracy ?? "n/a"}`,
    `- accuracyMin: ${report.thresholds.accuracyMin ?? "n/a"}`,
    `- sampleSize: ${report.metrics.sampleSize ?? "n/a"}`,
    `- sampleSizeMin: ${report.thresholds.sampleSizeMin ?? "n/a"}`,
    `- artifactPath: ${report.artifact.path || "n/a"}`,
  ].join("\n");
  writeFileSync(mdPath, `${markdown}\n`, "utf8");
  return { jsonPath, mdPath };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const profileThresholds = readProfileThresholds(options.profile);
  const thresholds = {
    accuracyMin: options.accuracyMin ?? profileThresholds.accuracyMin,
    sampleSizeMin: options.sampleSizeMin ?? profileThresholds.sampleSizeMin,
  };
  const aiReviewEnabled = profileThresholds.aiReviewEnabled === true;
  const requiresStructuredMetrics = aiReviewEnabled || options.profile === "pr";
  const { artifactPath, runId, source: artifactSource } = resolveArtifactPath(options);
  const artifactExists = Boolean(artifactPath) && existsSync(artifactPath);
  const upstreamManifest = readRunManifest(options.runsDir, runId);
  const upstreamFailure = resolveUpstreamGeminiFailure(upstreamManifest);

  let payload;
  let artifactReadError = "";
  if (artifactExists) {
    try {
      payload = readJson(artifactPath);
    } catch (error) {
      artifactReadError = error instanceof Error ? error.message : String(error);
    }
  }

  const metrics = resolveMetrics(payload);
  const thoughtSignatureStatus =
    payload?.thought_signatures && typeof payload.thought_signatures.status === "string"
      ? payload.thought_signatures.status
      : null;
  const thoughtSignatureReasonCode =
    payload?.thought_signatures && typeof payload.thought_signatures.reason_code === "string"
      ? payload.thought_signatures.reason_code
      : null;
  const thoughtSignatureCount = payload
    ? pickNumber(payload, ["thought_signatures.signature_count"])
    : undefined;

  const result = !artifactExists
    ? {
        status: "failed",
        reasonCode: upstreamFailure?.reasonCode ?? buildReasonCode("failed", "artifact_missing"),
      }
    : artifactReadError
      ? { status: "failed", reasonCode: buildReasonCode("failed", "artifact_parse_error") }
      : requiresStructuredMetrics && metrics.metricSource !== "structured"
        ? { status: "failed", reasonCode: buildReasonCode("failed", "structured_report_required") }
        : evaluateGate({
            accuracy: metrics.accuracy,
            sampleSize: metrics.sampleSize,
            accuracyMin: thresholds.accuracyMin,
            sampleSizeMin: thresholds.sampleSizeMin,
          });

  const report = {
    checkId: CHECK_ID,
    profile: options.profile,
    runId: runId || null,
    status: result.status,
    reasonCode: result.reasonCode,
    strict: options.strict,
    aiReviewEnabled,
    requiresStructuredMetrics,
    thresholds,
    metrics: {
      rawAccuracy: metrics.rawAccuracy ?? null,
      accuracy: metrics.accuracy ?? null,
      sampleSize: metrics.sampleSize ?? null,
      metricSource: metrics.metricSource,
      thoughtSignatureStatus,
      thoughtSignatureReasonCode,
      thoughtSignatureCount: thoughtSignatureCount ?? null,
    },
    artifact: {
      path: artifactPath || null,
      source: artifactSource,
      exists: artifactExists,
      readError: artifactReadError || null,
    },
    upstreamFailure: upstreamFailure
      ? {
          reasonCode: upstreamFailure.reasonCode,
          actual: upstreamFailure.actual,
        }
      : null,
    thresholdSource: {
      accuracyMin: options.accuracyMin !== undefined ? "cli" : "profile",
      sampleSizeMin: options.sampleSizeMin !== undefined ? "cli" : "profile",
      aiReviewEnabled: "profile",
      profilePath: profileThresholds.profilePath,
      profileReadError: profileThresholds.profileReadError || null,
    },
    timestamp: new Date().toISOString(),
  };

  const { jsonPath, mdPath } = writeArtifacts({
    outDir: options.outDir,
    profile: options.profile,
    report,
  });

  if ((options.strict || options.profile === "pr") && report.status !== "passed") {
    process.exitCode = 1;
  }
}

main();
