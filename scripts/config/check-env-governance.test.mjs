import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "./check-env-governance.mjs";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "env-gov-"));
  const contractPath = join(root, "contract.yaml");
  const reportPath = join(root, "report.json");
  const scanDir = join(root, "scan");
  mkdirSync(scanDir, { recursive: true });
  return { root, contractPath, reportPath, scanDir };
}

function writeContract(path) {
  writeFileSync(
    path,
    [
      "version: 1",
      "description: test contract",
      "allow_undeclared_exact: []",
      "allow_undeclared_prefixes: []",
      "variables:",
      "  - name: DECLARED_OK",
      "    section: tests",
      '    default: ""',
      "    required: false",
      "    sensitive: false",
      "    description: ok",
    ].join("\n"),
    "utf8",
  );
}

test("parseArgs handles governance wrapper options", () => {
  const options = parseArgs([
    "--warn-only",
    "--contract",
    "a.yaml",
    "--report",
    "b.json",
    "--targets",
    "x,y",
  ]);
  assert.equal(options.warnOnly, true);
  assert.equal(options.contractPath, "a.yaml");
  assert.equal(options.reportPath, "b.json");
  assert.deepEqual(options.targets, ["x", "y"]);
});

test("strict mode exits with code 3 when undeclared env is detected", () => {
  const { contractPath, reportPath, scanDir } = createFixture();
  writeContract(contractPath);
  writeFileSync(
    join(scanDir, "index.ts"),
    "const x = process.env." + "UNDECLARED_ENV" + ";\n",
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/config/check-env-governance.mjs"),
      "--contract",
      contractPath,
      "--report",
      reportPath,
      "--targets",
      scanDir,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 3);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.undeclaredCount, 1);
  assert.deepEqual(report.undeclared, ["UNDECLARED_ENV"]);
});

test("warn-only mode exits zero and still writes report", () => {
  const { contractPath, reportPath, scanDir } = createFixture();
  writeContract(contractPath);
  writeFileSync(
    join(scanDir, "index.ts"),
    "const x = process.env." + "UNDECLARED_ENV" + ";\n",
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/config/check-env-governance.mjs"),
      "--warn-only",
      "--contract",
      contractPath,
      "--report",
      reportPath,
      "--targets",
      scanDir,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.undeclaredCount, 1);
  assert.deepEqual(report.undeclared, ["UNDECLARED_ENV"]);
});
