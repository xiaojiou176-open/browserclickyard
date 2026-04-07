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

test("final-verdict gate uses strict mode and avoids string shell execution", () => {
  const script = readFileSync("scripts/acceptance/final-verdict-gate.sh", "utf8");
  assert.match(script, /set -euo pipefail/);
  assert.doesNotMatch(script, /\bbash -lc\b/);
});

test("justfile keeps strict shell and quoted passthrough args", () => {
  const justfile = readFileSync("justfile", "utf8");
  assert.match(justfile, /set shell := \["bash", "-euo", "pipefail", "-c"\]/);
  assert.match(justfile, /run-register-flow\.sh "\{\{mode\}\}" "\{\{flow\}\}"/);
  assert.match(justfile, /rollback-runtime\.sh "\{\{backup_file\}\}"/);
});

test("verify-desktop-soak treats bundle id as data and prevents command substitution", () => {
  const repoRoot = resolve(".");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "verify-desktop-soak-"));
  const scriptsDir = join(fixtureRoot, "scripts");
  const scriptsLibDir = join(scriptsDir, "lib");
  const binDir = join(fixtureRoot, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(scriptsLibDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  cpSync(
    join(repoRoot, "scripts", "verify-desktop-soak.sh"),
    join(scriptsDir, "verify-desktop-soak.sh"),
  );
  cpSync(join(repoRoot, "scripts", "lib", "heartbeat.sh"), join(scriptsLibDir, "heartbeat.sh"));
  chmodSync(join(scriptsDir, "verify-desktop-soak.sh"), 0o755);
  writeFakePnpm(binDir);

  const markerPath = join(fixtureRoot, "pwned-from-bundle-id");
  const pnpmLog = join(fixtureRoot, "pnpm.log");
  const maliciousBundleId = "$(touch ./pwned-from-bundle-id)";
  const result = spawnSync("bash", [join("scripts", "verify-desktop-soak.sh")], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PNPM_LOG: pnpmLog,
      RUN_ID_PREFIX: "test",
      SWIFT_BUNDLE_ID: maliciousBundleId,
    },
  });

  assert.equal(result.status, 0, `expected success, stderr=${result.stderr}`);
  assert.equal(existsSync(markerPath), false, "bundle-id command substitution must not execute");
  const log = readFileSync(pnpmLog, "utf8");
  assert.match(log, /--bundle-id \$\(touch \.\/pwned-from-bundle-id\)/);
});
