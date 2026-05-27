import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceRepoRoot = resolve(import.meta.dirname, "../..");
const checkScriptPath = resolve(sourceRepoRoot, "scripts/ci/check-deep-english-purity.mjs");

function writeFixtureFile(root, relPath, contents) {
  const targetPath = resolve(root, relPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${contents.trim()}\n`, "utf8");
}

function createFixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "uiq-deep-english-"));
  writeFixtureFile(root, "apps/command-center/src/_placeholder.ts", 'export const shell = "english only";');
  writeFixtureFile(root, "tests/frontend-e2e/placeholder.spec.ts", 'export const e2eLabel = "english only";');
  writeFixtureFile(root, "docs/reference/runtime-paths.md", "# Runtime paths\n");
  writeFixtureFile(root, "docs/reference/dependency-governance.md", "# Dependency governance\n");
  writeFixtureFile(root, "configs/governance/runtime-paths.yaml", "runtime_paths: []\n");
  return root;
}

function runGate(root) {
  return spawnSync(process.execPath, [checkScriptPath], {
    cwd: root,
    encoding: "utf8",
  });
}

function normalizeSeparators(value) {
  return value.replaceAll("\\", "/");
}

test("deep-water gate allows explicit bilingual command-center shell surfaces", () => {
  const root = createFixtureRoot();
  try {
    writeFixtureFile(
      root,
      "apps/command-center/src/views/TaskCenterView.tsx",
      `
      import { pickUiText } from "../i18n/uiLocale";
      export const shellCopy = pickUiText("zh-CN", "Manual Gate inbox", "人工闸门收件箱");
      `,
    );

    const result = runGate(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deep-water gate still rejects Han text in non-allowlisted deep-water files", () => {
  const root = createFixtureRoot();
  try {
    writeFixtureFile(
      root,
      "docs/reference/runtime-paths.md",
      `
      # Runtime paths
      这里不应该出现中文。
      `,
    );

    const result = runGate(root);
    assert.equal(result.status, 1);
    assert.match(normalizeSeparators(result.stderr), /docs\/reference\/runtime-paths\.md/);
    assert.match(result.stderr, /\[check-deep-english-purity\] FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
