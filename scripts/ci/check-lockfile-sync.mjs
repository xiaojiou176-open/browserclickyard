#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const TARGETS = [{ name: "root", dir: "." }];

function exists(filePath) {
  return fs.existsSync(filePath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseJson(filePath) {
  return JSON.parse(readText(filePath));
}

function lockfileVersionFromText(lockfileText) {
  const match = lockfileText.match(/^lockfileVersion:\s*['"]?([^'"\n]+)['"]?/m);
  return match ? match[1].trim() : null;
}

function hasRootImporter(lockfileText) {
  if (!/\nimporters:\s*\n/m.test(lockfileText)) {
    return false;
  }
  return /\n\s{2}\.:\s*\n/m.test(lockfileText);
}

const errors = [];
const versions = [];

const rootPackageJsonPath = path.join(ROOT_DIR, "package.json");
if (!exists(rootPackageJsonPath)) {
  errors.push("missing root package.json");
} else {
  const rootPkg = parseJson(rootPackageJsonPath);
  const packageManager = String(rootPkg.packageManager || "");
  if (!packageManager.startsWith("pnpm@")) {
    errors.push(
      `root packageManager must start with 'pnpm@', got '${packageManager || "(empty)"}'`,
    );
  }
}

for (const target of TARGETS) {
  const baseDir = path.join(ROOT_DIR, target.dir);
  const packageJsonPath = path.join(baseDir, "package.json");
  const pnpmLockPath = path.join(baseDir, "pnpm-lock.yaml");
  const packageLockPath = path.join(baseDir, "package-lock.json");
  const yarnLockPath = path.join(baseDir, "yarn.lock");

  if (!exists(packageJsonPath)) {
    errors.push(`[${target.name}] missing package.json at ${target.dir}/package.json`);
  } else {
    const pkg = parseJson(packageJsonPath);
    const packageManager = pkg.packageManager ? String(pkg.packageManager) : "";
    if (packageManager && !packageManager.startsWith("pnpm@")) {
      errors.push(
        `[${target.name}] packageManager must start with 'pnpm@' when set, got '${packageManager}'`,
      );
    }
  }

  if (!exists(pnpmLockPath)) {
    errors.push(`[${target.name}] missing pnpm lockfile at ${target.dir}/pnpm-lock.yaml`);
    continue;
  }
  if (exists(packageLockPath)) {
    errors.push(`[${target.name}] unexpected npm lockfile found: ${target.dir}/package-lock.json`);
  }
  if (exists(yarnLockPath)) {
    errors.push(`[${target.name}] unexpected yarn lockfile found: ${target.dir}/yarn.lock`);
  }

  const lockfileText = readText(pnpmLockPath);
  const version = lockfileVersionFromText(lockfileText);
  if (!version) {
    errors.push(`[${target.name}] could not parse lockfileVersion in ${target.dir}/pnpm-lock.yaml`);
    continue;
  }
  if (!hasRootImporter(lockfileText)) {
    errors.push(`[${target.name}] missing root importer "." in ${target.dir}/pnpm-lock.yaml`);
    continue;
  }
  versions.push({ target: target.name, version });
}

for (const nestedLockfile of ["apps/command-center/pnpm-lock.yaml", "tooling/automation/pnpm-lock.yaml"]) {
  if (exists(path.join(ROOT_DIR, nestedLockfile))) {
    errors.push(`unexpected nested pnpm lockfile found: ${nestedLockfile}; repo must use root pnpm-lock.yaml as the single source of truth`);
  }
}

const rootLockText = readText(path.join(ROOT_DIR, "pnpm-lock.yaml"));
for (const requiredImporter of ["apps/command-center", "tooling/automation", "services/mcp-server"]) {
  if (!new RegExp(`\\n\\s{2}${requiredImporter}:\\s*\\n`).test(rootLockText)) {
    errors.push(`root pnpm-lock.yaml missing importer '${requiredImporter}'`);
  }
}

if (errors.length > 0) {
  for (const _error of errors) {
  }
  process.exit(1);
}
for (const _entry of versions) {
}
