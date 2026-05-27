#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const CHECK_ID = "gemini_parallel_consistency_min";
const DEFAULT_REPORT_REL_PATH =
  process.env.UIQ_GEMINI_REPORT_REL_PATH || "reports/ui-ux-gemini-report.json";

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
    parallelConsistencyMin: undefined,
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
    if (token === "--parallel-consistency-min" && next) {
      options.parallelConsistencyMin = Number(next);
    }
    if (token === "--sample-size-min" && next) {
      options.sampleSizeMin = Number(next);
    }
  }
  if (
    options.parallelConsistencyMin !== undefined &&
    (!Number.isFinite(options.parallelConsistencyMin) ||
      options.parallelConsistencyMin < 0 ||
      options.parallelConsistencyMin > 1)
  ) {
    throw new Error("invalid --parallel-consistency-min, expected number in [0,1]");
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
      parallelConsistencyMin: Number.isFinite(Number(profile?.geminiParallelConsistencyMin))
        ? Number(profile.geminiParallelConsistencyMin)
        : undefined,
      sampleSizeMin: Number.isInteger(Number(profile?.geminiSampleSizeMin))
        ? Number(profile.geminiSampleSizeMin)
        : undefined,
      profilePath,
      profileReadError: "",
    };
  } catch (error) {
    return {
      parallelConsistencyMin: undefined,
      sampleSizeMin: undefined,
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
    return { artifactPath: resolve(options.artifact), runId: "manual" };
  }
  const runId = findLatestRunDir(options.runsDir);
  if (!runId) {
    return { artifactPath: "", runId: "" };
  }
  return {
    artifactPath: resolve(options.runsDir, runId, DEFAULT_REPORT_REL_PATH),
    runId,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
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

function evaluateGate({ parallelConsistency, sampleSize, parallelConsistencyMin, sampleSizeMin }) {
  if (parallelConsistencyMin === undefined || sampleSizeMin === undefined) {
    return { status: "blocked", reasonCode: buildReasonCode("blocked", "missing_threshold") };
  }
  if (parallelConsistency === undefined) {
    return {
      status: "blocked",
      reasonCode: buildReasonCode("blocked", "missing_parallel_consistency_metric"),
    };
  }
  if (sampleSize === undefined) {
    return {
      status: "blocked",
      reasonCode: buildReasonCode("blocked", "missing_sample_size_metric"),
    };
  }
  if (sampleSize < sampleSizeMin) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "sample_size_too_small") };
  }
  if (parallelConsistency < parallelConsistencyMin) {
    return { status: "failed", reasonCode: buildReasonCode("failed", "threshold_not_met") };
  }
  return { status: "passed", reasonCode: buildReasonCode("passed", "threshold_met") };
}

function writeArtifacts({ outDir, profile, report }) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, `uiq-gemini-concurrency-gate-${profile}.json`);
  const mdPath = resolve(outDir, `uiq-gemini-concurrency-gate-${profile}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = [
    "# Gemini Concurrency Gate",
    "",
    `- profile: ${profile}`,
    `- status: ${report.status}`,
    `- reasonCode: ${report.reasonCode}`,
    `- parallelConsistency: ${report.metrics.parallelConsistency ?? "n/a"}`,
    `- parallelConsistencyMin: ${report.thresholds.parallelConsistencyMin ?? "n/a"}`,
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
    parallelConsistencyMin:
      options.parallelConsistencyMin ?? profileThresholds.parallelConsistencyMin,
    sampleSizeMin: options.sampleSizeMin ?? profileThresholds.sampleSizeMin,
  };
  const { artifactPath, runId } = resolveArtifactPath(options);

  let payload;
  let artifactReadError = "";
  if (artifactPath && existsSync(artifactPath)) {
    try {
      payload = readJson(artifactPath);
    } catch (error) {
      artifactReadError = error instanceof Error ? error.message : String(error);
    }
  }

  const rawParallelConsistency = payload
    ? pickNumber(payload, [
        "summary.parallel_consistency",
        "summary.parallelConsistency",
        "parallel_consistency",
        "parallelConsistency",
        "metrics.parallel_consistency",
        "metrics.parallelConsistency",
      ])
    : undefined;
  const parallelConsistency = normalizeRatio(rawParallelConsistency);
  const sampleSize = payload
    ? pickNumber(payload, [
        "summary.sample_size",
        "summary.sampleSize",
        "summary.total_samples",
        "summary.totalSamples",
        "sample_size",
        "sampleSize",
        "metrics.sampleSize",
        "metrics.sample_size",
      ])
    : undefined;
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

  const result =
    artifactPath && !existsSync(artifactPath)
      ? { status: "blocked", reasonCode: buildReasonCode("blocked", "artifact_missing") }
      : artifactReadError
        ? { status: "blocked", reasonCode: buildReasonCode("blocked", "artifact_parse_error") }
        : evaluateGate({
            parallelConsistency,
            sampleSize,
            parallelConsistencyMin: thresholds.parallelConsistencyMin,
            sampleSizeMin: thresholds.sampleSizeMin,
          });

  const report = {
    checkId: CHECK_ID,
    profile: options.profile,
    runId: runId || null,
    status: result.status,
    reasonCode: result.reasonCode,
    strict: options.strict,
    thresholds,
    metrics: {
      rawParallelConsistency: rawParallelConsistency ?? null,
      parallelConsistency: parallelConsistency ?? null,
      sampleSize: sampleSize ?? null,
      thoughtSignatureStatus,
      thoughtSignatureReasonCode,
      thoughtSignatureCount: thoughtSignatureCount ?? null,
    },
    artifact: {
      path: artifactPath || null,
      readError: artifactReadError || null,
    },
    thresholdSource: {
      parallelConsistencyMin: options.parallelConsistencyMin !== undefined ? "cli" : "profile",
      sampleSizeMin: options.sampleSizeMin !== undefined ? "cli" : "profile",
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

  if (options.strict && report.status !== "passed") {
    process.exitCode = 1;
  }
}

main();
