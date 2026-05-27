import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "./check-workflow-runner-governance.mjs";

function createFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "workflow-runner-gov-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  mkdirSync(join(root, ".github/actions/setup-test"), { recursive: true });
  return root;
}

function writeWorkflow(root, name, contents) {
  writeFileSync(join(root, ".github/workflows", name), `${contents.trim()}\n`, "utf8");
}

function writeAction(root, name, contents) {
  writeFileSync(join(root, ".github/actions", name, "action.yml"), `${contents.trim()}\n`, "utf8");
}

function runGovernance(root) {
  return spawnSync(
    process.execPath,
    [resolve("scripts/ci/check-workflow-runner-governance.mjs"), "--root", root],
    { encoding: "utf8" },
  );
}

test("parseArgs resolves custom root", () => {
  const options = parseArgs(["--root", "fixtures/workflows"]);
  assert.ok(options.root.endsWith("fixtures/workflows"));
});

test("governance passes for GitHub-hosted workflows and runner.temp caches", () => {
  const root = createFixtureRoot();
  writeWorkflow(
    root,
    "ci.yml",
    `
name: CI
jobs:
  workflow_lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          clean: true
      - name: Lint
        env:
          PRE_COMMIT_HOME: \${{ runner.temp }}/pre-commit/workflow-lint
        run: echo ok
      - uses: actions/cache@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          path: \${{ runner.temp }}/uiq-pre-commit/workflow-lint
`,
  );
  writeAction(
    root,
    "setup-test",
    `
name: Setup test
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        echo "UV_CACHE_DIR=$RUNNER_TEMP/uv" >> "$GITHUB_ENV"
        echo "PIP_CACHE_DIR=$RUNNER_TEMP/pip" >> "$GITHUB_ENV"
`,
  );

  const result = runGovernance(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workflow runner governance passed/);
});

test("governance fails for self-hosted runner labels, workspace caches, and runner registration commands", () => {
  const root = createFixtureRoot();
  writeWorkflow(
    root,
    "ci.yml",
    `
name: CI
jobs:
  bad_job:
    runs-on: [self-hosted, shared-pool, core01]
    steps:
      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
      - uses: actions/cache@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          path: ~/.cache/ms-playwright
      - name: Bad cache
        env:
          PRE_COMMIT_HOME: \${{ github.workspace }}/.runtime-cache/pre-commit
        run: ./run.sh
`,
  );
  writeAction(
    root,
    "setup-test",
    `
name: Setup test
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        echo "PLAYWRIGHT_BROWSERS_PATH=$GITHUB_WORKSPACE/.runtime-cache/ms-playwright" >> "$GITHUB_ENV"
        echo "TMPDIR=.runtime-cache/tmp" >> "$GITHUB_ENV"
`,
  );

  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /job 'bad_job' must use a GitHub-hosted runner label/);
  assert.match(
    result.stderr,
    /actions\/checkout must declare with\.clean: true explicitly/,
  );
  assert.match(result.stderr, /PRE_COMMIT_HOME must not point into github\.workspace/);
  assert.match(result.stderr, /actions\/cache path must not point to literal ~\/\.cache\/\*/);
  assert.match(result.stderr, /forbidden runner registration command detected: \.\/run\.sh/);
  assert.match(result.stderr, /PLAYWRIGHT_BROWSERS_PATH must not point into github\.workspace/);
  assert.match(result.stderr, /TMPDIR must not use a relative cache path inside the checkout/);
});

test("governance fails for literal tilde pre-commit cache", () => {
  const root = createFixtureRoot();
  writeWorkflow(
    root,
    "ci.yml",
    `
name: CI
jobs:
  bad_job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          clean: true
      - name: Bad cache
        env:
          PRE_COMMIT_HOME: ~/.cache/pre-commit
        run: echo nope
`,
  );

  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not point to literal ~\/\.cache\/pre-commit/);
});

test("governance fails for actions/cache path in workspace or relative checkout paths", () => {
  const root = createFixtureRoot();
  writeWorkflow(
    root,
    "ci.yml",
    `
name: CI
jobs:
  bad_job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          clean: true
      - uses: actions/cache@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
        with:
          path: |
            \${{ github.workspace }}/.runtime-cache/pre-commit
            .runtime-cache/ms-playwright
`,
  );

  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /actions\/cache path must not point into github\.workspace/);
  assert.match(
    result.stderr,
    /actions\/cache path must not use a relative cache path inside the checkout/,
  );
});
