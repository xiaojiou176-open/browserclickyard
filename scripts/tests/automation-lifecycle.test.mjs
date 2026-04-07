import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function runLifecycle(args) {
  return spawnSync("bash", [resolve("scripts/automation-lifecycle.sh"), ...args], {
    encoding: "utf8",
  });
}

test("automation lifecycle generates non-hardcoded password by default", () => {
  const cycleId = `test-${randomUUID()}`;
  const result = runLifecycle(["--cycle-id", cycleId, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);

  const seedPath = resolve(".runtime-cache/automation/lifecycle", cycleId, "seed.json");
  const payload = JSON.parse(readFileSync(seedPath, "utf8"));
  assert.equal(typeof payload.password, "string");
  assert.ok(payload.password.length > 0);
  assert.notEqual(payload.password, "ReplayPass!123");
});

test("automation lifecycle accepts explicit seed password", () => {
  const cycleId = `test-explicit-${randomUUID()}`;
  const password = "CustomSeedPass!456";
  const result = runLifecycle(["--cycle-id", cycleId, "--seed-password", password, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);

  const seedPath = resolve(".runtime-cache/automation/lifecycle", cycleId, "seed.json");
  const payload = JSON.parse(readFileSync(seedPath, "utf8"));
  assert.equal(payload.password, password);
});
