#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();

function gitGrep(pattern, paths) {
  try {
    return execFileSync("git", ["grep", "-nE", pattern, "--", ...paths], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

const scanPaths = [
  "docs",
  "scripts",
  ".github",
  "backend",
  "apps",
  "automation",
  "tests",
  "package.json",
  "configs",
  "justfile",
  "pyproject.toml",
];

const failures = [];

const configRefs = gitGrep(String.raw`(^|[^A-Za-z0-9_.-])config/`, scanPaths).filter(
  (line) =>
    !line.includes("scripts/config/") &&
    !line.includes("src/config/") &&
    !line.includes("apps/command-center/config/") &&
    !line.includes("./config/") &&
    !line.includes(".runtime-cache/artifacts/config/") &&
    !line.includes("config input") &&
    !line.includes("config/input") &&
    !line.includes("config/cache") &&
    !line.includes("docs/reports/") &&
    !line.includes("check-config-governance-convergence.mjs") &&
    !line.includes("check-hard-cutover-legacy-paths.mjs"),
);
failures.push(...configRefs.map((line) => `legacy root config reference: ${line}`));

const artifactsRefs = gitGrep(String.raw`(^|[^.])artifacts/`, scanPaths).filter(
  (line) =>
    !line.includes(".runtime-cache/artifacts/") &&
    !line.includes('runtimeCacheRoot(), "artifacts/') &&
    !line.includes("runtime_root/artifacts/") &&
    !line.includes("artifacts/runs") &&
    !line.includes("artifacts/summary") &&
    !line.includes("artifacts/report") &&
    !line.includes("/src/artifacts/") &&
    !line.includes("docs/reports/") &&
    !line.includes("check-hard-cutover-legacy-paths.mjs"),
);
failures.push(...artifactsRefs.map((line) => `legacy root artifacts reference: ${line}`));

const playwrightRefs = gitGrep(String.raw`(^|[^A-Za-z0-9@_.-])playwright/`, scanPaths).filter(
  (line) =>
    !line.includes(".runtime-cache/reports/playwright/") &&
    !line.includes("docs/reports/") &&
    !line.includes("playwright/cli.js") &&
    !line.includes("configs/governance/upstream-inventory.yaml") &&
    !line.includes("check-hard-cutover-legacy-paths.mjs"),
);
failures.push(...playwrightRefs.map((line) => `legacy root playwright reference: ${line}`));

const venvRefs = gitGrep(String.raw`(\./)?\.venv/bin/`, scanPaths).filter(
  (line) => !line.includes("check-hard-cutover-legacy-paths.mjs"),
);
failures.push(...venvRefs.map((line) => `legacy root .venv reference: ${line}`));

const nodeBinRefs = gitGrep(String.raw`node_modules/\.bin`, scanPaths).filter(
  (line) => !line.includes("check-hard-cutover-legacy-paths.mjs"),
);
failures.push(...nodeBinRefs.map((line) => `legacy root node_modules/.bin reference: ${line}`));

const pnpmStoreRefs = gitGrep(String.raw`\.pnpm-store`, scanPaths).filter(
  (line) =>
    !line.includes("check-hard-cutover-legacy-paths.mjs") &&
    !line.includes("scripts/lib/node-toolchain.sh"),
);
failures.push(...pnpmStoreRefs.map((line) => `legacy root .pnpm-store reference: ${line}`));

if (failures.length > 0) {
  console.error(`[check-hard-cutover-legacy-paths] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-hard-cutover-legacy-paths] PASS");
