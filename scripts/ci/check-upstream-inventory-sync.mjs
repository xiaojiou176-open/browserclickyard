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
  for (const key of [
    "system_id",
    "display_name",
    "category",
    "source_type",
    "locator_type",
    "locator_value",
    "version_pin_kind",
    "integration_owner",
    "contract_type",
    "glue_layers",
    "contract_surface",
    "validation_commands",
    "validation_profile",
    "ci_mapping",
    "upgrade_trigger",
    "rollback_path",
    "failure_attribution",
    "provenance",
  ]) {
    if (
      system[key] === undefined ||
      system[key] === null ||
      (typeof system[key] === "string" && system[key].trim().length === 0) ||
      (Array.isArray(system[key]) && system[key].length === 0)
    ) {
      failures.push(`upstream system '${system.system_id ?? "unknown"}' missing field: ${key}`);
    }
  }
}

try {
  execFileSync("node", ["scripts/ci/render-governance-docs.mjs", "--check"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  failures.push("render-governance-docs --check failed; generated upstream docs are stale");
}

if (failures.length > 0) {
  console.error(`[check-upstream-inventory-sync] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-upstream-inventory-sync] PASS");
