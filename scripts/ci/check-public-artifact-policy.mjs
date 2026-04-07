#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/public-artifact-policy.yaml"), "utf8"),
);
const failureBundleActionText = readFileSync(
  resolve(repoRoot, ".github/actions/failure-bundle/action.yml"),
  "utf8",
);

const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/pr.yml",
  ".github/workflows/weekly.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/branch-protection-audit.yml",
];

const failures = [];
const allowedModes = new Set(["private-only", "public-safe"]);
function extractInputDefault(text, inputName) {
  const escaped = inputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`${escaped}:\\n(?:\\s{2,}.+\\n)*?\\s{4}default:\\s*([^\\n]+)`, "m"),
  );
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

const artifactModeDefault = extractInputDefault(failureBundleActionText, "artifact-mode");
const bundlePathDefault = extractInputDefault(failureBundleActionText, "bundle-path");

if (artifactModeDefault !== config.default_failure_bundle_mode) {
  failures.push(
    `failure-bundle action default artifact-mode must match policy (${artifactModeDefault ?? "missing"} != ${config.default_failure_bundle_mode})`,
  );
}

if (!config.private_only_paths?.includes(bundlePathDefault)) {
  failures.push(
    `failure-bundle default bundle-path must be listed in private_only_paths (${bundlePathDefault ?? "missing"})`,
  );
}

for (const relPath of workflowFiles) {
  const content = readFileSync(resolve(repoRoot, relPath), "utf8");
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("uses: ./.github/actions/failure-bundle")) {
      continue;
    }

    let artifactMode = null;
    let bundlePath = null;
    for (let lookahead = index + 1; lookahead < Math.min(index + 10, lines.length); lookahead += 1) {
      const candidate = lines[lookahead];
      if (/^\s*uses:/.test(candidate) || /^\s*-\s+name:/.test(candidate) || /^\S/.test(candidate)) {
        break;
      }
      const modeMatch = candidate.match(/^\s*artifact-mode:\s*(.+)\s*$/);
      if (modeMatch) {
        artifactMode = modeMatch[1].trim().replace(/^["']|["']$/g, "");
      }
      const bundleMatch = candidate.match(/^\s*bundle-path:\s*(.+)\s*$/);
      if (bundleMatch) {
        bundlePath = bundleMatch[1].trim().replace(/^["']|["']$/g, "");
      }
    }

    if (artifactMode === null) {
      failures.push(`${relPath}: failure-bundle action must declare artifact-mode explicitly`);
    }

    if (artifactMode !== null && !allowedModes.has(artifactMode)) {
      failures.push(`${relPath}: unsupported artifact-mode '${artifactMode}' for failure-bundle action`);
    }

    if (artifactMode === "public-safe" && config.public_workflow_enabled !== true) {
      failures.push(`${relPath}: artifact-mode public-safe is forbidden while public_workflow_enabled=false`);
    }

    if (bundlePath !== null && !config.private_only_paths?.includes(bundlePath) && !config.public_safe_candidates?.includes(bundlePath)) {
      failures.push(`${relPath}: bundle-path '${bundlePath}' is not declared in public-artifact-policy`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-public-artifact-policy] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-public-artifact-policy] PASS");
