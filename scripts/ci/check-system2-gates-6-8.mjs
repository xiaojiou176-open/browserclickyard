#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

const REQUIRED_FILES = {
  precommit: ".pre-commit-config.yaml",
  packageJson: "package.json",
  docsGate: "scripts/docs-gate.sh",
  ciWorkflow: ".github/workflows/ci.yml",
  prWorkflow: ".github/workflows/pr.yml",
  nightlyWorkflow: ".github/workflows/nightly.yml",
  desktopWorkflow: ".github/workflows/desktop-smoke.yml",
  liveRealismWorkflow: ".github/workflows/live-realism.yml",
  releaseWorkflow: ".github/workflows/release-candidate.yml",
  heartbeatLib: "scripts/lib/heartbeat.sh",
};

function readUtf8(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function checkFilePresence() {
  const missing = [];
  for (const file of Object.values(REQUIRED_FILES)) {
    if (!existsSync(resolve(ROOT, file))) {
      missing.push(file);
    }
  }
  return missing;
}

function asGateResult(id, title, status, evidence, fixes = []) {
  return { id, title, status, evidence, fixes };
}

function ensureNeedle(content, needle) {
  return content.includes(needle);
}

function ensureOrder(content, firstNeedle, secondNeedle) {
  const a = content.indexOf(firstNeedle);
  const b = content.indexOf(secondNeedle);
  return a >= 0 && b >= 0 && a < b;
}

function ensureDocsLinkageReachable(content) {
  return (
    ensureNeedle(content, "docs-gate.sh") || ensureNeedle(content, "pnpm gate:docs:diff-linkage")
  );
}

function gate6Heartbeat() {
  const ci = readUtf8(REQUIRED_FILES.ciWorkflow);
  const pr = readUtf8(REQUIRED_FILES.prWorkflow);
  const nightly = readUtf8(REQUIRED_FILES.nightlyWorkflow);
  const desktop = readUtf8(REQUIRED_FILES.desktopWorkflow);
  const live = readUtf8(REQUIRED_FILES.liveRealismWorkflow);
  const release = readUtf8(REQUIRED_FILES.releaseWorkflow);
  const heartbeatLib = readUtf8(REQUIRED_FILES.heartbeatLib);

  const workflowChecks = [
    [REQUIRED_FILES.ciWorkflow, ci],
    [REQUIRED_FILES.prWorkflow, pr],
    [REQUIRED_FILES.nightlyWorkflow, nightly],
    [REQUIRED_FILES.desktopWorkflow, desktop],
    [REQUIRED_FILES.liveRealismWorkflow, live],
    [REQUIRED_FILES.releaseWorkflow, release],
  ];

  const missing = workflowChecks
    .filter(([, content]) => !ensureNeedle(content, 'UIQ_HEARTBEAT_INTERVAL_SEC: "60"'))
    .map(([file]) => file);

  const hasHeartbeatFunctions =
    ensureNeedle(heartbeatLib, "uiq_start_pid_heartbeat") &&
    ensureNeedle(heartbeatLib, "uiq_run_with_heartbeat");

  const evidence = [
    `heartbeat-lib=${hasHeartbeatFunctions ? "present" : "missing"}`,
    `workflows-with-60s-heartbeat=${workflowChecks.length - missing.length}/${workflowChecks.length}`,
  ];
  if (missing.length > 0) {
    evidence.push(`missing=${missing.join(", ")}`);
  }

  return asGateResult(
    "6",
    "Heartbeat required (<=60s)",
    missing.length === 0 && hasHeartbeatFunctions ? "PASS" : "FAIL",
    evidence,
    missing.length > 0 ? ['Add UIQ_HEARTBEAT_INTERVAL_SEC="60" to the workflow top-level env block.'] : [],
  );
}

function gate7ShortBeforeLong() {
  const pr = readUtf8(REQUIRED_FILES.prWorkflow);
  const nightly = readUtf8(REQUIRED_FILES.nightlyWorkflow);
  const desktop = readUtf8(REQUIRED_FILES.desktopWorkflow);
  const release = readUtf8(REQUIRED_FILES.releaseWorkflow);

  const checks = [
    {
      label: "PR workflow: frontend-e2e-behavior-suite -> Run PR Profile",
      ok: ensureOrder(pr, "frontend-e2e-behavior-suite", "Run PR Profile"),
    },
    {
      label: "Nightly workflow: frontend-e2e-smoke -> Run Nightly Profile",
      ok: ensureOrder(nightly, "frontend-e2e-smoke", "Run Nightly Profile"),
    },
    {
      label: "Desktop workflow matrix contains smoke and soak",
      ok: ensureNeedle(desktop, "profile: [smoke, soak]"),
    },
    {
      label: "Release workflow short gate exists before release gate",
      ok: ensureOrder(release, "Generate critical non-stub report (release)", "Run release gate"),
    },
  ];

  const failed = checks.filter((item) => !item.ok).map((item) => item.label);
  const evidence = checks.map((item) => `${item.ok ? "ok" : "missing"}: ${item.label}`);

  return asGateResult(
    "7",
    "Short before long (smoke/unit -> integration/e2e-long)",
    failed.length === 0 ? "PASS" : "FAIL",
    evidence,
    failed,
  );
}

function gate8DocsLinkage() {
  const precommit = readUtf8(REQUIRED_FILES.precommit);
  const pkg = JSON.parse(readUtf8(REQUIRED_FILES.packageJson));
  const docsGate = readUtf8(REQUIRED_FILES.docsGate);
  const ci = readUtf8(REQUIRED_FILES.ciWorkflow);
  const pr = readUtf8(REQUIRED_FILES.prWorkflow);

  const checks = [
    {
      label: "pre-commit has docs ssot hook",
      ok: ensureNeedle(precommit, "UIQ docs SSOT gate (pre-commit)"),
    },
    {
      label: "pre-commit has diff doc linkage hook",
      ok: ensureNeedle(precommit, "UIQ diff doc linkage gate (pre-commit)"),
    },
    {
      label: "package.json has gate:docs:ssot",
      ok: Boolean(pkg?.scripts?.["gate:docs:ssot"]),
    },
    {
      label: "package.json has gate:docs:diff-linkage",
      ok: Boolean(pkg?.scripts?.["gate:docs:diff-linkage"]),
    },
    {
      label: "scripts/docs-gate.sh runs check-doc-governance-consistency",
      ok: ensureNeedle(docsGate, "check-doc-governance-consistency.mjs"),
    },
    {
      label: "scripts/docs-gate.sh runs check-docs-ssot",
      ok: ensureNeedle(docsGate, "check-docs-ssot.mjs"),
    },
    {
      label: "scripts/docs-gate.sh runs check-diff-doc-linkage",
      ok: ensureNeedle(docsGate, "check-diff-doc-linkage.mjs"),
    },
    {
      label:
        "CI workflow has docs linkage reachable (docs-gate.sh or explicit gate:docs:diff-linkage)",
      ok: ensureDocsLinkageReachable(ci),
    },
    {
      label:
        "PR workflow has docs linkage reachable (docs-gate.sh or explicit gate:docs:diff-linkage)",
      ok: ensureDocsLinkageReachable(pr),
    },
  ];

  const failed = checks.filter((item) => !item.ok).map((item) => item.label);
  const evidence = checks.map((item) => `${item.ok ? "ok" : "missing"}: ${item.label}`);

  return asGateResult(
    "8",
    "Code/docs linkage (docs gate)",
    failed.length === 0 ? "PASS" : "FAIL",
    evidence,
    failed,
  );
}

function printMatrix(results) {
  console.log("| Gate | Status | Evidence | Suggested Fix |");
  console.log("| --- | --- | --- | --- |");
  for (const result of results) {
    const evidence = result.evidence.join("; ").replaceAll("|", "\\|");
    const notes = (result.fixes.length > 0 ? result.fixes.join("; ") : "-").replaceAll("|", "\\|");
    console.log(`| ${result.id} ${result.title} | ${result.status} | ${evidence} | ${notes} |`);
  }
}

function main() {
  const missingFiles = checkFilePresence();
  if (missingFiles.length > 0) {
    console.error("[system2-gates-6-8] FAIL (missing required files)");
    missingFiles.forEach((filePath, index) => {
      console.error(`  ${index + 1}. ${filePath}`);
    });
    process.exit(2);
  }

  const results = [gate6Heartbeat(), gate7ShortBeforeLong(), gate8DocsLinkage()];
  printMatrix(results);

  const failed = results.filter((item) => item.status !== "PASS");
  if (failed.length > 0) {
    console.error(`[system2-gates-6-8] FAIL (${failed.length} gate(s) failed)`);
    failed.forEach((item) => {
      console.error(`- Gate ${item.id}: ${item.title}`);
      item.evidence.forEach((line) => console.error(`  evidence: ${line}`));
      item.fixes.forEach((line) => console.error(`  fix: ${line}`));
    });
    process.exit(1);
  }

  console.log("[system2-gates-6-8] PASS");
}

main();
