// @ts-nocheck
// 
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { callToolText, startMcpHarnessAdvanced } from "./helpers/mcp-client.js";
import { startStubBackend } from "./helpers/stub-backend.js";

test("mcp auth paths: missing/wrong/correct token", { timeout: 60_000 }, async () => {
  const backend = await startStubBackend({ requireToken: true, acceptedToken: "token-1" });
  try {
    const workspaceRoot = resolve(import.meta.dirname, "fixtures/workspace");

    const noTokenHarness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_API_BASE_URL: backend.baseUrl, UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });
    try {
      const noToken = await callToolText(noTokenHarness.client, "uiq_api_automation_commands");
      assert.equal(noToken.isError, true);
      assert.match(noToken.text, /invalid automation token/);
    } finally {
      await noTokenHarness.close();
    }

    const wrongHarness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: {
        UIQ_MCP_API_BASE_URL: backend.baseUrl,
        AUTOMATION_API_TOKEN: "wrong",
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      },
    });
    try {
      const wrong = await callToolText(wrongHarness.client, "uiq_api_automation_commands");
      assert.equal(wrong.isError, true);
      assert.match(wrong.text, /invalid automation token/);
    } finally {
      await wrongHarness.close();
    }

    const okHarness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: {
        UIQ_MCP_API_BASE_URL: backend.baseUrl,
        AUTOMATION_API_TOKEN: "token-1",
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
      },
    });
    try {
      const ok = await callToolText(okHarness.client, "uiq_api_automation_commands");
      assert.equal(ok.isError, false);
      assert.match(ok.text, /"commands"/);
    } finally {
      await okHarness.close();
    }
  } finally {
    await backend.close();
  }
});
