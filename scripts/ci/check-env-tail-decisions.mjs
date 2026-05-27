#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const REPORT_PATH = resolve(".runtime-cache/artifacts/config/env-reduction-report.json");
const DECISIONS_PATH = resolve("configs/env/tail-decisions.yaml");

function fail(message) {
  process.stderr.write(`[env-tail-decisions] FAIL: ${message}\n`);
  process.exit(1);
}

function main() {
  if (!existsSync(REPORT_PATH)) {
    process.stdout.write(
      `[env-tail-decisions] PASS skipped: report not found (${REPORT_PATH}); run env:governance:reduction before enforcing tail decisions\n`,
    );
    return;
  }

  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  const total = Number(report?.totals?.declaredButUnused ?? 0);
  const top = Array.isArray(report?.declaredButUnusedTop) ? report.declaredButUnusedTop : [];
  if (total > top.length) {
    fail(
      `declaredButUnused=${total} exceeds declaredButUnusedTop=${top.length}; increase report depth before enforcing`,
    );
  }

  const decisionDoc = YAML.parse(readFileSync(DECISIONS_PATH, "utf8")) ?? {};
  const decisions = decisionDoc.decisions ?? {};

  const required = top.map((item) => String(item.name));
  const missing = required.filter((name) => !decisions[name]);
  if (missing.length > 0) {
    fail(`missing decisions for: ${missing.join(", ")}`);
  }

  const invalid = [];
  for (const name of required) {
    const row = decisions[name] ?? {};
    const action = String(row.action ?? "").trim();
    const owner = String(row.owner ?? "").trim();
    const reason = String(row.reason ?? "").trim();
    const doc = String(row.doc_anchor ?? "").trim();
    const testEntry = String(row.test_entry ?? "").trim();
    if (!["keep", "remove"].includes(action) || !owner || !reason || !doc || !testEntry) {
      invalid.push(name);
    }
  }
  if (invalid.length > 0) {
    fail(`invalid decision schema for: ${invalid.join(", ")}`);
  }

  process.stdout.write(`[env-tail-decisions] PASS tracked=${required.length}\n`);
}

main();
