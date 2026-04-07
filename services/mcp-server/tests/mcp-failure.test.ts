// @ts-nocheck
// 
//

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { callToolJson, callToolText, startMcpHarnessAdvanced } from "./helpers/mcp-client.js";
import { startStubBackend } from "./helpers/stub-backend.js";

const fixtureWorkspaceRoot = resolve(import.meta.dirname, "fixtures/workspace");

function createTempWorkspace(prefix: string): string {
  const source = fixtureWorkspaceRoot;
  const temp = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
  cpSync(source, temp, { recursive: true });
  return temp;
}

test("mcp failure paths: allowlist/path/schema/backend error", { timeout: 60_000 }, async () => {
  const backend = await startStubBackend({ commandsStatus: 500 });
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot: fixtureWorkspaceRoot,
    env: {
      UIQ_MCP_API_BASE_URL: backend.baseUrl,
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS: "20",
    },
  });

  try {
    const denied = await callToolText(harness.client, "uiq_read_repo_doc", {
      relativePath: "../secrets.txt",
    });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /(path not allowed|parent path is not allowed)/);

    const deniedCrossPlatformTraversal = await callToolText(harness.client, "uiq_read_repo_doc", {
      relativePath: "docs/..\\..\\secrets.txt",
    });
    assert.equal(deniedCrossPlatformTraversal.isError, true);
    assert.match(
      deniedCrossPlatformTraversal.text,
      /(path traversal blocked|relativePath must use forward slashes)/,
    );

    const missingArtifact = await callToolText(harness.client, "uiq_read_artifact", {
      runId: "run-a",
      relativePath: "reports/not-exists.json",
    });
    assert.equal(missingArtifact.isError, true);
    assert.match(
      missingArtifact.text,
      /(read artifact failed|ENOENT: no such file or directory|ENOENT: path redacted)/,
    );

    const invalidRunStream = await callToolJson<{
      ok: boolean;
      detail: string;
      tool: string;
      reasonCode: string;
    }>(harness.client, "uiq_run_stream", {
      mode: "profile",
      profile: "pr",
    });
    assert.equal(invalidRunStream.isError, true);
    assert.equal(invalidRunStream.data.ok, false);
    assert.equal(invalidRunStream.data.tool, "uiq_run_stream");
    assert.equal(invalidRunStream.data.reasonCode, "INVALID_INPUT");
    assert.match(invalidRunStream.data.detail, /required/);

    const invalidProfileSlug = await callToolText(harness.client, "uiq_run_profile", {
      profile: "../pr",
      target: "web.local",
    });
    assert.equal(invalidProfileSlug.isError, true);
    assert.match(
      invalidProfileSlug.text,
      /(Invalid profile; only \[A-Za-z0-9._-\] are allowed|Invalid profile: path separators or '\.\.' are not allowed)/,
    );

    const invalidTargetSlug = await callToolText(harness.client, "uiq_run_stream", {
      mode: "command",
      command: "capture",
      target: "configs/targets/web.local.yaml",
    });
    assert.equal(invalidTargetSlug.isError, true);
    assert.match(
      invalidTargetSlug.text,
      /(Invalid target; only \[A-Za-z0-9._-\] are allowed|Invalid target: path separators or '\.\.' are not allowed)/,
    );

    const invalidOptionalProfileSlug = await callToolText(harness.client, "uiq_run_command", {
      command: "capture",
      profile: "configs/profiles/pr.yaml",
    });
    assert.equal(invalidOptionalProfileSlug.isError, true);
    assert.match(
      invalidOptionalProfileSlug.text,
      /(Invalid profile; only \[A-Za-z0-9._-\] are allowed|Invalid profile: path separators or '\.\.' are not allowed)/,
    );

    const apiErr = await callToolJson<Record<string, unknown>>(
      harness.client,
      "uiq_api_automation_commands",
    );
    assert.equal(apiErr.isError, true);
  } finally {
    await harness.close();
    await backend.close();
  }
});

test(
  "mcp governed run tools return allowlist reasonCode when workspace is blocked",
  { timeout: 60_000 },
  async () => {
    const backend = await startStubBackend();
    const blockedAllowlistRoot = mkdtempSync(resolve(tmpdir(), "uiq-allowlist-blocked-"));
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot: fixtureWorkspaceRoot,
      env: {
        UIQ_MCP_API_BASE_URL: backend.baseUrl,
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
        UIQ_MCP_WORKSPACE_ALLOWLIST: blockedAllowlistRoot,
      },
    });

    try {
      const blockedCommand = await callToolJson<{ ok: boolean; tool: string; reasonCode: string }>(
        harness.client,
        "uiq_run_command",
        {
          command: "report",
        },
      );
      assert.equal(blockedCommand.isError, true);
      assert.equal(blockedCommand.data.ok, false);
      assert.equal(blockedCommand.data.tool, "uiq_run_command");
      assert.equal(blockedCommand.data.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");

      const blockedStream = await callToolJson<{ ok: boolean; tool: string; reasonCode: string }>(
        harness.client,
        "uiq_run_stream",
        {
          mode: "command",
          command: "report",
        },
      );
      assert.equal(blockedStream.isError, true);
      assert.equal(blockedStream.data.ok, false);
      assert.equal(blockedStream.data.tool, "uiq_run_stream");
      assert.equal(blockedStream.data.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");
    } finally {
      await harness.close();
      await backend.close();
      rmSync(blockedAllowlistRoot, { recursive: true, force: true });
    }
  },
);

test(
  "mcp run_overview falls back to manifest checks and evidence mapping when summary is missing",
  { timeout: 60_000 },
  async () => {
    const workspaceRoot = createTempWorkspace("uiq-mcp-failure-manifest");
    const runId = `run-manifest-fallback-${Date.now()}`;
    const runDir = resolve(workspaceRoot, ".runtime-cache/artifacts/runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, "manifest.json"),
      `${JSON.stringify(
        {
          runId,
          gateResults: {
            status: "failed",
            checks: [
              {
                id: "security.high_vuln",
                status: "failed",
                actual: 3,
                expected: 0,
                reasonCode: "HIGH_VULN_FOUND",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const backend = await startStubBackend();
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_API_BASE_URL: backend.baseUrl, UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });

    try {
      const overview = await callToolJson<{
        ok: boolean;
        gateStatus: string;
        failedChecks: Array<{ id: string; source: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_run_overview", { runId });
      assert.equal(overview.isError, false);
      assert.equal(overview.data.ok, true);
      assert.equal(overview.data.gateStatus, "failed");
      assert.equal(overview.data.failedChecks.length, 1);
      assert.equal(overview.data.failedChecks[0]?.source, "manifest");
      assert.equal(overview.data.failedChecks[0]?.evidencePath, "security/report.json");
    } finally {
      await harness.close();
      await backend.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test(
  "mcp run_overview returns typed error when both manifest and summary are missing",
  { timeout: 60_000 },
  async () => {
    const workspaceRoot = createTempWorkspace("uiq-mcp-failure-missing");
    const runId = `run-missing-artifacts-${Date.now()}`;
    const runDir = resolve(workspaceRoot, ".runtime-cache/artifacts/runs", runId);
    mkdirSync(runDir, { recursive: true });

    const backend = await startStubBackend();
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_API_BASE_URL: backend.baseUrl, UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });

    try {
      const overview = await callToolJson<{ ok: boolean; detail: string }>(
        harness.client,
        "uiq_run_overview",
        { runId },
      );
      assert.equal(overview.isError, true);
      assert.equal(overview.data.ok, false);
      assert.match(overview.data.detail, /run artifacts missing/);
    } finally {
      await harness.close();
      await backend.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("mcp apiRequest timeout/network errors are normalized", { timeout: 60_000 }, async () => {
  const slowBackend = await startStubBackend({ delayMs: 80 });
  const timeoutHarness = await startMcpHarnessAdvanced({
    workspaceRoot: fixtureWorkspaceRoot,
    env: {
      UIQ_MCP_API_BASE_URL: slowBackend.baseUrl,
      UIQ_MCP_API_TIMEOUT_MS: "20",
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
    },
  });

  try {
    const timeoutResp = await callToolJson<Record<string, unknown> | string>(
      timeoutHarness.client,
      "uiq_api_automation_commands",
    );
    assert.equal(timeoutResp.isError, true);
    assert.equal(typeof timeoutResp.data, "string");
    assert.match(String(timeoutResp.data), /request timeout after 20ms/);
  } finally {
    await timeoutHarness.close();
    await slowBackend.close();
  }

  const networkHarness = await startMcpHarnessAdvanced({
    workspaceRoot: fixtureWorkspaceRoot,
    env: {
      UIQ_MCP_API_BASE_URL: "http://127.0.0.1:1",
      UIQ_MCP_API_TIMEOUT_MS: "200",
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
    },
  });

  try {
    const networkResp = await callToolJson<Record<string, unknown> | string>(
      networkHarness.client,
      "uiq_api_automation_commands",
    );
    assert.equal(networkResp.isError, true);
    assert.equal(typeof networkResp.data, "string");
    assert.match(String(networkResp.data), /request failed:/);
  } finally {
    await networkHarness.close();
  }
});

test(
  "mcp automation run currently forwards env payload and backend 404 is returned",
  { timeout: 60_000 },
  async () => {
    const backend = await startStubBackend();
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot: fixtureWorkspaceRoot,
      env: {
        UIQ_MCP_API_BASE_URL: backend.baseUrl,
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      },
    });

    try {
      const strictResp = await callToolText(harness.client, "uiq_api_automation_run", {
        commandId: "script-pipeline-capture",
        env: { BASE_URL: "https://example.com" },
      });
      assert.equal(strictResp.isError, true);
      assert.match(strictResp.text.toLowerCase(), /not found/);
    } finally {
      await harness.close();
      await backend.close();
    }
  },
);
