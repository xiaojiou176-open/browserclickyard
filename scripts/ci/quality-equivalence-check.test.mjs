import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function writeFakePnpm(binDir) {
  const fakePnpmPath = join(binDir, "pnpm");
  writeFileSync(
    fakePnpmPath,
    ["#!/usr/bin/env bash", "set -euo pipefail", 'printf \'%s\\n\' "pnpm $*" >> "$PNPM_LOG"'].join(
      "\n",
    ),
    "utf8",
  );
  chmodSync(fakePnpmPath, 0o755);
}

function prepareFixture() {
  const repoRoot = resolve(".");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "quality-equivalence-check-"));
  const scriptsDir = join(fixtureRoot, "scripts", "ci");
  const binDir = join(fixtureRoot, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  cpSync(
    join(repoRoot, "scripts", "ci", "quality-equivalence-check.sh"),
    join(scriptsDir, "quality-equivalence-check.sh"),
  );
  chmodSync(join(scriptsDir, "quality-equivalence-check.sh"), 0o755);
  writeFakePnpm(binDir);
  return { fixtureRoot, binDir };
}

test("parses .env safely and keeps command argument semantics without eval", () => {
  const { fixtureRoot, binDir } = prepareFixture();
  const envFile = join(fixtureRoot, ".env");
  const markerPath = join(fixtureRoot, "pwned-from-env");
  const pnpmLog = join(fixtureRoot, "pnpm.log");

  writeFileSync(
    envFile,
    ["SAFE_KEY=ok", "1BAD=ignored", "MALICIOUS=$(touch ./pwned-from-env)", ""].join("\n"),
    "utf8",
  );

  const result = spawnSync("bash", [join("scripts", "ci", "quality-equivalence-check.sh")], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PNPM_LOG: pnpmLog,
    },
  });

  assert.equal(result.status, 0, `expected success, stderr=${result.stderr}`);
  assert.equal(existsSync(markerPath), false, "env command substitution must not execute");
  const logLines = readFileSync(pnpmLog, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(logLines, [
    "pnpm env:check",
    "pnpm env:governance:check:strict",
    "pnpm ai:check",
    "pnpm gemini-only-policy",
    "pnpm test:automation:routing",
    "pnpm test:orchestrator -- --testNamePattern report",
    "pnpm mcp:smoke",
  ]);

  const currentPath = join(fixtureRoot, ".runtime-cache", "artifacts", "ci-timing", "current.json");
  const diffPath = join(fixtureRoot, ".runtime-cache", "artifacts", "ci-timing", "diff.json");
  assert.equal(existsSync(currentPath), true, "current timing artifact should be generated");
  assert.equal(existsSync(diffPath), true, "diff timing artifact should be generated");

  const current = JSON.parse(readFileSync(currentPath, "utf8"));
  assert.equal(current.suites.length, 7);
  assert.deepEqual(
    current.suites.map((suite) => suite.name),
    [
      "env.check",
      "env.governance.strict",
      "ai.check",
      "gemini.only.policy",
      "automation.routing",
      "orchestrator.report.contract",
      "mcp.smoke",
    ],
  );
  assert.deepEqual(
    current.suites.map((suite) => suite.command),
    [
      "pnpm env:check",
      "pnpm env:governance:check:strict",
      "pnpm ai:check",
      "pnpm gemini-only-policy",
      "pnpm test:automation:routing",
      "pnpm test:orchestrator -- --testNamePattern report",
      "pnpm mcp:smoke",
    ],
  );
  for (const suite of current.suites) {
    assert.equal(suite.status, "passed");
    assert.equal(Number.isInteger(suite.duration_ms), true);
    assert.equal(suite.duration_ms >= 0, true);
  }
});
