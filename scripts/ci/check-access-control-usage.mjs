#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "services/api/app/api");
const FORBIDDEN_CALL = /\b(check_token|check_rate_limit|requester_id)\s*\(/g;
const SAFE_CALL = /\brequire_(access|actor)\s*\(/g;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SCAN_ALL_FLAG = /^(1|true|yes|on)$/i;

function toRepoPath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).replaceAll(path.sep, "/");
}

function walkPythonFiles(dirPath) {
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
      if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(fullPath);
      }
    }
  }
  return files;
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
      "[access-control-usage] WARN: invalid GITHUB_BASE_REF, fallback to origin/main\n",
    );
    return "origin/main";
  }
  return `origin/${rawBaseRef}`;
}

function resolveChangedApiPythonFiles() {
  const baseRef = resolveBaseRef();
  const baseExists = runGit(["rev-parse", "--verify", baseRef]);
  let changed = "";
  if (baseExists) {
    const mergeBase = runGit(["merge-base", "HEAD", baseRef]);
    const range = mergeBase ? `${mergeBase}..HEAD` : `${baseRef}..HEAD`;
    changed = runGit(["diff", "--name-only", range]);
  }
  if (!changed) {
    changed = runGit(["diff", "--name-only", "HEAD~1..HEAD"]);
  }
  return new Set(
    changed
      .split(/\r?\n/)
      .map((item) => item.trim().replaceAll(path.sep, "/"))
      .filter((item) => item.startsWith("services/api/app/api/") && item.endsWith(".py")),
  );
}

function stripInlineComment(line) {
  const hashIndex = line.indexOf("#");
  if (hashIndex === -1) {
    return line;
  }
  return line.slice(0, hashIndex);
}

function buildFunctionScopes(lines) {
  const scopes = [];
  const stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const codeOnly = stripInlineComment(lines[index]);
    const defMatch = codeOnly.match(/^(\s*)(?:async\s+)?def\s+\w+\s*\(/);
    if (!defMatch) {
      continue;
    }
    const indent = defMatch[1].length;
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      const scope = stack.pop();
      scope.end = index;
      scopes.push(scope);
    }
    stack.push({
      start: index + 1,
      end: lines.length,
      indent,
    });
  }

  while (stack.length > 0) {
    scopes.push(stack.pop());
  }
  return scopes;
}

function findEnclosingScope(scopes, lineNumber) {
  let match = null;
  for (const scope of scopes) {
    if (scope.start <= lineNumber && lineNumber <= scope.end) {
      if (!match || scope.start >= match.start) {
        match = scope;
      }
    }
  }
  return match;
}

function collectCallSites(lines, pattern) {
  const sites = [];
  for (let index = 0; index < lines.length; index += 1) {
    const codeOnly = stripInlineComment(lines[index]);
    if (!codeOnly.trim()) {
      continue;
    }
    pattern.lastIndex = 0;
    let match = pattern.exec(codeOnly);
    while (match) {
      sites.push({
        line: index + 1,
        token: match[1] ?? match[0].replace(/\(.*/, ""),
      });
      match = pattern.exec(codeOnly);
    }
  }
  return sites;
}

function isCallSiteGuarded(forbiddenSite, guardSites, scopes) {
  const callScope = findEnclosingScope(scopes, forbiddenSite.line);
  if (!callScope) {
    return false;
  }
  for (const guard of guardSites) {
    if (guard.line >= forbiddenSite.line) {
      continue;
    }
    const guardScope = findEnclosingScope(scopes, guard.line);
    if (!guardScope) {
      continue;
    }
    if (
      guardScope.start === callScope.start &&
      guardScope.end === callScope.end &&
      guardScope.indent === callScope.indent
    ) {
      return true;
    }
  }
  return false;
}

function main() {
  const pythonFiles = walkPythonFiles(API_ROOT);
  if (pythonFiles.length === 0) {
    process.exit(0);
  }
  const forceScanAll = SCAN_ALL_FLAG.test(process.env.UIQ_ACCESS_CONTROL_USAGE_SCAN_ALL ?? "");
  const changedApiFiles = forceScanAll
    ? new Set(pythonFiles.map((filePath) => toRepoPath(filePath)))
    : resolveChangedApiPythonFiles();
  if (changedApiFiles.size === 0) {
    process.stdout.write("[access-control-usage] PASS: no backend API python changes detected\n");
    process.exit(0);
  }

  const violations = [];

  for (const filePath of pythonFiles) {
    if (!changedApiFiles.has(toRepoPath(filePath))) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const scopes = buildFunctionScopes(lines);
    const guardSites = collectCallSites(lines, SAFE_CALL);
    const forbiddenSites = collectCallSites(lines, FORBIDDEN_CALL);
    const hits = forbiddenSites
      .filter((site) => !isCallSiteGuarded(site, guardSites, scopes))
      .map((site) => ({
        line: site.line,
        token: site.token,
        text: lines[site.line - 1].trim(),
      }));

    if (hits.length > 0) {
      violations.push({
        file: toRepoPath(filePath),
        hits,
      });
    }
  }

  if (violations.length === 0) {
    process.stdout.write("[access-control-usage] PASS: no access-control regressions found\n");
    process.exit(0);
  }
  for (const violation of violations) {
    for (const hit of violation.hits) {
      process.stderr.write(
        `[access-control-usage] FAIL: ${violation.file}:${hit.line} uses ${hit.token} without require_access/require_actor guard (${hit.text})\n`,
      );
    }
  }
  process.exit(1);
}

main();
