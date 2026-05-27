// @ts-nocheck
// 
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { __runtimeLockForTests, __runtimeStateForTests } from "../src/core/runtime-manager.js";

async function withRuntimeRoot<T>(fn: (runtimeRoot: string) => Promise<T> | T): Promise<T> {
  const previousCwd = process.cwd();
  const workspaceRoot = mkdtempSync(resolve(tmpdir(), "uiq-runtime-lock-test-"));
  const runtimeRoot = resolve(workspaceRoot, ".runtime-cache/dev");
  process.chdir(workspaceRoot);
  try {
    return await fn(runtimeRoot);
  } finally {
    process.chdir(previousCwd);
  }
}

test("runtime lock is not stale when owner pid is alive even if acquiredAt is old", () =>
  withRuntimeRoot((runtimeRoot) => {
    const lockPath = __runtimeLockForTests.backendRuntimeLockPath();
    mkdirSync(resolve(runtimeRoot), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          action: "test",
          acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          owner: "owner-a",
          processTag: basename(process.argv[1] ?? process.argv[0] ?? "node").toLowerCase(),
        },
        null,
        2,
      ),
      "utf8",
    );
    assert.equal(__runtimeLockForTests.isStaleLock(lockPath), false);
  }));

test("runtime lock is stale when owner pid is alive but process tag mismatches", () =>
  withRuntimeRoot((runtimeRoot) => {
    const lockPath = __runtimeLockForTests.backendRuntimeLockPath();
    mkdirSync(resolve(runtimeRoot), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          action: "test",
          acquiredAt: new Date().toISOString(),
          owner: "owner-mismatch",
          processTag: "definitely-not-a-real-process-tag",
        },
        null,
        2,
      ),
      "utf8",
    );
    assert.equal(__runtimeLockForTests.isStaleLock(lockPath), true);
  }));

test("runtime lock is stale when owner pid is not alive", () =>
  withRuntimeRoot((runtimeRoot) => {
    const lockPath = __runtimeLockForTests.backendRuntimeLockPath();
    mkdirSync(resolve(runtimeRoot), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: 999_999,
          action: "test",
          acquiredAt: new Date().toISOString(),
          owner: "owner-dead",
        },
        null,
        2,
      ),
      "utf8",
    );
    assert.equal(__runtimeLockForTests.isStaleLock(lockPath), true);
  }));

test("runtime lock release only removes lock owned by current holder", async () =>
  withRuntimeRoot(async () => {
    const release = await __runtimeLockForTests.acquireRuntimeLock("owner-check");
    const lockPath = __runtimeLockForTests.backendRuntimeLockPath();
    const before = __runtimeLockForTests.parseRuntimeLockRecord(lockPath);
    assert.ok(before);

    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          action: "other-owner",
          acquiredAt: new Date().toISOString(),
          owner: "other-owner-token",
        },
        null,
        2,
      ),
      "utf8",
    );
    release();
    assert.equal(existsSync(lockPath), true);
  }));

test("runtime state parser self-heals corrupted state file", () =>
  withRuntimeRoot(() => {
    const statePath = __runtimeStateForTests.backendRuntimeStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{bad json", "utf8");
    const state = __runtimeStateForTests.readBackendRuntimeState();
    assert.equal(state, null);
    assert.equal(existsSync(statePath), false);
  }));

test("runtime state parser self-heals structurally invalid state file", () =>
  withRuntimeRoot(() => {
    const statePath = __runtimeStateForTests.backendRuntimeStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ pid: "oops", port: 18080 }, null, 2), "utf8");
    const state = __runtimeStateForTests.readBackendRuntimeState();
    assert.equal(state, null);
    assert.equal(existsSync(statePath), false);
  }));

test("runtime preferred port validator rejects invalid env values", () => {
  const previous = process.env.UIQ_MCP_BACKEND_PORT;
  process.env.UIQ_MCP_BACKEND_PORT = "not-a-number";
  try {
    const invalid = __runtimeStateForTests.resolvePreferredBackendPort();
    assert.equal(invalid.ok, false);

    process.env.UIQ_MCP_BACKEND_PORT = "18080";
    const valid = __runtimeStateForTests.resolvePreferredBackendPort();
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.port, 18080);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.UIQ_MCP_BACKEND_PORT;
    } else {
      process.env.UIQ_MCP_BACKEND_PORT = previous;
    }
  }
});
