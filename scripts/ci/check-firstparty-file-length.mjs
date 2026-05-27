#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LINE_LIMIT = 800;
const ALLOWLIST = new Set();
const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
]);
const GENERATED_DIR_NAMES = new Set([
  ".runtime-cache",
  "artifacts",
  "dist",
  "build",
  "coverage",
  "node_modules",
  ".next",
  "out",
  "api-gen",
]);
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function normalizeToPosix(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function listTrackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return output
      .split("\u0000")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function resolveBaseRef() {
  const rawBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (!rawBaseRef) {
    return "origin/main";
  }
  if (!SAFE_GIT_REF.test(rawBaseRef)) {
    process.stderr.write(
      "[firstparty-file-length] WARN: invalid GITHUB_BASE_REF, fallback to origin/main\n",
    );
    return "origin/main";
  }
  return `origin/${rawBaseRef}`;
}

function listChangedFiles() {
  const fromEnv = process.env.UIQ_FILE_LENGTH_CHANGED_FILES?.trim();
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const staged = runGit(["diff", "--cached", "--name-only"]);
  if (staged) {
    return staged
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const baseRef = resolveBaseRef();
  const baseExists = runGit(["rev-parse", "--verify", baseRef]);
  if (baseExists) {
    const mergeBase = runGit(["merge-base", "HEAD", baseRef]);
    const range = mergeBase ? `${mergeBase}..HEAD` : `${baseRef}..HEAD`;
    const changed = runGit(["diff", "--name-only", range]);
    if (changed) {
      return changed
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  const latest = runGit(["diff", "--name-only", "HEAD~1..HEAD"]);
  if (latest) {
    return latest
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function shouldSkip(filePath) {
  const normalized = normalizeToPosix(filePath);
  const baseName = path.basename(normalized);
  const ext = path.extname(normalized).toLowerCase();
  const parts = normalized.split("/");

  if (!CODE_EXTENSIONS.has(ext)) {
    return true;
  }
  if (LOCKFILES.has(baseName)) {
    return true;
  }
  if (
    normalized.startsWith(".codex/") ||
    normalized.includes("/.codex/") ||
    normalized.startsWith(".claude/") ||
    normalized.includes("/.claude/") ||
    normalized.startsWith(".opencode/") ||
    normalized.includes("/.opencode/") ||
    normalized === ".cursorrules" ||
    normalized.endsWith("/.cursorrules")
  ) {
    return true;
  }
  if (normalized.startsWith("docs/") || normalized.includes("/docs/")) {
    return true;
  }
  if (normalized.includes("/tests/") || normalized.startsWith("tests/")) {
    return true;
  }
  if (/\.test\.[^/]+$/i.test(baseName)) {
    return true;
  }
  if (normalized.includes("/styles/css/") || normalized.endsWith(".css")) {
    return true;
  }
  if (/openapi\/.*\.ya?ml$/i.test(normalized) || /openapi.*\.ya?ml$/i.test(baseName)) {
    return true;
  }
  if (normalized.includes("/api-gen/") || normalized.startsWith("api-gen/")) {
    return true;
  }
  for (const part of parts) {
    if (GENERATED_DIR_NAMES.has(part)) {
      return true;
    }
  }
  return false;
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split(/\r?\n/).length;
}

function main() {
  const trackedFiles = listTrackedFiles();
  if (trackedFiles.length === 0) {
    process.stderr.write("[firstparty-file-length] WARN: no tracked files found, skip\n");
    process.exit(0);
  }
  const changedFiles = new Set(listChangedFiles().map((item) => normalizeToPosix(item)));
  if (changedFiles.size === 0) {
    process.stdout.write("[firstparty-file-length] PASS: no code changes detected\n");
    process.exit(0);
  }

  const violations = [];

  for (const filePath of trackedFiles) {
    const normalized = normalizeToPosix(filePath);
    if (!changedFiles.has(normalized)) {
      continue;
    }
    if (shouldSkip(filePath)) {
      continue;
    }
    if (ALLOWLIST.has(normalized)) {
      continue;
    }
    const lines = countLines(filePath);
    if (lines > LINE_LIMIT) {
      violations.push({ file: normalized, lines });
    }
  }

  if (violations.length === 0) {
    process.stdout.write("[firstparty-file-length] PASS: no oversized changed first-party files\n");
    process.exit(0);
  }

  violations.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  for (const violation of violations) {
    process.stderr.write(
      `[firstparty-file-length] FAIL: ${violation.file} has ${violation.lines} lines (limit=${LINE_LIMIT})\n`,
    );
  }
  process.exit(1);
}

main();
