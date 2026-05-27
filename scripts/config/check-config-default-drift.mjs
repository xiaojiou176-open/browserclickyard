#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const BASELINE_DEFAULTS = new Map([
  ["APP_ENV", "development"],
  ["AUTOMATION_MAX_PARALLEL", "6"],
  ["CACHE_TTL_SECONDS", "900"],
  ["CACHE_MAX_ENTRIES", "500"],
]);

function normalizeDefault(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value).trim();
}

function loadContractDefaults(contractPathInput) {
  const contractPath = resolve(contractPathInput);
  const contract = YAML.parse(readFileSync(contractPath, "utf8"));
  if (!contract || typeof contract !== "object" || !Array.isArray(contract.variables)) {
    throw new Error(`invalid contract file: ${contractPathInput}`);
  }
  const defaults = new Map();
  for (const variable of contract.variables) {
    if (!variable || typeof variable !== "object") {
      continue;
    }
    const name = String(variable.name || "").trim();
    if (!name) {
      continue;
    }
    defaults.set(name, normalizeDefault(variable.default));
  }
  return defaults;
}

function loadEnvExampleDefaults(envPathInput) {
  const envPath = resolve(envPathInput);
  const content = readFileSync(envPath, "utf8");
  const defaults = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      continue;
    }
    defaults.set(key, value);
  }
  return defaults;
}

function main() {
  const contractDefaults = loadContractDefaults("configs/env/contract.yaml");
  const envDefaults = loadEnvExampleDefaults(".env.example");

  const errors = [];
  for (const [key, baselineValue] of BASELINE_DEFAULTS.entries()) {
    const contractValue = contractDefaults.get(key);
    const envValue = envDefaults.get(key);
    if (contractValue === undefined) {
      errors.push(`missing in configs/env/contract.yaml: ${key}`);
      continue;
    }
    if (envValue === undefined) {
      errors.push(`missing in .env.example: ${key}`);
      continue;
    }
    if (contractValue !== envValue) {
      errors.push(
        `${key} mismatch between contract (${contractValue}) and .env.example (${envValue})`,
      );
    }
    if (contractValue !== baselineValue) {
      errors.push(
        `${key} drifted from baseline in contract: expected ${baselineValue}, got ${contractValue}`,
      );
    }
    if (envValue !== baselineValue) {
      errors.push(
        `${key} drifted from baseline in .env.example: expected ${baselineValue}, got ${envValue}`,
      );
    }
  }

  if (errors.length > 0) {
    for (const item of errors) {
      console.error(`[check-config-default-drift] ${item}`);
    }
    process.exit(1);
  }
}

main();
