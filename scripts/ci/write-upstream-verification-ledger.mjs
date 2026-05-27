#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

function parseArgs(argv) {
  const options = { profile: "", gateName: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--profile" && next) {
      options.profile = next.trim();
      index += 1;
      continue;
    }
    if (token === "--gate-name" && next) {
      options.gateName = next.trim();
      index += 1;
    }
  }
  if (!options.profile) {
    throw new Error("missing --profile");
  }
  if (!options.gateName) {
    throw new Error("missing --gate-name");
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const inventory = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/upstream-inventory.yaml"), "utf8"),
);
const outDir = resolve(repoRoot, ".runtime-cache/artifacts/ci");
mkdirSync(outDir, { recursive: true });

const payload = {
  schemaVersion: "1.0",
  component: "upstream-verification-ledger",
  profile: options.profile,
  gateName: options.gateName,
  generatedAt: new Date().toISOString(),
  systems: (inventory.systems ?? [])
    .filter((system) => system.validation_profile === options.profile)
    .map((system) => ({
      systemId: system.system_id,
      displayName: system.display_name,
      requiredGate: system?.ci_mapping?.required_gate ?? "",
      workflow: system?.ci_mapping?.workflow ?? "",
      validationCommands: system.validation_commands ?? [],
      contractSurface: system.contract_surface ?? [],
      status: "verified-by-aggregate",
    })),
};

const outputPath = resolve(outDir, `upstream-verification-ledger-${options.profile}.json`);
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`[write-upstream-verification-ledger] WROTE ${outputPath}`);
