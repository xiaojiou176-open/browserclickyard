import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Legacy non-mainline validation suite.
// Primary wrapper verification now lives in tests/wrapper-safe-smoke.test.ts.
// Keep this file for deeper Playwright coverage, but do not treat failures here
// as the sole truth for wrapper path/runtime correctness.

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
  shift 2
fi

if [[ "\${1:-}" == "dlx" && "\${2:-}" == "curlconverter" ]]; then
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

if [[ "\${1:-}" == "dlx" && "\${2:-}" == "har-to-k6" ]]; then
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

  writeExecutable(
    path.join(binDir, "uv"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "unexpected uv invocation: $*" >&2
exit 95
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

test.describe("safe wrapper snapshot coverage", () => {
  test("run-curlconverter-safe outputs stable python requests snippet for local curl", async () => {
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedSnapshot);
    expect(result.stdout).toContain("import requests");
    expect(result.stdout).toContain("requests.get('http://127.0.0.1:18080/api/ping')");
  });

  test("run-har-to-k6-safe outputs stable k6 http.get snippet for local HAR", async () => {
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedSnapshot);
    expect(result.stdout).toContain("import http from 'k6/http'");
    expect(result.stdout).toContain("http.get('http://127.0.0.1:18080/health')");
  });

  test("run-curlconverter-safe blocks remote targets by default", async () => {
    const fakeBin = createFakeToolBin();

    const result = runScript(
      path.join("tooling", "automation", "scripts", "run-curlconverter-safe.sh"),
      ["--curl", "curl https://example.com/api", "--", "--language", "python"],
      fakeBin,
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("blocked non-local target 'https://example.com/api'");
  });

  test("run-har-to-k6-safe blocks remote targets from HAR URLs", async () => {
    const fakeBin = createFakeToolBin();
    const remoteHar = path.join(WRAPPER_FIXTURES, "remote-health.har.json");

    const result = runScript(
      path.join("tooling", "automation", "scripts", "run-har-to-k6-safe.sh"),
      ["--input", remoteHar],
      fakeBin,
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("blocked non-local target 'https://example.com/health'");
  });

  test("run-schemathesis-safe blocks remote schema URL before invoking schemathesis", async () => {
    const fakeBin = createFakeToolBin();

    const result = runScript(
      path.join("scripts", "run-schemathesis-safe.sh"),
      ["run", "https://example.com/openapi.json"],
      fakeBin,
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("blocked non-local target 'https://example.com/openapi.json'");
    expect(result.stderr).not.toContain("unexpected uv invocation");
  });
});
