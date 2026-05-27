import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(AUTOMATION_ROOT, "..", "..");
const WRAPPER_FIXTURES = path.join(AUTOMATION_ROOT, "tests", "fixtures", "wrappers");
const SNAPSHOT_FIXTURES = path.join(AUTOMATION_ROOT, "tests", "fixtures", "snapshots");

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf-8");
  chmodSync(filePath, 0o755);
}

function createFakeToolBin(): string {
  const binDir = path.join(
    os.tmpdir(),
    `uiq-wrapper-bin-${randomUUID()}`,
  );
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "--dir" ]]; then
  target_dir="\${2:-}"
  if [[ "$target_dir" != *"/tooling/automation" ]]; then
    echo "unexpected pnpm --dir target: $target_dir" >&2
    exit 89
  fi
  shift 2
fi

if [[ "\${1:-}" == "exec" && "\${2:-}" == "curlconverter" ]]; then
  payload="$(cat)"
  if [[ "$payload" != *"http://127.0.0.1:18080/api/ping"* ]]; then
    echo "unexpected curl payload" >&2
    exit 91
  fi
  cat <<'OUT'
import requests

response = requests.get('http://127.0.0.1:18080/api/ping')
OUT
  exit 0
fi

if [[ "\${1:-}" == "exec" && "\${2:-}" == "har-to-k6" ]]; then
  input="\${3:-}"
  if [[ -z "$input" || ! -f "$input" ]]; then
    echo "missing har input" >&2
    exit 92
  fi
  if ! grep -q "127.0.0.1:18080/health" "$input"; then
    echo "unexpected har content" >&2
    exit 93
  fi
  cat <<'OUT'
import http from "k6/http";

export default function () {
  http.get("http://127.0.0.1:18080/health");
}
OUT
  exit 0
fi

echo "unexpected pnpm args: $*" >&2
exit 90
`,
  );

  return binDir;
}

function runScript(scriptPath: string, args: string[], prependPath?: string): RunResult {
  const envPath = prependPath ? `${prependPath}:${process.env.PATH ?? ""}` : process.env.PATH;
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: envPath,
    },
    encoding: "utf-8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("run-curlconverter-safe outputs stable python requests snippet for local curl", () => {
  const fakeBin = createFakeToolBin();
  const inputFile = path.join(WRAPPER_FIXTURES, "local-ping.curl.txt");
  const expectedSnapshot = readFileSync(
    path.join(SNAPSHOT_FIXTURES, "curlconverter-python.txt"),
    "utf-8",
  ).trim();

  const result = runScript(
    path.join("tooling", "automation", "scripts", "run-curlconverter-safe.sh"),
    ["--input", inputFile, "--", "--language", "python"],
    fakeBin,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedSnapshot);
  assert.match(result.stdout, /import requests/);
  assert.match(result.stdout, /requests\.get\('http:\/\/127\.0\.0\.1:18080\/api\/ping'\)/);
});

test("run-har-to-k6-safe outputs stable k6 snippet for local HAR", () => {
  const fakeBin = createFakeToolBin();
  const inputFile = path.join(WRAPPER_FIXTURES, "local-health.har.json");
  const expectedSnapshot = readFileSync(
    path.join(SNAPSHOT_FIXTURES, "har-to-k6-local.js"),
    "utf-8",
  ).trim();

  const result = runScript(
    path.join("tooling", "automation", "scripts", "run-har-to-k6-safe.sh"),
    ["--input", inputFile],
    fakeBin,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedSnapshot);
  assert.match(result.stdout, /import http from "k6\/http";/);
  assert.match(result.stdout, /http\.get\("http:\/\/127\.0\.0\.1:18080\/health"\);/);
});

test("run-curlconverter-safe blocks remote targets by default", () => {
  const fakeBin = createFakeToolBin();

  const result = runScript(
    path.join("tooling", "automation", "scripts", "run-curlconverter-safe.sh"),
    ["--curl", "curl https://example.com/api", "--", "--language", "python"],
    fakeBin,
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /blocked non-local target 'https:\/\/example\.com\/api'/);
});

test("run-har-to-k6-safe blocks remote targets from HAR URLs", () => {
  const fakeBin = createFakeToolBin();
  const remoteHar = path.join(WRAPPER_FIXTURES, "remote-health.har.json");

  const result = runScript(
    path.join("tooling", "automation", "scripts", "run-har-to-k6-safe.sh"),
    ["--input", remoteHar],
    fakeBin,
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /blocked non-local target 'https:\/\/example\.com\/health'/);
});
