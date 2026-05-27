import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceRepoRoot = resolve(import.meta.dirname, "../..");
const checkScriptPath = resolve(sourceRepoRoot, "scripts/ci/check-runtime-cache-contract.mjs");

function copyIntoFixture(fixtureRoot, relPath, transform = null) {
  const sourcePath = resolve(sourceRepoRoot, relPath);
  const targetPath = resolve(fixtureRoot, relPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  const contents = readFileSync(sourcePath, "utf8");
  writeFileSync(targetPath, transform ? transform(contents) : contents, "utf8");
}

test("check-runtime-cache-contract fails when repo-family fallback drifts", () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "uiq-runtime-contract-"));
  try {
    copyIntoFixture(fixtureRoot, "configs/governance/cache-governance.yaml");
    copyIntoFixture(
      fixtureRoot,
      "configs/governance/runtime-paths.yaml",
      (contents) =>
        contents.replace(
          "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/node-modules",
          "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/node-modules-drifted",
        ),
    );
    copyIntoFixture(fixtureRoot, "docs/reference/runtime-storage-policy.md");
    copyIntoFixture(fixtureRoot, "docs/reference/logging-and-cache-policy.md");
    copyIntoFixture(fixtureRoot, "docs/reference/cache-governance.md");
    copyIntoFixture(fixtureRoot, "docs/reference/runtime-paths.md");
    copyIntoFixture(fixtureRoot, "scripts/lib/node-toolchain.sh");

    for (const relPath of [
      "scripts/runtime-gc.sh",
      "scripts/cleanup-runtime.sh",
      "scripts/backup-runtime.sh",
      "scripts/rollback-runtime.sh",
    ]) {
      const targetPath = resolve(fixtureRoot, relPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, "#!/usr/bin/env bash\n", "utf8");
    }

    mkdirSync(resolve(fixtureRoot, ".runtime-cache"), { recursive: true });
    mkdirSync(resolve(fixtureRoot, "node_modules"), { recursive: true });

    const result = spawnSync("node", [checkScriptPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repo-family fallback drifted/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
