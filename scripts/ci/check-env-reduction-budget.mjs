#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASELINE_PATH = resolve("configs/env/reduction-baseline.json");
const REPORT_PATH = resolve(".runtime-cache/artifacts/config/env-reduction-report.json");

function fail(message) {
  process.stderr.write(`[env-reduction-budget] ERROR: ${message}\n`);
  process.exit(1);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const baseline = loadJson(BASELINE_PATH);
  const report = loadJson(REPORT_PATH);

  const budgets = baseline?.budgets ?? {};
  const totals = report?.totals ?? {};

  const checks = [
    [
      "declared",
      Number(totals.declared ?? 0),
      Number(budgets.declared_max ?? Number.POSITIVE_INFINITY),
    ],
    [
      "declaredButUnused",
      Number(totals.declaredButUnused ?? 0),
      Number(budgets.declared_but_unused_max ?? Number.POSITIVE_INFINITY),
    ],
    [
      "usedButUndeclared",
      Number(totals.usedButUndeclared ?? 0),
      Number(budgets.used_but_undeclared_max ?? Number.POSITIVE_INFINITY),
    ],
    [
      "deprecatedAliases",
      Number(totals.deprecatedAliases ?? 0),
      Number(budgets.deprecated_aliases_max ?? Number.POSITIVE_INFINITY),
    ],
  ];

  const failures = checks.filter(([, current, max]) => current > max);
  if (failures.length > 0) {
    for (const [name, current, max] of failures) {
      process.stderr.write(`[env-reduction-budget] ${name}: current=${current}, max=${max}\n`);
    }
    fail("env reduction budgets exceeded");
  }

  process.stdout.write(
    `[env-reduction-budget] PASS declared=${totals.declared}, declaredButUnused=${totals.declaredButUnused}, usedButUndeclared=${totals.usedButUndeclared}, deprecatedAliases=${totals.deprecatedAliases}\n`,
  );
}

main();
