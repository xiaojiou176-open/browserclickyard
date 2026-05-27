#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const CONTRACT_PATH = "configs/env/contract.yaml";
const POLICY_PATH = "configs/env/maintenance-policy.json";
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

function countVars(content) {
  const parsed = YAML.parse(content);
  const variables = Array.isArray(parsed?.variables) ? parsed.variables : [];
  const set = new Set(
    variables
      .map((item) => String(item?.name ?? "").trim())
      .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name)),
  );
  return set.size;
}

function main() {
  const strictBaseRef = envTruthy(process.env.CI) || envTruthy(process.env.UIQ_ENV_STRICT_BASE);
  const baseRef = getBaseRef();
  if (!isSafeGitRef(baseRef)) {
    if (strictBaseRef) {
      process.stderr.write(
        `[env-deletion-budget] FAIL: invalid base ref (${baseRef}) in strict mode\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `[env-deletion-budget] WARN: invalid base ref (${baseRef}), skip deletion budget gate\n`,
    );
    return;
  }
  const policy = JSON.parse(readFileSync(resolve(POLICY_PATH), "utf8"));
  const minDrop = Number(policy?.rules?.min_declared_drop_when_contract_changes ?? 1);

  let changed = false;
  try {
    changed =
      execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`, "--", CONTRACT_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean).length > 0;
  } catch {
    if (strictBaseRef) {
      process.stderr.write(
        `[env-deletion-budget] FAIL: base ref missing/unreadable for diff (${baseRef}) in strict mode\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `[env-deletion-budget] WARN: base ref missing/unreadable for diff (${baseRef}), skip\n`,
    );
    return;
  }

  if (!changed) {
    process.stdout.write("[env-deletion-budget] PASS: contract unchanged, budget check skipped\n");
    return;
  }

  let baseContent = "";
  try {
    baseContent = execFileSync("git", ["show", `${baseRef}:${CONTRACT_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    if (strictBaseRef) {
      process.stderr.write(
        `[env-deletion-budget] FAIL: base contract missing (${baseRef}) in strict mode\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`[env-deletion-budget] WARN: base contract missing (${baseRef}), skip\n`);
    return;
  }
  const currentContent = readFileSync(resolve(CONTRACT_PATH), "utf8");
  const baseCount = countVars(baseContent);
  const currentCount = countVars(currentContent);
  const drop = baseCount - currentCount;

  if (drop < minDrop) {
    process.stderr.write(
      `[env-deletion-budget] FAIL: contract changed but declared drop=${drop}, required>=${minDrop} (base=${baseCount}, current=${currentCount})\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[env-deletion-budget] PASS: base=${baseCount}, current=${currentCount}, drop=${drop}, required>=${minDrop}\n`,
  );
}

main();
