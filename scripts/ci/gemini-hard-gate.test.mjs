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
  const fixtureRoot = mkdtempSync(join(tmpdir(), "gemini-hard-gate-"));
  const scriptsDir = join(fixtureRoot, "scripts", "ci");
  const binDir = join(fixtureRoot, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  cpSync(
    join(repoRoot, "scripts", "ci", "gemini-hard-gate.sh"),
    join(scriptsDir, "gemini-hard-gate.sh"),
  );
  chmodSync(join(scriptsDir, "gemini-hard-gate.sh"), 0o755);
  writeFakePnpm(binDir);
  return { fixtureRoot, binDir };
}

test("parses .env safely and does not execute command substitutions", () => {
  const { fixtureRoot, binDir } = prepareFixture();
  const envFile = join(fixtureRoot, ".env");
  const markerPath = join(fixtureRoot, "pwned-from-env");
  const pnpmLog = join(fixtureRoot, "pnpm.log");

  writeFileSync(
    envFile,
    [
      "SAFE_KEY=safe",
      "BAD-KEY=ignored",
      "MALICIOUS=$(touch ./pwned-from-env)",
      "# comment line",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = spawnSync("bash", [join("scripts", "ci", "gemini-hard-gate.sh")], {
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
  assert.match(readFileSync(pnpmLog, "utf8"), /pnpm env:check/);
});
