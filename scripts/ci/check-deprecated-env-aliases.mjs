#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const POLICY_PATH = resolve("configs/env/tier-policy.yaml");
const BASELINE_PATH = resolve("configs/env/deprecated-alias-baseline.json");
const ROOT = resolve(".");

const ALLOWED_PATH_PREFIXES = [
  "tooling/automation/load/",
  "scripts/lib/live-key-preflight.mjs",
  "configs/env/tier-policy.yaml",
  ".env.example",
  "tooling/automation/.env.example",
  "docs/reference/configuration.md",
  "configs/env/contract.yaml",
];

const SCAN_TARGETS = ["backend", "frontend", "apps", "packages", "automation", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".runtime-cache", "dist", "build", "coverage"]);
const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".md",
  ".yaml",
  ".yml",
  ".json",
]);

function extname(path) {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx) : "";
}

function isAllowedPath(relPath) {
  return ALLOWED_PATH_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix));
}

function walk(path, out) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walk(resolve(path, entry.name), out);
    }
    return;
  }
  if (!st.isFile()) {
    return;
  }
  if (!TEXT_EXTS.has(extname(path))) {
    return;
  }
  out.push(path);
}

function main() {
  const policy = YAML.parse(readFileSync(POLICY_PATH, "utf8"));
  const aliases = Object.keys(policy?.deprecated_aliases ?? {});
  if (aliases.length === 0) {
    process.stdout.write("[deprecated-env-aliases] no aliases configured\n");
    process.exit(0);
  }

  const files = [];
  for (const target of SCAN_TARGETS) {
    walk(resolve(ROOT, target), files);
  }

  const violations = [];
  for (const file of files) {
    const relPath = relative(ROOT, file).replace(/\\/g, "/");
    if (isAllowedPath(relPath)) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    for (const alias of aliases) {
      const pattern = new RegExp(`\\b${alias}\\b`);
      if (pattern.test(content)) {
        violations.push(`${relPath}: ${alias}`);
      }
    }
  }

  let baseline = { allowed_legacy_usages: [] };
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    // no baseline, handled below
  }
  const allowedLegacy = new Set((baseline.allowed_legacy_usages ?? []).map((item) => String(item)));
  const newlyIntroduced = violations.filter((item) => !allowedLegacy.has(item));

  if (newlyIntroduced.length > 0) {
    process.stderr.write(
      "[deprecated-env-aliases] Newly introduced deprecated alias usage detected:\n",
    );
    for (const line of newlyIntroduced) {
      process.stderr.write(`- ${line}\n`);
    }
    process.stderr.write(
      `[deprecated-env-aliases] tip: if this is intentional legacy migration, update ${BASELINE_PATH} with explicit review.\n`,
    );
    process.exit(1);
  }

  const cleaned = [...allowedLegacy].filter((item) => !violations.includes(item));
  process.stdout.write(
    `[deprecated-env-aliases] PASS aliases=${aliases.length} active_legacy=${violations.length} cleaned_since_baseline=${cleaned.length}\n`,
  );
}

main();
