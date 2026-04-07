#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/resolution-overrides.yaml"), "utf8"),
);
const generatedDoc = readFileSync(resolve(repoRoot, "docs/reference/resolution-overrides.md"), "utf8");

const failures = [];
const manifestOverrides = packageJson?.pnpm?.overrides ?? {};
const configOverrides = new Map(
  (config.overrides ?? []).map((item) => [String(item.package), String(item.resolution)]),
);

if (config?.source_of_truth?.manifest !== "package.json" || config?.source_of_truth?.path !== "pnpm.overrides") {
  failures.push("resolution-overrides source_of_truth must point to package.json -> pnpm.overrides");
}

for (const [pkg, resolution] of Object.entries(manifestOverrides)) {
  if (!configOverrides.has(pkg)) {
    failures.push(`missing override entry in resolution-overrides.yaml: ${pkg}`);
    continue;
  }
  if (configOverrides.get(pkg) !== String(resolution)) {
    failures.push(`override mismatch for ${pkg}: ${configOverrides.get(pkg)} != ${String(resolution)}`);
  }
}

for (const pkg of configOverrides.keys()) {
  if (manifestOverrides[pkg] === undefined) {
    failures.push(`stale override entry in resolution-overrides.yaml: ${pkg}`);
  }
  if (!generatedDoc.includes(`\`${pkg}\``)) {
    failures.push(`generated resolution override doc missing package: ${pkg}`);
  }
}

if (failures.length > 0) {
  console.error(`[check-resolution-overrides-sync] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-resolution-overrides-sync] PASS");
