// @ts-nocheck
// 
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { safeResolveUnder } from "../src/core/io.js";
import {
  callToolJson,
  callToolText,
  startMcpHarnessAdvanced,
  startMcpHarnessDefault,
} from "./helpers/mcp-client.js";

const workspaceRoot = resolve(import.meta.dirname, "fixtures/workspace");

function createTempWorkspace(prefix: string): string {
  const temp = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
  cpSync(workspaceRoot, temp, { recursive: true });
  return temp;
}

test("default mode keeps advanced api tools hidden", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessDefault({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false" },
  });
  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.includes("uiq_api_automation_commands"), false);
    assert.equal(names.includes("uiq_run_command"), false);
  } finally {
    await harness.close();
  }
});

test("advanced mode exposes automation api wrappers", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot,
    env: {
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS: "100",
    },
  });
  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.includes("uiq_api_automation_commands"), true);
    assert.equal(names.includes("uiq_run_command"), true);
    assert.equal(names.includes("uiq_read_repo_doc"), true);
  } finally {
    await harness.close();
  }
});

test("uiq_run_command rejects malicious runId", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
  });
  try {
    const res = await callToolText(harness.client, "uiq_run_command", {
      command: "report",
      runId: "../../escape",
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /(Invalid runId|uiq_run_command failed)/i);
  } finally {
    await harness.close();
  }
});

test("read entrypoints reject path traversal payloads", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot,
    env: {
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS: "100",
    },
  });
  try {
    const assertTraversalBlocked = (
      relativePath: string,
      res: { isError: boolean; text: string },
    ) => {
      assert.equal(res.isError, true);
      const hasHardBlockMessage =
        /(path traversal blocked|path not allowed|parent path is not allowed|relativePath must use forward slashes|Invalid artifact path)/i.test(
          res.text,
        );
      assert.equal(
        hasHardBlockMessage,
        true,
        `expected traversal rejection evidence for "${relativePath}", got: ${res.text}`,
      );
      assert.doesNotMatch(
        res.text,
        /ENOENT|no such file/i,
        `traversal payload "${relativePath}" must not be masked as ENOENT`,
      );
    };

    const repoDocPayloads = ["../package.json", "..%2fpackage.json", "..\\package.json"];

    for (const relativePath of repoDocPayloads) {
      const readDoc = await callToolText(harness.client, "uiq_read_repo_doc", { relativePath });
      assertTraversalBlocked(relativePath, readDoc);
    }

    const artifactPayloads = [
      "../../manifest.json",
      "..%2f..%2fmanifest.json",
      "..\\..\\manifest.json",
    ];

    for (const relativePath of artifactPayloads) {
      const readArtifact = await callToolText(harness.client, "uiq_read_artifact", {
        runId: "run-a",
        relativePath,
      });
      assertTraversalBlocked(relativePath, readArtifact);
    }
  } finally {
    await harness.close();
  }
});

test("uiq_read_repo_doc blocks symlink escape into non-allowlisted repo paths", async () => {
  const secretDir = resolve(workspaceRoot, ".runtime-cache/private");
  const secretPath = resolve(secretDir, "secret.txt");
  const docsDir = resolve(workspaceRoot, "docs");
  const symlinkPath = resolve(workspaceRoot, "docs/leak.txt");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(secretPath, "TOKEN=super-secret-value", "utf8");
  try {
    rmSync(symlinkPath, { force: true });
    symlinkSync(secretPath, symlinkPath);
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });
    try {
      const res = await callToolText(harness.client, "uiq_read_repo_doc", {
        relativePath: "docs/leak.txt",
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /(path not allowed|path traversal blocked)/i);
      assert.doesNotMatch(res.text, /super-secret-value/);
    } finally {
      await harness.close();
    }
  } finally {
    rmSync(symlinkPath, { force: true });
    rmSync(secretPath, { force: true });
  }
});

test("safeResolveUnder blocks missing leaf under symlinked parent that escapes root", () => {
  const tempWorkspace = createTempWorkspace("uiq-mcp-safe-resolve");
  const root = resolve(tempWorkspace, "docs");
  const privateDir = resolve(tempWorkspace, ".runtime-cache/private-missing-leaf");
  const symlinkDir = resolve(root, "link-out");
  mkdirSync(privateDir, { recursive: true });
  try {
    symlinkSync(privateDir, symlinkDir);
    assert.throws(() => safeResolveUnder(root, "link-out/new-file.txt"), /path traversal blocked/i);
  } finally {
    rmSync(tempWorkspace, { force: true, recursive: true });
  }
});

test("uiq_read_manifest returns seeded run artifact", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
  });
  try {
    const manifest = await callToolText(harness.client, "uiq_read_manifest", { runId: "run-a" });
    assert.equal(manifest.isError, false);
    assert.match(manifest.text, /"runId": "run-a"/);
  } finally {
    await harness.close();
  }
});

test("uiq_read_manifest redacts sensitive tokens", { timeout: 30_000 }, async () => {
  const runId = "run-redaction";
  const runDir = resolve(workspaceRoot, ".runtime-cache/artifacts/runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    resolve(runDir, "manifest.json"),
    JSON.stringify(
      {
        runId,
        secrets: {
          token: "super-secret-token",
          password: "pw-123", // pragma: allowlist secret
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
  });
  try {
    const manifest = await callToolText(harness.client, "uiq_read_manifest", { runId });
    assert.equal(manifest.isError, false);
    assert.match(manifest.text, /\[REDACTED\]/);
    assert.doesNotMatch(manifest.text, /super-secret-token/);
    assert.doesNotMatch(manifest.text, /pw-123/);
  } finally {
    await harness.close();
    rmSync(runDir, { force: true, recursive: true });
  }
});

test(
  "governance blocks uiq_read_artifact when workspace is not allowlisted",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: {
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
        UIQ_MCP_WORKSPACE_ALLOWLIST: "/tmp",
      },
    });
    try {
      const response = await callToolJson<{ ok: boolean; tool: string; reasonCode: string }>(
        harness.client,
        "uiq_read_artifact",
        {
          runId: "run-a",
          relativePath: "manifest.json",
        },
      );
      assert.equal(response.isError, true);
      assert.equal(response.data.ok, false);
      assert.equal(response.data.tool, "uiq_read_artifact");
      assert.equal(response.data.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");
    } finally {
      await harness.close();
    }
  },
);

test(
  "governance blocks uiq_read_repo_doc when workspace is not allowlisted",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: {
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
        UIQ_MCP_WORKSPACE_ALLOWLIST: "/tmp",
      },
    });
    try {
      const response = await callToolJson<{ ok: boolean; tool: string; reasonCode: string }>(
        harness.client,
        "uiq_read_repo_doc",
        { relativePath: "README.md" },
      );
      assert.equal(response.isError, true);
      assert.equal(response.data.ok, false);
      assert.equal(response.data.tool, "uiq_read_repo_doc");
      assert.equal(response.data.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");
    } finally {
      await harness.close();
    }
  },
);

test(
  "governance blocks uiq_computer_use_run when workspace is not allowlisted",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: {
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
        UIQ_MCP_WORKSPACE_ALLOWLIST: "/tmp",
      },
    });
    try {
      const response = await callToolJson<{ ok: boolean; tool: string; reasonCode: string }>(
        harness.client,
        "uiq_computer_use_run",
        {
          task: "open homepage",
        },
      );
      assert.equal(response.isError, true);
      assert.equal(response.data.ok, false);
      assert.equal(response.data.tool, "uiq_computer_use_run");
      assert.equal(response.data.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");
    } finally {
      await harness.close();
    }
  },
);
