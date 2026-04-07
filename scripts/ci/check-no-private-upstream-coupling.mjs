#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";
import { getGovernedWorkspaceRoots } from "./workspace-roots.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/upstream-inventory.yaml"), "utf8"),
);
const failures = [];
const searchRoots = getGovernedWorkspaceRoots(repoRoot);

for (const system of config.systems ?? []) {
  for (const pattern of system.private_coupling_forbidden_patterns ?? []) {
    if (!pattern) {
      continue;
    }
    try {
      const output = execFileSync(
        "rg",
        ["-n", "-e", pattern, ...searchRoots],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (output) {
        failures.push(`forbidden private upstream coupling for '${system.system_id}': ${pattern}\n${output}`);
      }
    } catch {
      // rg exits non-zero when there is no match; that is success for this gate.
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-no-private-upstream-coupling] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-no-private-upstream-coupling] PASS");
