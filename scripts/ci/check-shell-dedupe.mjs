#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const scriptRoot = path.join(repoRoot, "scripts");

const KEY_SCRIPTS = [
  {
    path: "scripts/dev-up.sh",
    requiredImports: ["scripts/lib/ports.sh"],
  },
  {
    path: "scripts/run-pipeline.sh",
    requiredImports: ["scripts/lib/ports.sh"],
  },
  {
    path: "scripts/run-load-k6.sh",
    requiredImports: ["scripts/lib/ports.sh", "scripts/lib/backend_lifecycle.sh"],
  },
  {
    path: "scripts/run-load-k6-smoke.sh",
    requiredImports: ["scripts/lib/ports.sh", "scripts/lib/backend_lifecycle.sh"],
  },
  {
    path: "scripts/run-e2e.sh",
    requiredImports: ["scripts/lib/ports.sh"],
  },
];

const CANONICAL_LIBS = new Set(["scripts/lib/ports.sh", "scripts/lib/backend_lifecycle.sh"]);

const DUPLICATE_FUNCTION_PATTERN =
  /^\s*(is_port_in_use|find_available_port|ensure_backend)\s*\(\)\s*\{/gm;

function toRepoPath(absolutePath) {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
}

function readText(relativeFilePath) {
  return fs.readFileSync(path.join(repoRoot, relativeFilePath), "utf8");
}

function walkShellScripts(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const files = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".sh")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function lineNumberFromOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function main() {
  const errors = [];

  for (const keyScript of KEY_SCRIPTS) {
    const absolutePath = path.join(repoRoot, keyScript.path);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`missing key script: ${keyScript.path}`);
      continue;
    }
    const content = readText(keyScript.path);
    for (const requiredImport of keyScript.requiredImports) {
      const normalizedImport = requiredImport.replaceAll("\\", "/");
      if (!content.includes(normalizedImport)) {
        errors.push(`${keyScript.path} must source ${requiredImport}`);
      }
    }
  }

  const shellScripts = walkShellScripts(scriptRoot);
  for (const absolutePath of shellScripts) {
    const relativePath = toRepoPath(absolutePath);
    if (CANONICAL_LIBS.has(relativePath)) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    for (const match of content.matchAll(DUPLICATE_FUNCTION_PATTERN)) {
      const fnName = match[1];
      const offset = match.index ?? 0;
      const line = lineNumberFromOffset(content, offset);
      errors.push(
        `${relativePath}:${line} duplicates ${fnName}() (must reuse scripts/lib/ports.sh or scripts/lib/backend_lifecycle.sh)`,
      );
    }
  }

  if (errors.length === 0) {
    process.exit(0);
  }
  for (const _error of errors) {
  }
  process.exit(1);
}

main();
