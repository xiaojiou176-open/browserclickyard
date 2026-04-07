import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts/ci/uiq-test-truth-gate.mjs");

function runGate(scanPath) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--paths",
      scanPath,
      "--profile",
      "unit",
      "--strict",
      "true",
      "--out-dir",
      ".runtime-cache/artifacts/ci",
    ],
    { encoding: "utf8" },
  );
}

test("truth gate fails on conditional assertion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-conditional-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "conditional.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test('conditional expect should fail gate', async ({ page }) => {",
      "  const enabled = !!page;",
      "  if (enabled) {", // uiq-allow-weak-assertion: fixture source text
      "    expect(enabled).toBe(true);",
      "  }",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    1,
    `expected gate to fail, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate fails on missing await for interaction", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-await-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "missing-await.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test('missing await on click should fail gate', async ({ page }) => {",
      "  page.getByRole('button', { name: '提交' }).click();", // uiq-allow-weak-assertion: fixture source text
      "  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    1,
    `expected gate to fail, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate allows Promise.all interaction pattern", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-promise-all-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "promise-all.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test('Promise.all interaction is allowed', async ({ page }) => {",
      "  await Promise.all([",
      "    page.getByRole('button', { name: '提交' }).click(),",
      "    page.waitForResponse('**/api/submit'),",
      "  ]);",
      "  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    0,
    `expected gate to pass, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate allows deferred await watcher pattern", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-deferred-await-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "deferred-await.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test('deferred await watcher is allowed', async ({ page }) => {",
      "  const responsePromise = page.waitForResponse('**/api/submit');",
      "  await page.getByRole('button', { name: '提交' }).click();",
      "  await responsePromise;",
      "  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    0,
    `expected gate to pass, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate fails on only marker", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-only-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "only.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test.only('only marker should fail gate', async ({ page }) => {",
      "  await page.goto('https://example.com');",
      "  await expect(page).toHaveURL(/example/);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    1,
    `expected gate to fail, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate fails on hard wait timeout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-hard-wait-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "hard-wait.spec.ts"),
    [
      "import { test, expect } from '@playwright/test';",
      "test('hard wait should fail gate', async ({ page }) => {",
      "  await page.goto('https://example.com');",
      "  await page.waitForTimeout(1500);",
      "  await expect(page).toHaveURL(/example/);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    1,
    `expected gate to fail, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});

test("truth gate fails on pytest xfail marker", () => {
  const root = mkdtempSync(path.join(tmpdir(), "truth-gate-xfail-"));
  const testsDir = path.join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    path.join(testsDir, "test_xfail.py"),
    [
      "import pytest",
      "",
      "@pytest.mark.xfail(reason='temporary')",
      "def test_xfail_pattern():",
      "    assert 1 == 1",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = runGate(root);
  assert.equal(
    result.status,
    1,
    `expected gate to fail, stdout=${result.stdout} stderr=${result.stderr}`,
  );
});
