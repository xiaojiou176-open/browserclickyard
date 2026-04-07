#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPORT_PATH = resolve(".runtime-cache/artifacts/config/env-reduction-report.json");
const HISTORY_PATH = resolve("configs/env/reduction-history.json");

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  const history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  const samples = Array.isArray(history?.samples) ? history.samples : [];

  const current = {
    date: todayUtc(),
    declared: Number(report?.totals?.declared ?? 0),
    declaredButUnused: Number(report?.totals?.declaredButUnused ?? 0),
    usedButUndeclared: Number(report?.totals?.usedButUndeclared ?? 0),
    deprecatedAliases: Number(report?.totals?.deprecatedAliases ?? 0),
  };

  const index = samples.findIndex((item) => item?.date === current.date);
  if (index >= 0) {
    samples[index] = current;
  } else {
    samples.push(current);
  }
  samples.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const next = {
    version: Number(history?.version ?? 1),
    updated_at: todayUtc(),
    samples,
  };
  writeFileSync(HISTORY_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  process.stdout.write(`[env-trend] updated history samples=${samples.length}\n`);
}

main();
