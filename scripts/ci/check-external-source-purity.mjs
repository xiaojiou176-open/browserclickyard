#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/upstream-inventory.yaml"), "utf8"),
);
const hostManagedConfig = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/host-managed-upstream-exceptions.yaml"), "utf8"),
);
const failures = [];
const floatingMarkers = ["@latest", ":latest", "@main", "@master", "@HEAD", "floating", "latest"];
const hostManagedExceptions = new Map(
  (hostManagedConfig.exceptions ?? []).map((item) => [String(item.system_id), item]),
);

for (const system of config.systems ?? []) {
  const locatorType = String(system.locator_type ?? "").trim();
  const locatorValue = String(system.locator_value ?? "").trim();
  const pinKind = String(system.version_pin_kind ?? "").trim();
  const locator = `${locatorType}:${locatorValue}`;
  if (!locatorType || !locatorValue || !pinKind) {
    failures.push(`system '${system.system_id}' missing locator_type/locator_value/version_pin_kind`);
  }
  const lower = locator.toLowerCase();
  if (floatingMarkers.some((marker) => lower.includes(marker.toLowerCase()))) {
    failures.push(`system '${system.system_id}' uses floating locator: ${locator}`);
  }
  if (pinKind === "host-managed-exception") {
    const exception = hostManagedExceptions.get(String(system.system_id));
    if (!exception) {
      failures.push(`system '${system.system_id}' must be declared in host-managed-upstream-exceptions.yaml`);
      continue;
    }
    if (typeof system.host_managed_reference !== "string" || !system.host_managed_reference.trim()) {
      failures.push(`system '${system.system_id}' must declare host_managed_reference for host-managed-exception`);
    }
    if (
      exception.validation_profile !== system.validation_profile ||
      exception.required_gate !== system?.ci_mapping?.required_gate
    ) {
      failures.push(`system '${system.system_id}' host-managed exception registry is out of sync with upstream inventory`);
    }
    continue;
  }
  if (!locatorValue.includes("@")) {
    failures.push(`system '${system.system_id}' locator_value must be addressable/versioned: ${locatorValue}`);
  }
  if (!["exact-version", "workspace-lock"].includes(pinKind)) {
    failures.push(`system '${system.system_id}' uses unsupported version_pin_kind: ${pinKind}`);
  }
}

if (failures.length > 0) {
  console.error(`[check-external-source-purity] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-external-source-purity] PASS");
