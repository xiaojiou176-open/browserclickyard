#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/dependency-boundaries.yaml"), "utf8"),
);

const failures = [];

function hasCommand(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function searchForbiddenPattern(pattern, scopeRoots) {
  if (hasCommand("rg")) {
    return execFileSync("rg", ["-n", "-e", pattern, ...scopeRoots], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  const regex = new RegExp(pattern, "m");
  const hits = [];
  const walk = (path) => {
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) return;
      const relPath = relative(repoRoot, path);
      if (relPath.includes("home/runner/work/_temp") || relPath.includes("uiq-node-modules")) {
        return;
      }
      if (stat.isDirectory()) {
        const basename = path.split("/").pop() || "";
        if (basename === "node_modules" || basename === ".git" || basename === ".runtime-cache") {
          return;
        }
        for (const entry of readdirSync(path)) {
          walk(resolve(path, entry));
        }
        return;
      }
      if (!stat.isFile()) return;
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!regex.test(lines[index])) continue;
        hits.push(`${relPath}:${index + 1}:${lines[index]}`);
        break;
      }
    } catch {
      return;
    }
  };
  for (const scopeRoot of scopeRoots) {
    walk(resolve(repoRoot, scopeRoot));
  }
  return hits.join("\n").trim();
}

for (const rule of config.rules ?? []) {
  const scopeRoots = Array.isArray(rule.scope_roots) ? rule.scope_roots : [];
  const patterns = Array.isArray(rule.forbidden_import_patterns)
    ? rule.forbidden_import_patterns
    : [];
  if (!rule.rule_id || scopeRoots.length === 0 || patterns.length === 0) {
    failures.push(`invalid dependency boundary rule: ${JSON.stringify(rule)}`);
    continue;
  }
  for (const pattern of patterns) {
    try {
      const output = searchForbiddenPattern(pattern, scopeRoots);
      if (output) {
        failures.push(`rule '${rule.rule_id}' violation for pattern '${pattern}'\n${output}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1) {
        continue;
      }
      throw error;
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-dependency-boundaries] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-dependency-boundaries] PASS");
