#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const reportDir = resolve(repoRoot, ".runtime-cache/artifacts/ci");
mkdirSync(reportDir, { recursive: true });

const scoreDefinitions = {
  architecture: {
    max: 30,
    checks: [
      { weight: 10, cmd: "node scripts/ci/check-dependency-boundaries.mjs" },
      { weight: 10, cmd: "node scripts/ci/check-config-governance-convergence.mjs" },
      { weight: 10, cmd: "node scripts/ci/check-hard-cutover-legacy-paths.mjs" },
    ],
  },
  cache: {
    max: 20,
    checks: [
      { weight: 5, cmd: "node scripts/ci/check-cache-governance.mjs" },
      { weight: 5, cmd: "node scripts/ci/check-no-nested-runtime-cache.mjs" },
      { weight: 5, cmd: "node scripts/ci/check-workspace-runtime-pollution.mjs" },
      { weight: 5, cmd: "bash scripts/ci/check-mainline-repro-without-cache.sh" },
    ],
  },
  logging: {
    max: 20,
    checks: [
      { weight: 8, cmd: "node scripts/ci/check-log-quality.mjs" },
      { weight: 6, cmd: "bash scripts/ci/check-no-wild-log-surfaces.sh" },
      { weight: 6, cmd: "node scripts/ci/check-public-artifact-policy.mjs" },
    ],
  },
  root_cleanliness: {
    max: 10,
    checks: [
      { weight: 5, cmd: "node scripts/ci/check-root-allowlist.mjs" },
      { weight: 5, cmd: "bash scripts/repo/smoke-root-cleanliness.sh" },
    ],
  },
  upstream_integration: {
    max: 20,
    checks: [
      { weight: 5, cmd: "node scripts/ci/check-dependency-boundaries.mjs" },
      { weight: 5, cmd: "node scripts/ci/check-workflow-topology-sync.mjs" },
      { weight: 5, cmd: "node scripts/ci/render-ci-governance-doc.mjs --check" },
      { weight: 5, cmd: "node scripts/ci/render-public-readiness-doc.mjs --check" },
    ],
  },
};

function runCheck(cmd) {
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
  return {
    cmd,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0,
  };
}

const verifiedBy = [];
const blockingFindings = [];
const scorecard = {
  repo_archetype: "hybrid-repo",
  architecture: { score: 0, max: scoreDefinitions.architecture.max },
  cache: { score: 0, max: scoreDefinitions.cache.max },
  logging: { score: 0, max: scoreDefinitions.logging.max },
  root_cleanliness: { score: 0, max: scoreDefinitions.root_cleanliness.max },
  upstream_integration: { score: 0, max: scoreDefinitions.upstream_integration.max },
};

for (const [dimension, definition] of Object.entries(scoreDefinitions)) {
  let score = 0;
  for (const check of definition.checks) {
    const result = runCheck(check.cmd);
    verifiedBy.push({ cmd: check.cmd, exitCode: result.exitCode });
    if (result.ok) {
      score += check.weight;
      continue;
    }
    blockingFindings.push({
      dimension,
      cmd: check.cmd,
      exitCode: result.exitCode,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    });
  }
  scorecard[dimension].score = score;
}

const overallScore =
  scorecard.architecture.score +
  scorecard.cache.score +
  scorecard.logging.score +
  scorecard.root_cleanliness.score +
  scorecard.upstream_integration.score;

const payload = {
  repo_archetype: "hybrid-repo",
  architecture: scorecard.architecture,
  cache: scorecard.cache,
  logging: scorecard.logging,
  root_cleanliness: scorecard.root_cleanliness,
  upstream_integration: scorecard.upstream_integration,
  overall: { score: overallScore, max: 100 },
  blocking_findings: blockingFindings,
  verified_by: verifiedBy,
  generated_at: new Date().toISOString(),
};

for (const fileName of ["repo-governance-scorecard.json", "scorecard.json"]) {
  writeFileSync(resolve(reportDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

console.log(
  `[write-governance-scorecard] WROTE ${resolve(reportDir, "repo-governance-scorecard.json")}`,
);
