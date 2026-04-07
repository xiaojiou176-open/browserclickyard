#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function grepWithNoMatches(args) {
  try {
    return git(args);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return "";
    }
    throw error;
  }
}

const failures = [];
const configDir = resolve(repoRoot, "config");
if (existsSync(configDir)) {
  const remainingEntries = readdirSync(configDir).filter((name) => name !== "__pycache__");
  if (remainingEntries.length > 0) {
    failures.push(
      `config/ must be removed entirely; remaining entries: ${remainingEntries.sort().join(", ")}`,
    );
  }
}

const trackedConfigFiles = grepWithNoMatches(["ls-files", "config"])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
for (const filePath of trackedConfigFiles) {
  if (existsSync(resolve(repoRoot, filePath))) {
    failures.push(`tracked config/ file still exists in worktree: ${filePath}`);
  }
}

const allowedLineFragments = [
  "docs/reports/",
  "scripts/config/",
  "src/config/",
  "apps/command-center/config/",
  "./config/",
  ".runtime-cache/artifacts/config/",
  "config input",
  "config/input",
  "config/cache",
  "check-config-governance-convergence.mjs",
  "check-hard-cutover-legacy-paths.mjs",
];

const activeRefs = grepWithNoMatches([
  "grep",
  "-n",
  "config/",
  "--",
  "docs",
  "scripts",
  ".github",
  "package.json",
  "backend",
  "apps",
  "automation",
  "tests",
  "configs",
]);
for (const line of activeRefs.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
  if (allowedLineFragments.some((fragment) => line.includes(fragment))) {
    continue;
  }
  const [filePath] = line.split(":");
  failures.push(`unexpected active root config/ reference: ${filePath}`);
}

if (failures.length > 0) {
  console.error(`[check-config-governance-convergence] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-config-governance-convergence] PASS");
