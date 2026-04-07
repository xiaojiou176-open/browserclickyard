#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/upstream-inventory.yaml"), "utf8"),
);
const failures = [];

for (const system of config.systems ?? []) {
  if (!Array.isArray(system.validation_commands) || system.validation_commands.length === 0) {
    failures.push(`system '${system.system_id}' must define at least one validation command`);
  }
  if (!Array.isArray(system.contract_surface) || system.contract_surface.length === 0) {
    failures.push(`system '${system.system_id}' must define contract_surface`);
  }
  if (!system.validation_profile || !system?.ci_mapping?.required_gate) {
    failures.push(`system '${system.system_id}' must define validation_profile and ci_mapping.required_gate`);
  }
}

try {
  execFileSync(
    "node",
    ["scripts/ci/render-governance-docs.mjs", "--check", "--only", "docs/reference/compatibility-matrix.md"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  failures.push("compatibility matrix render is stale");
}

if (failures.length > 0) {
  console.error(`[check-compatibility-matrix-sync] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-compatibility-matrix-sync] PASS");
