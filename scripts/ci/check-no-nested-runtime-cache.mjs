#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";
import { readFileSync } from "node:fs";
import { getExcludedGovernanceSubtrees, getGovernedWorkspaceRoots } from "./workspace-roots.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/runtime-paths.yaml"), "utf8"),
);

const failures = [];
const allowedRoot = resolve(repoRoot, config.runtime_root ?? ".runtime-cache");
const forbiddenNested = new Set(config.forbidden_nested_runtime_roots ?? []);
const excludedRoots = getExcludedGovernanceSubtrees(repoRoot);
const scanRoots = getGovernedWorkspaceRoots(repoRoot)
  .map((root) => resolve(repoRoot, root))
  .filter((absPath) => existsSync(absPath));

function walk(dirPath) {
  if (!existsSync(dirPath)) {
    return;
  }
  if (excludedRoots.includes(dirPath)) {
    return;
  }
  for (const entry of readdirSync(dirPath)) {
    const absPath = resolve(dirPath, entry);
    if (excludedRoots.includes(absPath)) {
      continue;
    }
    let stats;
    try {
      stats = lstatSync(absPath);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }
    const relPath = absPath.replace(`${repoRoot}/`, "");
    if (absPath === allowedRoot) {
      continue;
    }
    if (entry === ".runtime-cache") {
      failures.push(`nested runtime cache directory is forbidden: ${relPath}`);
      continue;
    }
    walk(absPath);
  }
}

for (const relPath of forbiddenNested) {
  const absPath = resolve(repoRoot, relPath);
  if (existsSync(absPath)) {
    failures.push(`forbidden nested runtime cache is present: ${relPath}`);
  }
}

for (const root of scanRoots) {
  walk(root);
}

if (failures.length > 0) {
  console.error(`[check-no-nested-runtime-cache] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-no-nested-runtime-cache] PASS");
