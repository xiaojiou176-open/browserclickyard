#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getExcludedGovernanceSubtrees, getGovernedWorkspaceRoots } from "./workspace-roots.mjs";

const repoRoot = process.cwd();
const scanRoots = getGovernedWorkspaceRoots(repoRoot);
const excludedRoots = getExcludedGovernanceSubtrees(repoRoot);
const bannedNames = new Set([
  "node_modules",
  "Users",
  "var",
  ".cache",
  ".pytest_cache",
  ".hypothesis",
  "dist",
  "build",
  "coverage",
  ".runtime-cache",
  "__pycache__",
  "mutants",
  ".mutmut-cache",
]);
const skipNames = new Set([
  ".git",
  ".runtime-cache",
]);

const failures = [];

function isSharedNodeModulesBridge(fullPath) {
  try {
    const stat = lstatSync(fullPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = realpathSync(fullPath);
    const repoNodeModulesRoot = resolve(repoRoot, "node_modules");
    return (
      fullPath.endsWith("/node_modules") &&
      (target === repoNodeModulesRoot || !target.startsWith(repoRoot))
    );
  } catch {
    return false;
  }
}

function isBannedEntryName(entryName) {
  if (bannedNames.has(entryName)) {
    return true;
  }
  if (entryName === ".coverage" || entryName.startsWith(".coverage.")) {
    return true;
  }
  if (entryName.endsWith(".pyc")) {
    return true;
  }
  return false;
}

function walk(absPath) {
  if (excludedRoots.includes(absPath)) {
    return;
  }
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) {
      continue;
    }
    const fullPath = join(absPath, entry.name);
    if (excludedRoots.includes(fullPath)) {
      continue;
    }
    const relPath = relative(repoRoot, fullPath);
    if (entry.name === "node_modules" && isSharedNodeModulesBridge(fullPath)) {
      continue;
    }
    if (isBannedEntryName(entry.name)) {
      failures.push(`workspace runtime pollution: ${relPath}`);
      continue;
    }
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (lstatSync(fullPath).isSymbolicLink() && isBannedEntryName(entry.name)) {
      failures.push(`workspace runtime pollution symlink: ${relPath}`);
    }
  }
}

for (const root of scanRoots) {
  const absRoot = resolve(repoRoot, root);
  if (!existsSync(absRoot)) {
    continue;
  }
  walk(absRoot);
}

if (failures.length > 0) {
  console.error(`[check-workspace-runtime-pollution] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-workspace-runtime-pollution] PASS");
