#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const CONTRACT_PATH = "configs/env/contract.yaml";
const OWNER_MAP_PATH = "docs/reference/env-owner-map.md";
const CONFIG_DOC_PATH = "docs/reference/configuration.md";
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

function isSafeGitRef(ref) {
  const trimmed = String(ref ?? "").trim();
  if (!trimmed) {
    return false;
  }
  if (!SAFE_GIT_REF_PATTERN.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("-") || trimmed.includes("..") || trimmed.includes("@{")) {
    return false;
  }
  return true;
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function getBaseRef() {
  const fromEnv = process.env.UIQ_ENV_ADMISSION_BASE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) {
    return `origin/${githubBase}`;
  }
  return "origin/main";
}

function readYamlVariables(content) {
  const parsed = YAML.parse(content);
  const variables = Array.isArray(parsed?.variables) ? parsed.variables : [];
  return new Set(
    variables
      .map((item) => String(item?.name ?? "").trim())
      .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name)),
  );
}

function readCurrentContractVars() {
  const content = readFileSync(resolve(CONTRACT_PATH), "utf8");
  return readYamlVariables(content);
}

function readBaseContractVars(baseRef) {
  if (!isSafeGitRef(baseRef)) {
    return null;
  }
  try {
    const content = execFileSync("git", ["show", `${baseRef}:${CONTRACT_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return readYamlVariables(content);
  } catch {
    return null;
  }
}

function hasDocToken(path, variable) {
  const content = readFileSync(resolve(path), "utf8");
  return content.includes(`\`${variable}\``);
}

function hasTestEntry(variable) {
  try {
    const output = execFileSync(
      "rg",
      [
        "-l",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
        "--glob",
        "!configs/env/contract.yaml",
        "--glob",
        "!.env.example",
        "--glob",
        "!docs/reference/configuration.md",
        `\\b${variable}\\b`,
        ".",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return paths.some((path) =>
      /(tests\/|\.test\.|\.spec\.|playwright\.config|scripts\/ci\/|\.github\/workflows\/)/.test(
        path,
      ),
    );
  } catch {
    return false;
  }
}

function main() {
  const strictBaseRef = envTruthy(process.env.CI) || envTruthy(process.env.UIQ_ENV_STRICT_BASE);
  const baseRef = getBaseRef();
  if (!isSafeGitRef(baseRef)) {
    if (strictBaseRef) {
      process.stderr.write(`[env-admission] FAIL: invalid base ref (${baseRef}) in strict mode\n`);
      process.exit(1);
    }
    process.stdout.write(
      `[env-admission] WARN: invalid base ref (${baseRef}), skip admission diff gate\n`,
    );
    process.exit(0);
  }
  const currentVars = readCurrentContractVars();
  const baseVars = readBaseContractVars(baseRef);
  if (!baseVars) {
    if (strictBaseRef) {
      process.stderr.write(
        `[env-admission] FAIL: base ref contract missing (${baseRef}) in strict mode\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `[env-admission] WARN: base ref contract missing (${baseRef}), skip admission diff gate\n`,
    );
    process.exit(0);
  }

  const added = [...currentVars].filter((name) => !baseVars.has(name)).sort();
  if (added.length === 0) {
    process.stdout.write("[env-admission] PASS: no new contract variables\n");
    process.exit(0);
  }

  const failures = [];
  for (const variable of added) {
    const ownerOk = hasDocToken(OWNER_MAP_PATH, variable);
    const docOk = hasDocToken(CONFIG_DOC_PATH, variable);
    const testOk = hasTestEntry(variable);
    if (!ownerOk || !docOk || !testOk) {
      failures.push({
        variable,
        owner: ownerOk,
        doc: docOk,
        testEntry: testOk,
      });
    }
  }

  if (failures.length > 0) {
    process.stderr.write("[env-admission] FAIL: new variables must have owner+doc+test-entry\n");
    for (const row of failures) {
      process.stderr.write(
        `- ${row.variable}: owner=${row.owner ? "ok" : "missing"}, doc=${row.doc ? "ok" : "missing"}, test-entry=${row.testEntry ? "ok" : "missing"}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `[env-admission] PASS: ${added.length} new variables admitted with owner+doc+test-entry\n`,
  );
}

main();
