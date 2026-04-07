#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseBoolean(value, flag) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`invalid ${flag}, expected true|false`);
}

function normalizeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!runId) {
    return "";
  }
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error("invalid --run-id, expected pattern [A-Za-z0-9._-]+");
  }
  return runId;
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

function parseArgs(argv) {
  const options = {
    profile: "pr",
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    runId: "",
    manifestPath: "",
    maxArtifacts: 40,
    severityThreshold: "high",
    emitIssue: false,
    emitPrComment: false,
    strict: false,
    repo: "",
    prNumber: 0,
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
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--run-id" && next) {
      options.runId = next;
    }
    if (token === "--manifest" && next) {
      options.manifestPath = next;
    }
    if (token === "--max-artifacts" && next) {
      options.maxArtifacts = Number(next);
    }
    if (token === "--severity-threshold" && next) {
      options.severityThreshold = next;
    }
    if (token === "--emit-issue" && next) {
      options.emitIssue = parseBoolean(next, "--emit-issue");
    }
    if (token === "--emit-pr-comment" && next) {
      options.emitPrComment = parseBoolean(next, "--emit-pr-comment");
    }
    if (token === "--strict" && next) {
      options.strict = parseBoolean(next, "--strict");
    }
    if (token === "--repo" && next) {
      options.repo = String(next).trim();
    }
    if (token === "--pr-number" && next) {
      options.prNumber = Number(next);
    }
  }

  if (
    !Number.isInteger(options.maxArtifacts) ||
    options.maxArtifacts < 1 ||
    options.maxArtifacts > 500
  ) {
    throw new Error("invalid --max-artifacts, expected integer in [1, 500]");
  }
  if (!["critical", "high", "medium", "low"].includes(String(options.severityThreshold))) {
    throw new Error("invalid --severity-threshold, expected critical|high|medium|low");
  }
  if (!Number.isInteger(options.prNumber) || options.prNumber < 0) {
    throw new Error("invalid --pr-number, expected non-negative integer");
  }
  options.runId = normalizeRunId(options.runId);
  return options;
}

function findLatestManifest(runsDir) {
  const root = resolve(runsDir);
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = resolve(root, entry.name, "manifest.json");
    try {
      candidates.push({ manifestPath, mtimeMs: statSync(manifestPath).mtimeMs });
    } catch {
      // ignore
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.manifestPath;
}

function resolveManifestPath(options) {
  if (options.manifestPath) {
    return resolve(options.manifestPath);
  }
  if (options.runId) {
    return resolveManifestFromRunId(options.runsDir, options.runId);
  }
  const latest = findLatestManifest(options.runsDir);
  if (!latest) {
    throw new Error(`no manifest found under ${options.runsDir}`);
  }
  return latest;
}

function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, markdown, { encoding: "utf8", flag: "a" });
}

function runFailureTicketingIfNeeded(options) {
  if (!options.emitIssue && !options.emitPrComment) {
    return;
  }
  const args = [
    "scripts/ci/uiq-failure-ticketing.mjs",
    "--runs-dir",
    options.runsDir,
    "--out-dir",
    options.outDir,
    "--emit-gh-issues",
    String(options.emitIssue),
    "--emit-pr-comment",
    String(options.emitPrComment),
  ];
  if (options.repo) {
    args.push("--repo", options.repo);
  }
  if (options.prNumber > 0) {
    args.push("--pr-number", String(options.prNumber));
  }
  const child = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (child.status !== 0) {
    throw new Error(`uiq-failure-ticketing failed with exit code ${child.status ?? 1}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(options);
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runId = String(manifest.runId || options.runId || "unknown-run");

  const { buildAiReviewInput } = await import("../../packages/ai-review/src/build-input.ts");
  const { generateAiReviewReport, writeAiReviewReportArtifacts, renderAiReviewMarkdown } =
    await import("../../packages/ai-review/src/generate-findings.ts");

  const input = buildAiReviewInput(manifest, { maxArtifacts: options.maxArtifacts });
  const report = generateAiReviewReport(input, {
    severityThreshold: options.severityThreshold,
  });

  mkdirSync(resolve(options.outDir), { recursive: true });
  const jsonFile = `uiq-ai-review-${options.profile}.json`;
  const mdFile = `uiq-ai-review-${options.profile}.md`;
  const artifacts = writeAiReviewReportArtifacts(options.outDir, report, jsonFile, mdFile);

  const summaryLines = [
    "## UIQ AI Review Gate",
    `- Profile: \`${options.profile}\``,
    `- Run ID: \`${runId}\``,
    `- Manifest: \`${manifestPath}\``,
    `- Gate: **${report.gate.status}**`,
    `- reasonCode: \`${report.gate.reasonCode}\``,
    `- Findings: **${report.summary.totalFindings}**`,
    `- HighOrAbove: **${report.summary.highOrAbove}**`,
    `- Candidate Artifacts: **${report.summary.candidateArtifacts}**`,
    `- Report JSON: \`${resolve(options.outDir, artifacts.jsonPath)}\``,
    `- Report MD: \`${resolve(options.outDir, artifacts.markdownPath)}\``,
    "",
    renderAiReviewMarkdown(report),
  ];
  writeStepSummary(`${summaryLines.join("\n")}\n`);

  runFailureTicketingIfNeeded(options);

  if (options.strict && report.gate.status !== "passed") {
    process.exit(2);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
