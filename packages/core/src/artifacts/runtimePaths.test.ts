import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ensureRunDirectories, sanitizeRunId } from "./runtimePaths.js";

test("sanitizeRunId rejects malicious inputs", () => {
  assert.throws(() => sanitizeRunId(""), /empty value/);
  assert.throws(() => sanitizeRunId(".."), /reserved path segment/);
  assert.throws(() => sanitizeRunId("../../escape"), /only \[A-Za-z0-9._-\] allowed/);
  assert.throws(() => sanitizeRunId("run id"), /only \[A-Za-z0-9._-\] allowed/);
  assert.throws(() => sanitizeRunId("evil;rm"), /only \[A-Za-z0-9._-\] allowed/);
});

test("ensureRunDirectories creates directory within runs root", () => {
  const workDir = mkdtempSync(resolve(tmpdir(), "uiq-runtimepaths-"));
  const oldCwd = process.cwd();
  process.chdir(workDir);
  try {
    const baseDir = ensureRunDirectories("run-safe_1");
    assert.match(baseDir.replace(/\\/g, "/"), /\/\.runtime-cache\/artifacts\/runs\/run-safe_1$/);
  } finally {
    process.chdir(oldCwd);
    rmSync(workDir, { recursive: true, force: true });
  }
});
