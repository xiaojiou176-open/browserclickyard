import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts/ci/check-access-control-usage.mjs");

function runGuard(cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      UIQ_ACCESS_CONTROL_USAGE_SCAN_ALL: "1",
    },
  });
}

function createFixtureRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const apiDir = path.join(root, "backend", "app", "api");
  mkdirSync(apiDir, { recursive: true });
  return { root, apiDir };
}

test("access-control-usage guard passes when call site is guarded in the same handler", () => {
  const { root, apiDir } = createFixtureRoot("access-guard-pass-");
  writeFileSync(
    path.join(apiDir, "ok.py"),
    [
      "from app.core.access_control import check_token, require_access",
      "def handler(request, token):",
      "    require_access(request, token)",
      "    return check_token(request, token)",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS:/);
});

test("access-control-usage guard fails on forbidden direct security calls", () => {
  const { root, apiDir } = createFixtureRoot("access-guard-fail-");
  writeFileSync(
    path.join(apiDir, "bad.py"),
    [
      "from app.core.access_control import check_token",
      "def handler(request, token):",
      "    return check_token(request, token)",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL:/);
  assert.match(result.stderr, /check_token/);
});

test("access-control-usage guard fails when one call site in same file is unguarded", () => {
  const { root, apiDir } = createFixtureRoot("access-guard-mixed-");
  writeFileSync(
    path.join(apiDir, "mixed.py"),
    [
      "from app.core.access_control import check_token, require_access",
      "def ok_handler(request, token):",
      "    require_access(request, token)",
      "    return check_token(request, token)",
      "",
      "def bad_handler(request, token):",
      "    return check_token(request, token)",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mixed.py:7/);
  assert.match(result.stderr, /check_token/);
});

test("access-control-usage guard fails when guard is after direct call", () => {
  const { root, apiDir } = createFixtureRoot("access-guard-order-");
  writeFileSync(
    path.join(apiDir, "ordered.py"),
    [
      "from app.core.access_control import check_token, require_access",
      "def handler(request, token):",
      "    direct = check_token(request, token)",
      "    require_access(request, token)",
      "    return direct",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ordered.py:3/);
});
