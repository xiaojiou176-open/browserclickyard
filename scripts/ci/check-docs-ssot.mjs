#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const failures = [];

const REQUIRED_FILES = [
  "docs/ai/agent-guide.md",
  "docs/index.md",
  "docs/architecture.md",
  "README.md",
];

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizePath(input) {
  return String(input || "").replaceAll(path.sep, "/").trim();
}

function pushFailure(message) {
  failures.push(message);
}

function readText(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function resolveChangedFiles() {
  try {
    const staged = git(["diff", "--cached", "--name-only"]);
    if (staged) {
      return staged.split(/\r?\n/).map(normalizePath).filter(Boolean);
    }
  } catch {
    // Ignore and fall back.
  }

  try {
    const changed = git(["diff", "--name-only", "HEAD"]);
    return changed.split(/\r?\n/).map(normalizePath).filter(Boolean);
  } catch {
    return [];
  }
}

for (const relPath of REQUIRED_FILES) {
  if (!fs.existsSync(path.join(repoRoot, relPath))) {
    pushFailure(`missing required file: ${relPath}`);
  }
}

if (fs.existsSync(path.join(repoRoot, "docs/architecture.md"))) {
  const architecture = readText("docs/architecture.md");
  const requiredSections = [
    "## Canonical Boundaries",
    "## System Contract",
    "## Runtime Artifact Layout",
    "## Gate Status Contract",
  ];
  for (const section of requiredSections) {
    if (!architecture.includes(section)) {
      pushFailure(`docs/architecture.md missing section: ${section}`);
    }
  }
}

if (fs.existsSync(path.join(repoRoot, "docs/index.md"))) {
  const index = readText("docs/index.md");
  if (!index.includes("docs/ai/agent-guide.md")) {
    pushFailure("docs/index.md must link to docs/ai/agent-guide.md");
  }
  if (!index.includes("docs/architecture.md")) {
    pushFailure("docs/index.md must link to docs/architecture.md");
  }
}

const changedFiles = resolveChangedFiles();
if (changedFiles.length > 0) {
  const changedDocs = new Set(
    changedFiles.filter(
      (filePath) =>
        filePath === "README.md" || filePath === "CHANGELOG.md" || filePath.startsWith("docs/"),
    ),
  );

  const codeTouched = changedFiles.some((filePath) =>
    /^(apps\/|services\/|packages\/|contracts\/|tooling\/automation\/|scripts\/)/.test(filePath),
  );
  const envTouched = changedFiles.some((filePath) =>
    filePath === ".env.example" ||
    filePath.startsWith("configs/env/") ||
    filePath.startsWith("scripts/env/") ||
    filePath === "scripts/config/generate-env-example.mjs"
  );
  const dependencyTouched = changedFiles.some((filePath) =>
    [
      "package.json",
      "pnpm-lock.yaml",
      "uv.lock",
      "pyproject.toml",
      "tooling/automation/package.json",
      "apps/command-center/package.json",
    ].includes(filePath),
  );

  if (codeTouched && changedDocs.size === 0) {
    pushFailure("code changes require at least one docs or README update in the same change");
  }

  if (envTouched && !changedDocs.has("docs/reference/configuration.md")) {
    pushFailure("environment changes must update docs/reference/configuration.md");
  }

  if (
    dependencyTouched &&
    !changedDocs.has("docs/reference/dependency-governance.md") &&
    !changedDocs.has("CHANGELOG.md")
  ) {
    pushFailure("dependency changes must update docs/reference/dependency-governance.md or CHANGELOG.md");
  }
}

if (failures.length > 0) {
  console.error(`[docs-ssot] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[docs-ssot] PASS");
