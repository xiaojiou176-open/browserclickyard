// @ts-nocheck
// 
//

import assert from "node:assert/strict";
import test from "node:test";
import { startMcpHarnessAdvanced, startMcpHarnessDefault } from "./helpers/mcp-client.js";

test("advanced tools are hidden by default in tools/list", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessDefault();

  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    assert.ok(
      !names.includes("uiq_run_command"),
      "advanced tool should be hidden by default: uiq_run_command",
    );
    assert.ok(names.includes("uiq_catalog"), "core tool should be visible by default: uiq_catalog");
    assert.ok(
      !names.includes("uiq_read_repo_doc"),
      "advanced tool should be hidden by default: uiq_read_repo_doc",
    );
    assert.ok(
      !names.includes("uiq_a11y_top"),
      "analysis tool should be hidden by default: uiq_a11y_top",
    );
    assert.ok(
      !names.includes("uiq_run_proof_campaign"),
      "proof tool should be hidden by default: uiq_run_proof_campaign",
    );
    assert.ok(
      names.includes("uiq_api_runs"),
      "core tool should still be visible in default mode: uiq_api_runs",
    );
  } finally {
    await harness.close();
  }
});

test(
  "advanced tools are exposed when UIQ_MCP_EXPOSE_ADVANCED_TOOLS=true",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced({
      env: {
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
        UIQ_MCP_ENABLE_ADVANCED_TOOLS: "true",
        UIQ_MCP_PERFECT_MODE: "false",
      },
    });

    try {
      const listed = await harness.client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      assert.ok(
        names.includes("uiq_run_command"),
        "advanced tool should be exposed: uiq_run_command",
      );
      assert.ok(names.includes("uiq_catalog"), "advanced tool should be exposed: uiq_catalog");
      assert.ok(
        names.includes("uiq_read_repo_doc"),
        "advanced tool should be exposed: uiq_read_repo_doc",
      );
      assert.ok(
        names.includes("uiq_api_automation_commands"),
        "advanced tool should be exposed: uiq_api_automation_commands",
      );
      assert.ok(names.includes("uiq_a11y_top"), "analysis tool should be exposed: uiq_a11y_top");
      assert.ok(
        names.includes("uiq_run_proof_campaign"),
        "proof tool should be exposed: uiq_run_proof_campaign",
      );
    } finally {
      await harness.close();
    }
  },
);
