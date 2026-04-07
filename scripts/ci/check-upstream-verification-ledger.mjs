#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const inventory = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/upstream-inventory.yaml"), "utf8"),
);

const failures = [];

for (const system of inventory.systems ?? []) {
  if (!system.validation_profile || typeof system.validation_profile !== "string") {
    failures.push(`system '${system.system_id ?? "unknown"}' missing validation_profile`);
  }
  if (!system?.ci_mapping?.required_gate || !system?.ci_mapping?.workflow) {
    failures.push(`system '${system.system_id ?? "unknown"}' missing ci_mapping.required_gate/workflow`);
  }
}

if (!existsSync(resolve(repoRoot, "scripts/ci/write-upstream-verification-ledger.mjs"))) {
  failures.push("missing scripts/ci/write-upstream-verification-ledger.mjs");
}

if (failures.length > 0) {
  console.error(`[check-upstream-verification-ledger] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-upstream-verification-ledger] PASS");
