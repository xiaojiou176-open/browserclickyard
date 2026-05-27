#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "./yaml-loader.mjs";

export function resolveRepoRoot(repoRoot = process.cwd()) {
  return resolve(repoRoot);
}

export function loadCacheGovernance(repoRoot = process.cwd()) {
  return YAML.parse(
    readFileSync(resolve(resolveRepoRoot(repoRoot), "configs/governance/cache-governance.yaml"), "utf8"),
  );
}

export function loadRuntimePaths(repoRoot = process.cwd()) {
  return YAML.parse(
    readFileSync(resolve(resolveRepoRoot(repoRoot), "configs/governance/runtime-paths.yaml"), "utf8"),
  );
}

export function getRuntimeClasses(config) {
  return Array.isArray(config?.runtime_classes) ? config.runtime_classes : [];
}

export function getRuntimeClassMap(config) {
  return new Map(getRuntimeClasses(config).map((runtimeClass) => [String(runtimeClass.path), runtimeClass]));
}

export function getRuntimeClassesByTier(config, tiers) {
  const allowed = new Set(tiers);
  return getRuntimeClasses(config).filter((runtimeClass) => allowed.has(runtimeClass.retention_tier));
}

export function getRuntimeClassesByCleanupScope(config, cleanupScope, tiers = []) {
  const allowedTiers = tiers.length > 0 ? new Set(tiers) : null;
  return getRuntimeClasses(config).filter((runtimeClass) => {
    if (runtimeClass.cleanup_scope !== cleanupScope) {
      return false;
    }
    return !allowedTiers || allowedTiers.has(runtimeClass.retention_tier);
  });
}

export function getRoutineCleanupRuntimeClasses(config) {
  return getRuntimeClassesByTier(config, ["scratch", "disposable_generated"]);
}

export function getProtectedRuntimeClasses(config) {
  return getRuntimeClassesByTier(config, ["runtime_state", "evidence_keep"]);
}

export function findRuntimeClass(config, pathValue) {
  const normalized = String(pathValue).replace(/^\.runtime-cache\//, "").replace(/^\/+/, "");
  return getRuntimeClassMap(config).get(normalized) ?? null;
}

export function expandGovernancePath(rawPath, repoRoot = process.cwd()) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const home = homedir();
  const xdgCacheHome = process.env.XDG_CACHE_HOME || join(home, ".cache");
  const expanded = String(rawPath)
    .replaceAll("${XDG_CACHE_HOME:-$HOME/.cache}", xdgCacheHome)
    .replaceAll("${TMPDIR:-/tmp}", process.env.TMPDIR || "/tmp")
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home)
    .replaceAll("${XDG_CACHE_HOME}", process.env.XDG_CACHE_HOME ?? xdgCacheHome)
    .replaceAll("${RUNNER_TEMP}", process.env.RUNNER_TEMP || "")
    .replaceAll("${TMPDIR}", process.env.TMPDIR || "/tmp");
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(resolvedRepoRoot, expanded);
}

export function pathMatchesSimpleGlob(pathValue, patternValue) {
  const escapeRegex = (value) => String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const pattern = escapeRegex(patternValue)
    .replaceAll("\\*\\*", ".*")
    .replaceAll("\\*", "[^/]*");
  return new RegExp(`^${pattern}$`).test(String(pathValue).replaceAll("\\", "/"));
}

function printPaths(runtimeClasses) {
  for (const runtimeClass of runtimeClasses) {
    process.stdout.write(`${runtimeClass.path}\n`);
  }
}

function printClass(runtimeClass) {
  if (!runtimeClass) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(runtimeClass)}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const repoRoot = process.cwd();
  const config = loadCacheGovernance(repoRoot);

  switch (command) {
    case "cleanup-managed-subdirs":
      printPaths(getRoutineCleanupRuntimeClasses(config));
      return;
    case "protected-subdirs":
      printPaths(getProtectedRuntimeClasses(config));
      return;
    case "scope-paths": {
      const cleanupScope = rest[0];
      const tiers = rest[1] ? rest[1].split(",").filter(Boolean) : [];
      printPaths(getRuntimeClassesByCleanupScope(config, cleanupScope, tiers));
      return;
    }
    case "class-info":
      printClass(findRuntimeClass(config, rest[0] ?? ""));
      return;
    default:
      process.stderr.write(
        "usage: node scripts/lib/runtime-governance.mjs <cleanup-managed-subdirs|protected-subdirs|scope-paths|class-info>\n",
      );
      process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
