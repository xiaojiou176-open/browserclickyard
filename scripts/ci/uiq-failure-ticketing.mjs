#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const PR_COMMENT_MARKER = "<!-- uiq-failure-ticketing:top-clusters -->";
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseBooleanFlag(value, flagName) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`invalid ${flagName}, expected true|false`);
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
    runsDir: ".runtime-cache/artifacts/runs",
    outDir: ".runtime-cache/artifacts/ci",
    runId: "",
    manifestPath: "",
    summaryPath: "",
    outPrefix: "uiq-failure-ticketing",
    topN: 10,
    sampleLimit: 3,
    emitGhIssues: false,
    emitPrComment: false,
    repo: "",
    prNumber: 0,
    strictGh: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
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
    if (token === "--summary" && next) {
      options.summaryPath = next;
    }
    if (token === "--out-prefix" && next) {
      options.outPrefix = next;
    }
    if (token === "--top-n" && next) {
      options.topN = Number(next);
    }
    if (token === "--sample-limit" && next) {
      options.sampleLimit = Number(next);
    }
    if (token === "--emit-gh-issues" && next) {
      options.emitGhIssues = parseBooleanFlag(next, "--emit-gh-issues");
    }
    if (token === "--emit-pr-comment" && next) {
      options.emitPrComment = parseBooleanFlag(next, "--emit-pr-comment");
    }
    if (token === "--repo" && next) {
      options.repo = String(next).trim();
    }
    if (token === "--pr-number" && next) {
      options.prNumber = Number(next);
    }
    if (token === "--strict-gh" && next) {
      options.strictGh = parseBooleanFlag(next, "--strict-gh");
    }
  }
  if (!Number.isInteger(options.topN) || options.topN <= 0) {
    throw new Error("invalid --top-n, expected positive integer");
  }
  if (!Number.isInteger(options.sampleLimit) || options.sampleLimit <= 0) {
    throw new Error("invalid --sample-limit, expected positive integer");
  }
  if (!Number.isInteger(options.prNumber) || options.prNumber < 0) {
    throw new Error("invalid --pr-number, expected non-negative integer");
  }
  options.runId = normalizeRunId(options.runId);
  return options;
}

function pickLatestManifestPath(runsDir) {
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
      // ignore runs without manifest
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
  const latest = pickLatestManifestPath(options.runsDir);
  if (!latest) {
    throw new Error(`no manifest found under ${options.runsDir}`);
  }
  return latest;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tryReadJson(path) {
  if (!path || !existsSync(path)) {
    return null;
  }
  return readJson(path);
}

function normalizeStatus(status) {
  const raw = String(status || "")
    .toLowerCase()
    .trim();
  if (raw === "failed" || raw === "blocked") {
    return raw;
  }
  return "";
}

function normalizeReasonCode(checkId, status, rawReasonCode) {
  const reasonCode = String(rawReasonCode || "").trim();
  if (reasonCode) {
    return reasonCode;
  }
  const id = String(checkId || "unknown").replaceAll(".", "_");
  return `gate.${id}.${status || "blocked"}.unspecified`;
}

function normalizeKeyToken(value, fallback = "unknown") {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/\|/g, "/");
}

function normalizeIsoDate(value, fallback) {
  const parsed = new Date(String(value || ""));
  if (!Number.isFinite(parsed.getTime())) {
    return fallback;
  }
  return parsed.toISOString();
}

function pickStepIdMap(manifest) {
  const map = new Map();
  const failureLocations = Array.isArray(manifest?.diagnostics?.failureLocations)
    ? manifest.diagnostics.failureLocations
    : [];
  for (const item of failureLocations) {
    const checkId = String(item?.checkId || "").trim();
    const stepId = String(item?.stepId || "").trim();
    if (!checkId || !stepId) {
      continue;
    }
    if (!map.has(checkId)) {
      map.set(checkId, stepId);
    }
  }
  return map;
}

function collectFailedChecks(manifest, summary, observedAt) {
  const stepIdMap = pickStepIdMap(manifest);
  const fromManifest = Array.isArray(manifest?.gateResults?.checks)
    ? manifest.gateResults.checks
        .filter((check) => normalizeStatus(check?.status))
        .map((check) => normalizeFailedCheck(check, "manifest", stepIdMap, observedAt))
    : [];
  const fromSummary = Array.isArray(summary?.checks)
    ? summary.checks
        .filter((check) => normalizeStatus(check?.status))
        .map((check) => normalizeFailedCheck(check, "summary", stepIdMap, observedAt))
    : [];
  const deduped = [];
  const seen = new Set();
  for (const item of [...fromManifest, ...fromSummary]) {
    const key = [
      item.checkId,
      item.stepId,
      item.status,
      item.reasonCode,
      JSON.stringify(item.actual),
      JSON.stringify(item.expected),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return {
    checks: deduped,
    sourceStats: { manifestFailed: fromManifest.length, summaryFailed: fromSummary.length },
  };
}

function normalizeFailedCheck(check, source, stepIdMap, observedAt) {
  const checkId = String(check?.id || check?.checkId || "unknown").trim() || "unknown";
  const status = normalizeStatus(check?.status) || "blocked";
  const stepId = String(check?.stepId || "").trim() || String(stepIdMap.get(checkId) || "").trim();
  const reasonCode = normalizeReasonCode(checkId, status, check?.reasonCode);
  return {
    source,
    checkId,
    stepId,
    status,
    reasonCode,
    expected: check?.expected ?? "",
    actual: check?.actual ?? "",
    evidencePath: String(check?.evidencePath || "").trim(),
    observedAt,
  };
}

function buildFingerprintClusterInput(runContext, item) {
  const component = item.stepId ? `step:${item.stepId}` : `check:${item.checkId}`;
  const fingerprint = [
    normalizeKeyToken(item.reasonCode),
    normalizeKeyToken(component),
    normalizeKeyToken(runContext.target),
    normalizeKeyToken(runContext.profile),
  ].join("|");
  return {
    fingerprint,
    reasonCode: item.reasonCode,
    component,
    profile: runContext.profile,
    target: runContext.target,
    sample: {
      runId: runContext.runId,
      source: item.source,
      checkId: item.checkId,
      stepId: item.stepId || null,
      status: item.status,
      reasonCode: item.reasonCode,
      expected: item.expected,
      actual: item.actual,
      evidencePath: item.evidencePath || null,
      observedAt: item.observedAt,
    },
  };
}

function clusterFailures(items, sampleLimit) {
  const map = new Map();
  for (const item of items) {
    const existing = map.get(item.fingerprint);
    if (!existing) {
      map.set(item.fingerprint, {
        fingerprint: item.fingerprint,
        reasonCode: item.reasonCode,
        component: item.component,
        profile: item.profile,
        target: item.target,
        firstSeen: item.sample.observedAt,
        lastSeen: item.sample.observedAt,
        count: 1,
        samples: [item.sample],
      });
      continue;
    }
    existing.count += 1;
    existing.firstSeen =
      existing.firstSeen < item.sample.observedAt ? existing.firstSeen : item.sample.observedAt;
    existing.lastSeen =
      existing.lastSeen > item.sample.observedAt ? existing.lastSeen : item.sample.observedAt;
    if (existing.samples.length < sampleLimit) {
      existing.samples.push(item.sample);
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen),
  );
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ Failure Ticketing Clusters");
  lines.push(`- Run ID: \`${report.source.runId}\``);
  lines.push(`- Gate Status: **${report.source.gateStatus}**`);
  lines.push(`- Profile: \`${report.source.profile}\``);
  lines.push(`- Target: \`${report.source.target}\``);
  lines.push(`- Manifest: \`${report.source.manifestPath}\``);
  lines.push(`- Summary: \`${report.source.summaryPath || "missing"}\``);
  lines.push(`- Failed/Blocked Checks: **${report.totalFailedChecks}**`);
  lines.push(`- Cluster Count: **${report.totalClustersBeforeTopN}** (Top ${report.topN})`);
  lines.push("");
  lines.push("| Rank | Count | Fingerprint | Reason | Component |");
  lines.push("|---:|---:|---|---|---|");
  if (report.clusters.length === 0) {
    lines.push("| 1 | 0 | `none` | `none` | `none` |");
  } else {
    for (let i = 0; i < report.clusters.length; i += 1) {
      const cluster = report.clusters[i];
      lines.push(
        `| ${i + 1} | ${cluster.count} | \`${cluster.fingerprint}\` | \`${cluster.reasonCode}\` | \`${cluster.component}\` |`,
      );
    }
  }
  if (report.clusters.length > 0) {
    lines.push("");
    lines.push("### Ticket Body Draft");
    for (const cluster of report.clusters) {
      lines.push(`#### ${cluster.fingerprint}`);
      lines.push(`- count: ${cluster.count}`);
      lines.push(`- reasonCode: \`${cluster.reasonCode}\``);
      lines.push(`- component: \`${cluster.component}\``);
      lines.push(`- profile: \`${cluster.profile}\``);
      lines.push(`- target: \`${cluster.target}\``);
      lines.push(`- firstSeen: \`${cluster.firstSeen}\``);
      lines.push(`- lastSeen: \`${cluster.lastSeen}\``);
      for (const sample of cluster.samples) {
        lines.push(
          `- sample: run=\`${sample.runId}\`, source=\`${sample.source}\`, check=\`${sample.checkId}\`, status=\`${sample.status}\`, reason=\`${sample.reasonCode}\``,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, markdown, { encoding: "utf8", flag: "a" });
}

function runGh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
  });
}

function hasGhCli() {
  const result = runGh(["--version"]);
  return !result.error && result.status === 0;
}

function parseJsonStdout(stdout, context) {
  try {
    return JSON.parse(stdout || "null");
  } catch {
    throw new Error(`failed to parse gh output as JSON (${context})`);
  }
}

function shortFingerprint(value) {
  return createHash("sha1")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
}

function fingerprintLabel(fingerprintShort) {
  return `uiq-fingerprint:${fingerprintShort}`;
}

function renderClusterIssueTitle(cluster, fingerprintShort, profile) {
  return `[UIQ][${profile}] ${cluster.reasonCode} [fp:${fingerprintShort}]`;
}

function renderClusterIssueBody(cluster, report, fingerprintShort) {
  const lines = [];
  lines.push(`UIQ failure fingerprint cluster auto-sync.`);
  lines.push("");
  lines.push(`- fingerprintShort: \`${fingerprintShort}\``);
  lines.push(`- fingerprint: \`${cluster.fingerprint}\``);
  lines.push(`- count: **${cluster.count}**`);
  lines.push(`- reasonCode: \`${cluster.reasonCode}\``);
  lines.push(`- component: \`${cluster.component}\``);
  lines.push(`- profile: \`${cluster.profile}\``);
  lines.push(`- target: \`${cluster.target}\``);
  lines.push(`- firstSeen: \`${cluster.firstSeen}\``);
  lines.push(`- lastSeen: \`${cluster.lastSeen}\``);
  lines.push(`- runId: \`${report.source.runId}\``);
  lines.push(`- gateStatus: \`${report.source.gateStatus}\``);
  lines.push(`- reportArtifact: \`${report.source.manifestPath}\``);
  lines.push("");
  lines.push("### Samples");
  for (const sample of cluster.samples) {
    lines.push(
      `- run=\`${sample.runId}\`, check=\`${sample.checkId}\`, status=\`${sample.status}\`, source=\`${sample.source}\`, reason=\`${sample.reasonCode}\``,
    );
  }
  lines.push("");
  lines.push(`_Automation marker: ${fingerprintLabel(fingerprintShort)}_`);
  return `${lines.join("\n")}\n`;
}

function tryFindIssue(repo, cluster, fingerprintShort) {
  const marker = `fp:${fingerprintShort}`;
  const byLabelResult = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--label",
    fingerprintLabel(fingerprintShort),
    "--json",
    "number,title,url,state,labels",
    "--limit",
    "20",
  ]);
  if (!byLabelResult.error && byLabelResult.status === 0) {
    const byLabel = parseJsonStdout(byLabelResult.stdout, "issue-list-by-label");
    if (Array.isArray(byLabel) && byLabel.length > 0) {
      return byLabel[0];
    }
  }

  const byTitleResult = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `${cluster.fingerprint} in:title`,
    "--json",
    "number,title,url,state,labels",
    "--limit",
    "20",
  ]);
  if (byTitleResult.error || byTitleResult.status !== 0) {
    return null;
  }
  const byTitle = parseJsonStdout(byTitleResult.stdout, "issue-list-by-title");
  if (!Array.isArray(byTitle) || byTitle.length === 0) {
    return null;
  }
  const found = byTitle.find((issue) => String(issue?.title || "").includes(cluster.fingerprint));
  if (found) {
    return found;
  }
  return byTitle.find((issue) => String(issue?.title || "").includes(marker)) || byTitle[0] || null;
}

function ensureFingerprintLabels(repo, labels) {
  for (const label of labels) {
    const created = runGh([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--description",
      "Managed by UIQ failure ticketing automation",
      "--color",
      "BFD4F2",
      "--force",
    ]);
    if (created.error || created.status !== 0) {
    }
  }
}

function upsertFingerprintIssue(repo, cluster, report, strictGh) {
  const fingerprintShort = shortFingerprint(cluster.fingerprint);
  const labels = ["uiq-failure-ticketing", fingerprintLabel(fingerprintShort)];
  const title = renderClusterIssueTitle(cluster, fingerprintShort, report.source.profile);
  const body = renderClusterIssueBody(cluster, report, fingerprintShort);
  try {
    const existing = tryFindIssue(repo, cluster, fingerprintShort);
    ensureFingerprintLabels(repo, labels);
    if (existing?.number) {
      if (String(existing.state || "").toUpperCase() === "CLOSED") {
        const reopened = runGh(["issue", "reopen", String(existing.number), "--repo", repo]);
        if (reopened.error || reopened.status !== 0) {
        }
      }
      const edited = runGh([
        "issue",
        "edit",
        String(existing.number),
        "--repo",
        repo,
        "--title",
        title,
        "--body",
        body,
        "--add-label",
        labels[0],
        "--add-label",
        labels[1],
      ]);
      if (edited.error || edited.status !== 0) {
        throw new Error(`gh issue edit failed for #${existing.number}`);
      }
      return {
        action: "updated",
        issueNumber: Number(existing.number),
        issueUrl: String(existing.url || ""),
      };
    }

    const created = runGh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      labels[0],
      "--label",
      labels[1],
    ]);
    if (created.error || created.status !== 0) {
      throw new Error(`gh issue create failed for fingerprint=${cluster.fingerprint}`);
    }
    const issueUrl =
      String(created.stdout || "")
        .trim()
        .split(/\s+/)[0] || "";
    return {
      action: "created",
      issueNumber: issueUrl ? Number(issueUrl.split("/").pop()) : NaN,
      issueUrl,
    };
  } catch (error) {
    if (strictGh) {
      throw error;
    }
    return {
      action: "skipped",
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

function renderPrCommentBody(report, issueResults) {
  const lines = [];
  lines.push(PR_COMMENT_MARKER);
  lines.push("## UIQ Failure Ticketing Summary");
  lines.push(`- runId: \`${report.source.runId}\``);
  lines.push(`- profile: \`${report.source.profile}\``);
  lines.push(`- target: \`${report.source.target}\``);
  lines.push(`- gateStatus: **${report.source.gateStatus}**`);
  lines.push(`- failedChecks: **${report.totalFailedChecks}**`);
  lines.push(`- topClusters: **${report.clusters.length}**`);
  lines.push("");
  lines.push("| Rank | Count | Fingerprint | Reason | Issue |");
  lines.push("|---:|---:|---|---|---|");
  if (report.clusters.length === 0) {
    lines.push("| 1 | 0 | `none` | `none` | n/a |");
    return `${lines.join("\n")}\n`;
  }
  for (let i = 0; i < report.clusters.length; i += 1) {
    const cluster = report.clusters[i];
    const issue = issueResults.get(cluster.fingerprint);
    const issueCell =
      issue?.issueUrl && Number.isInteger(issue?.issueNumber)
        ? `#${issue.issueNumber}`
        : issue?.action === "skipped"
          ? "skipped"
          : "n/a";
    lines.push(
      `| ${i + 1} | ${cluster.count} | \`${cluster.fingerprint}\` | \`${cluster.reasonCode}\` | ${issueCell} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function upsertPrComment(repo, prNumber, body, strictGh) {
  try {
    const commentsResult = runGh(["api", `repos/${repo}/issues/${prNumber}/comments?per_page=100`]);
    if (commentsResult.error || commentsResult.status !== 0) {
      throw new Error(`gh api list comments failed for pr=${prNumber}`);
    }
    const comments = parseJsonStdout(commentsResult.stdout, "pr-comments-list");
    const existing = Array.isArray(comments)
      ? comments.find((comment) => String(comment?.body || "").includes(PR_COMMENT_MARKER))
      : null;
    if (existing?.id) {
      const updated = runGh([
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/issues/comments/${existing.id}`,
        "-f",
        `body=${body}`,
      ]);
      if (updated.error || updated.status !== 0) {
        throw new Error(`gh api patch comment failed commentId=${existing.id}`);
      }
      return { action: "updated", commentId: Number(existing.id) };
    }
    const created = runGh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
    ]);
    if (created.error || created.status !== 0) {
      throw new Error(`gh api create comment failed for pr=${prNumber}`);
    }
    const payload = parseJsonStdout(created.stdout, "pr-comment-create");
    return { action: "created", commentId: Number(payload?.id || 0) };
  } catch (error) {
    if (strictGh) {
      throw error;
    }
    return { action: "skipped", error: String(error instanceof Error ? error.message : error) };
  }
}

function resolveRepo(optionRepo) {
  return String(optionRepo || process.env.GITHUB_REPOSITORY || "").trim();
}

function resolvePrNumber(optionPrNumber) {
  if (Number.isInteger(optionPrNumber) && optionPrNumber > 0) {
    return optionPrNumber;
  }
  const ref = String(process.env.GITHUB_REF || "");
  const matched = ref.match(/^refs\/pull\/(\d+)\/.+$/);
  if (!matched) {
    return 0;
  }
  return Number(matched[1]) || 0;
}

function runIntegrations(report, options) {
  const state = {
    emitGhIssues: { enabled: options.emitGhIssues, action: "dry-run", reason: "" },
    emitPrComment: { enabled: options.emitPrComment, action: "dry-run", reason: "" },
    issues: [],
    prComment: null,
  };
  const repo = resolveRepo(options.repo);
  const prNumber = resolvePrNumber(options.prNumber);
  const ghAvailable = hasGhCli();
  const strict = options.strictGh === true;
  const issueResults = new Map();

  if (!options.emitGhIssues) {
    state.emitGhIssues.reason = "disabled via --emit-gh-issues=false";
  } else if (!ghAvailable) {
    const reason = "gh CLI unavailable";
    if (strict) {
      throw new Error(reason);
    }
    state.emitGhIssues.reason = reason;
  } else if (!repo) {
    const reason = "repo unresolved (use --repo or GITHUB_REPOSITORY)";
    if (strict) {
      throw new Error(reason);
    }
    state.emitGhIssues.reason = reason;
  } else if (report.clusters.length === 0) {
    state.emitGhIssues.action = "noop";
    state.emitGhIssues.reason = "no clusters";
  } else {
    state.emitGhIssues.action = "executed";
    state.emitGhIssues.reason = `syncing ${report.clusters.length} clusters`;
    for (const cluster of report.clusters) {
      const result = upsertFingerprintIssue(repo, cluster, report, strict);
      issueResults.set(cluster.fingerprint, result);
      state.issues.push({
        fingerprint: cluster.fingerprint,
        fingerprintShort: shortFingerprint(cluster.fingerprint),
        ...result,
      });
      if (result.action === "created" || result.action === "updated") {
      } else {
      }
    }
  }

  if (!options.emitPrComment) {
    state.emitPrComment.reason = "disabled via --emit-pr-comment=false";
    return state;
  }
  if (!ghAvailable) {
    const reason = "gh CLI unavailable";
    if (strict) {
      throw new Error(reason);
    }
    state.emitPrComment.reason = reason;
    return state;
  }
  if (!repo) {
    const reason = "repo unresolved (use --repo or GITHUB_REPOSITORY)";
    if (strict) {
      throw new Error(reason);
    }
    state.emitPrComment.reason = reason;
    return state;
  }
  if (!prNumber) {
    const reason = "pr-number unresolved (use --pr-number or pull_request ref)";
    if (strict) {
      throw new Error(reason);
    }
    state.emitPrComment.reason = reason;
    return state;
  }

  state.emitPrComment.action = "executed";
  state.emitPrComment.reason = `syncing PR #${prNumber}`;
  const prBody = renderPrCommentBody(report, issueResults);
  state.prComment = upsertPrComment(repo, prNumber, prBody, strict);
  return state;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(options);
  const runDir = dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const summaryPath = options.summaryPath
    ? resolve(options.summaryPath)
    : resolve(runDir, "reports/summary.json");
  const summary = tryReadJson(summaryPath);

  const fallbackObservedAt = new Date().toISOString();
  const observedAt = normalizeIsoDate(
    manifest?.timing?.finishedAt || manifest?.timing?.startedAt || summary?.generatedAt,
    fallbackObservedAt,
  );
  const runContext = {
    runId: String(manifest?.runId || manifest?.id || "unknown"),
    gateStatus: String(manifest?.gateResults?.status || summary?.status || "unknown"),
    profile: String(manifest?.profile || summary?.profile || "unknown"),
    target: String(
      manifest?.target?.name || manifest?.target?.type || summary?.target || "unknown",
    ),
  };

  const { checks: failedChecks, sourceStats } = collectFailedChecks(manifest, summary, observedAt);
  const clusterInputs = failedChecks.map((item) => buildFingerprintClusterInput(runContext, item));
  const allClusters = clusterFailures(clusterInputs, options.sampleLimit);
  const clusters = allClusters.slice(0, options.topN);

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      runId: runContext.runId,
      gateStatus: runContext.gateStatus,
      profile: runContext.profile,
      target: runContext.target,
      manifestPath,
      summaryPath: existsSync(summaryPath) ? summaryPath : null,
      checkSourceStats: sourceStats,
    },
    totalFailedChecks: failedChecks.length,
    totalClustersBeforeTopN: allClusters.length,
    topN: options.topN,
    sampleLimit: options.sampleLimit,
    clusters,
    integrations: {},
  };

  mkdirSync(resolve(options.outDir), { recursive: true });
  const outputJson = resolve(options.outDir, `${options.outPrefix}.json`);
  const outputMd = resolve(options.outDir, `${options.outPrefix}.md`);
  const markdown = renderMarkdown(report);

  writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outputMd, markdown, "utf8");
  appendStepSummary(markdown);

  report.integrations = runIntegrations(report, options);
  writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.repo) {
  }
  if (options.prNumber) {
  }
}

main();
