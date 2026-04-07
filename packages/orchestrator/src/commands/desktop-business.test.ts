import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runDesktopBusinessRegression } from "./desktop-business.js";

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), "uiq-desktop-business-"));
  const done = Promise.resolve(fn(dir));
  return done.finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("desktop business regression blocks unsupported target", async () => {
  await withTempDir(async (dir) => {
    const result = await runDesktopBusinessRegression(dir, { targetType: "web" });
    assert.equal(result.status, "blocked");
    assert.equal(result.reasonCode, "desktop.target.unsupported");
    const persisted = JSON.parse(readFileSync(resolve(dir, result.reportPath), "utf8"));
    assert.equal(persisted.reasonCode, "desktop.target.unsupported");
  });
});

test("desktop business regression blocks tauri target without app path", async () => {
  await withTempDir(async (dir) => {
    const result = await runDesktopBusinessRegression(dir, { targetType: "tauri" });
    assert.equal(result.status, "blocked");
    assert.equal(result.reasonCode, "desktop.tauri.app.missing");
    const persisted = JSON.parse(readFileSync(resolve(dir, result.reportPath), "utf8"));
    assert.equal(persisted.reasonCode, "desktop.tauri.app.missing");
  });
});
