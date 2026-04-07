#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const repoRootResolved = resolve(repoRoot);
if (process.argv.length > 2) {
  console.error("[check-root-allowlist] FAIL (1 issue(s))");
  console.error("- check-root-allowlist is authoritative-only; extra CLI arguments are not allowed");
  process.exit(1);
}
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/root-allowlist.yaml"), "utf8"),
);

const allowedDirs = new Set(
  Object.values(config?.tracked_root?.allowed_directories ?? {}).flatMap((items) => items ?? []),
);
for (const item of config?.tracked_root?.explicit_exceptions?.directories ?? []) {
  allowedDirs.add(item.name);
}
const allowedFiles = new Set(config?.tracked_root?.allowed_files ?? []);
const sharedTolerated = new Set(config?.tracked_root?.shared_environment_tolerated ?? []);
const disallowedRuntimeOutputs = config?.tracked_root?.disallowed_runtime_outputs ?? [];
const hostDiagnosticAllowed = /^(1|true|TRUE|yes|YES|on|ON)$/.test(
  process.env.UIQ_ALLOW_HOST_GATE_DIAGNOSTIC ?? "0",
);
if (hostDiagnosticAllowed) {
  sharedTolerated.add("home");
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const trackedFiles = git(["ls-files"])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const trackedTopLevelFiles = new Set();
const trackedTopLevelDirs = new Set();
for (const filePath of trackedFiles) {
  if (!existsSync(resolve(repoRoot, filePath))) {
    continue;
  }
  const [topLevel, ...rest] = filePath.split("/");
  if (rest.length === 0) {
    trackedTopLevelFiles.add(topLevel);
  } else {
    trackedTopLevelDirs.add(topLevel);
  }
}

const failures = [];
const actualTopLevelEntries = readdirSync(repoRoot).filter(
  (entry) => entry !== "." && entry !== "..",
);

function isSharedNodeModulesBridge(absPath) {
  try {
    const stat = lstatSync(absPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = realpathSync(absPath);
    return absPath.endsWith("/node_modules") && !target.startsWith(repoRootResolved);
  } catch {
    return false;
  }
}

for (const dir of trackedTopLevelDirs) {
  if (!allowedDirs.has(dir)) {
    failures.push(`tracked top-level directory not allowlisted: ${dir}`);
  }
}
for (const fileName of trackedTopLevelFiles) {
  if (!allowedFiles.has(fileName)) {
    failures.push(`tracked top-level file not allowlisted: ${fileName}`);
  }
}

for (const entry of actualTopLevelEntries) {
  if (sharedTolerated.has(entry)) {
    continue;
  }
  if (/[^\x20-\x7E]/.test(entry)) {
    failures.push(`worktree top-level entry contains non-printable characters: ${JSON.stringify(entry)}`);
    continue;
  }
  const abs = resolve(repoRoot, entry);
  if (entry === "node_modules" && isSharedNodeModulesBridge(abs)) {
    continue;
  }
  const isDir = existsSync(abs) && lstatSync(abs).isDirectory();
  const allowed = isDir ? allowedDirs.has(entry) : allowedFiles.has(entry);
  if (!allowed) {
    failures.push(`worktree top-level entry not allowlisted: ${entry}`);
  }
}

for (const pattern of disallowedRuntimeOutputs) {
  const matches = execFileSync("bash", ["-lc", `compgen -G '${pattern}' || true`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const match of matches) {
    failures.push(`disallowed runtime output present at repo root: ${match}`);
  }
}

if (failures.length > 0) {
  console.error(`[check-root-allowlist] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-root-allowlist] PASS");
