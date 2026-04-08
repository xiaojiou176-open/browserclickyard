import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(import.meta.dirname, "..");
const entry = resolve(packageRoot, "dist/server.js");
const coreEntry = resolve(packageRoot, "dist/core.js");
const typesEntry = resolve(packageRoot, "dist/core.d.ts");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

await access(entry);
await access(coreEntry);
await access(typesEntry);

assert.equal(
  packageJson.name,
  "@uiq/mcp-server",
  "package smoke expects the scoped package name to stay @uiq/mcp-server",
);
assert.equal(
  packageJson.bin?.["prooflane-mcp"],
  "./dist/server.js",
  "package smoke expects prooflane-mcp to resolve to ./dist/server.js",
);

let child;
let stderr = "";

function waitForExit(processHandle) {
  if (
    !processHandle ||
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null
  ) {
    return Promise.resolve();
  }
  return new Promise((resolveWait) => {
    processHandle.once("exit", resolveWait);
  });
}

try {
  child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      UIQ_MCP_PERFECT_MODE: process.env.UIQ_MCP_PERFECT_MODE ?? "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await new Promise((resolveWait) => setTimeout(resolveWait, 500));

  assert.equal(
    child.exitCode,
    null,
    `prooflane-mcp should remain alive after startup, got exitCode=${child.exitCode}, stderr=${stderr}`,
  );

  child.kill("SIGTERM");
  await waitForExit(child);

  if (/\[mcp-server\] startup failed:/i.test(stderr)) {
    throw new Error(stderr.trim());
  }

  process.stdout.write("[mcp-package-smoke] PASS\n");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await waitForExit(child);
  await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
}
