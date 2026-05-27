import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { loadYamlFile } from "./loadYaml.js";

test("loadYamlFile blocks path traversal and symlink escape", () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "uiq-loadyaml-"));
  const repoRoot = resolve(tempRoot, "repo");
  const oldCwd = process.cwd();

  mkdirSync(resolve(repoRoot, "configs"), { recursive: true });
  writeFileSync(resolve(repoRoot, "configs/ok.yaml"), "name: ok\n", "utf8");
  writeFileSync(resolve(tempRoot, "outside.yaml"), "name: outside\n", "utf8");
  symlinkSync(resolve(tempRoot, "outside.yaml"), resolve(repoRoot, "configs/leak.yaml"));

  process.chdir(repoRoot);
  try {
    const loaded = loadYamlFile<{ name: string }>("configs/ok.yaml");
    assert.equal(loaded.name, "ok");

    assert.throws(() => loadYamlFile("../outside.yaml"), /Path traversal blocked/);
    assert.throws(() => loadYamlFile(resolve(tempRoot, "outside.yaml")), /Path traversal blocked/);
    assert.throws(() => loadYamlFile("configs/leak.yaml"), /Path traversal blocked/);
  } finally {
    process.chdir(oldCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
