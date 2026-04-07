#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const REQUIRED_GEMINI_VARIABLES = [
  "AI_PROVIDER",
  "AI_SPEED_MODE",
  "GEMINI_MODEL",
  "GEMINI_FAST_MODEL",
  "GEMINI_EMBEDDING_MODEL",
  "GEMINI_THINKING_LEVEL",
];

const FORBIDDEN_CONTRACT_PREFIXES = ["OPENAI_"];

function parseArgs(argv) {
  const options = {
    contractPath: "configs/env/contract.yaml",
    outputPath: ".env.example",
    check: false,
    stdout: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--contract" && next) {
      options.contractPath = next;
      i += 1;
      continue;
    }
    if (token === "--output" && next) {
      options.outputPath = next;
      i += 1;
      continue;
    }
    if (token === "--check") {
      options.check = true;
      continue;
    }
    if (token === "--stdout") {
      options.stdout = true;
    }
  }
  return options;
}

function assertValidContract(contract) {
  if (!contract || typeof contract !== "object") {
    throw new Error("invalid contract file: expected object root");
  }
  if (!Array.isArray(contract.variables) || contract.variables.length === 0) {
    throw new Error("invalid contract file: variables must be a non-empty array");
  }
  const seen = new Set();
  for (const item of contract.variables) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid contract variable entry");
    }
    const name = String(item.name || "").trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid variable name: '${item.name ?? ""}'`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate variable name in contract: ${name}`);
    }
    if (FORBIDDEN_CONTRACT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`forbidden variable prefix in contract: ${name}`);
    }
    seen.add(name);
  }
  for (const required of REQUIRED_GEMINI_VARIABLES) {
    if (!seen.has(required)) {
      throw new Error(`missing required Gemini variable in contract: ${required}`);
    }
  }
}

function normalizeDefault(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(value);
}

function toSectionTitle(section) {
  return section
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderEnvExample(contract, contractPath) {
  const lines = [];
  lines.push("# Generated file. Do not edit directly.");
  lines.push(`# Source: ${contractPath}`);
  lines.push("# Regenerate: pnpm env:contract:generate");
  lines.push("# Validate : pnpm env:contract:check");
  lines.push("");

  let currentSection = "";
  for (const variable of contract.variables) {
    const section = String(variable.section || "misc").trim() || "misc";
    if (section !== currentSection) {
      if (currentSection) {
        lines.push("");
      }
      currentSection = section;
      lines.push(`# [${section}] ${toSectionTitle(section)}`);
    }
    const description = String(variable.description || "").trim();
    if (description) {
      lines.push(`# ${description}`);
    }
    const required = variable.required === true ? "required" : "optional";
    const sensitive = variable.sensitive === true ? "sensitive" : "non-sensitive";
    lines.push(`# policy: ${required}, ${sensitive}`);
    lines.push(`${variable.name}=${normalizeDefault(variable.default)}`);
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const contractPath = resolve(options.contractPath);
  const outputPath = resolve(options.outputPath);

  const contract = YAML.parse(readFileSync(contractPath, "utf8"));
  assertValidContract(contract);
  const rendered = renderEnvExample(contract, options.contractPath);

  if (options.stdout) {
    process.stdout.write(rendered);
    return;
  }

  if (options.check) {
    const current = readFileSync(outputPath, "utf8");
    if (current !== rendered) {
      process.exit(2);
    }
    return;
  }

  writeFileSync(outputPath, rendered, "utf8");
}

main();
