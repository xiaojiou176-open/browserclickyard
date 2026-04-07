// @ts-nocheck
// 
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { startMcpHarnessAdvanced, startMcpHarnessDefault } from "./helpers/mcp-client.js";

const workspaceRoot = resolve(import.meta.dirname, "fixtures/workspace");

function createTempWorkspace(prefix: string): string {
  const temp = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
  cpSync(workspaceRoot, temp, { recursive: true });
  return temp;
}

const DEFAULT_TOOL_NAMES = [
  "uiq_catalog",
  "uiq_server_selfcheck",
  "uiq_run_profile",
  "uiq_run_stream",
  "uiq_run_overview",
  "uiq_read_artifact",
  "uiq_gate_failures",
  "uiq_backend_runtime",
  "uiq_api_sessions",
  "uiq_api_flows",
  "uiq_api_runs",
  "uiq_api_templates",
] as const;

const ADVANCED_ONLY_TOOL_NAMES = [
  "uiq_register_orchestrate",
  "uiq_register_state",
  "uiq_api_automation_commands",
  "uiq_api_automation_tasks",
  "uiq_api_automation_task",
  "uiq_api_automation_run",
  "uiq_api_automation_cancel",
  "uiq_run_command",
  "uiq_computer_use_run",
  "uiq_summarize_failures",
  "uiq_a11y_top",
  "uiq_perf_metrics",
  "uiq_visual_status",
  "uiq_security_summary",
  "uiq_compare_perf",
  "uiq_read_repo_doc",
  "uiq_read_manifest",
  "uiq_list_runs",
  "uiq_model_target_capabilities",
  "uiq_run_proof_campaign",
  "uiq_read_proof_report",
  "uiq_export_proof_bundle",
  "uiq_diff_proof_campaign",
  "uiq_read_run_ai_review",
  "uiq_generate_release_brief",
  "uiq_find_similar_failures",
  "uiq_explain_template_feasibility",
  "uiq_list_manual_gates",
] as const;

test("mcp default mode listTools: exact default catalog", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessDefault({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false" },
  });
  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [...DEFAULT_TOOL_NAMES].sort();
    assert.equal(names.length, expected.length);
    assert.deepEqual(names, expected);
  } finally {
    await harness.close();
  }
});

test(
  "mcp advanced mode listTools: default tools + advanced extensions",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });
    try {
      const listed = await harness.client.listTools();
      const names = listed.tools.map((t) => t.name);
      for (const coreName of DEFAULT_TOOL_NAMES) {
        assert.ok(names.includes(coreName), `missing default tool in advanced mode: ${coreName}`);
      }
      for (const advancedName of ADVANCED_ONLY_TOOL_NAMES) {
        assert.ok(names.includes(advancedName), `missing advanced tool: ${advancedName}`);
      }
    } finally {
      await harness.close();
    }
  },
);

test("mcp default mode hides advanced-only tools", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessDefault({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false" },
  });
  try {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ADVANCED_ONLY_TOOL_NAMES) {
      assert.equal(
        names.includes(name),
        false,
        `default mode should not expose advanced tool: ${name}`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("mcp resources expose latest manifest, summary, release brief, and manual-gate inbox", { timeout: 30_000 }, async () => {
  const harness = await startMcpHarnessDefault({
    workspaceRoot,
    env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false" },
  });
  try {
    const listed = await harness.client.listResources();
    const uris = listed.resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, [
      "uiq://manual-gates/inbox-summary",
      "uiq://review/latest-release-brief",
      "uiq://runs/latest/manifest",
      "uiq://runs/latest/summary",
    ]);

    const manifest = await harness.client.readResource({ uri: "uiq://runs/latest/manifest" });
    const summary = await harness.client.readResource({ uri: "uiq://runs/latest/summary" });
    const releaseBrief = await harness.client.readResource({ uri: "uiq://review/latest-release-brief" });
    const manualGates = await harness.client.readResource({ uri: "uiq://manual-gates/inbox-summary" });

    const manifestText =
      manifest.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
    const summaryText =
      summary.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
    const releaseBriefText =
      releaseBrief.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
    const manualGatesText =
      manualGates.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
    assert.match(manifestText, /"runId": "run-b"/);
    assert.match(summaryText, /"status": "success"/);
    assert.match(releaseBriefText, /"recommendation": "review-ready"/);
    assert.match(manualGatesText, /"totalWaiting": 1/);
  } finally {
    await harness.close();
  }
});

test(
  "mcp resources redact sensitive fields from latest manifest/summary",
  { timeout: 30_000 },
  async () => {
    const tempWorkspace = createTempWorkspace("uiq-mcp-resource-redaction");
    const runId = `run-resource-redaction-${Date.now()}`;
    const runDir = resolve(tempWorkspace, ".runtime-cache/artifacts/runs", runId);
    mkdirSync(resolve(runDir, "reports"), { recursive: true });
    writeFileSync(
      resolve(runDir, "manifest.json"),
      `${JSON.stringify(
        {
          runId,
          auth: {
            accessToken: "top-secret-token",
            password: "pw-xyz", // pragma: allowlist secret
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      resolve(runDir, "reports/summary.json"),
      `${JSON.stringify(
        {
          status: "failed",
          checks: [
            {
              id: "security",
              status: "failed",
              actual: "X-API-Key: abc-123",
              expected: "none",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const harness = await startMcpHarnessDefault({
      workspaceRoot: tempWorkspace,
      env: { UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false" },
    });

    try {
      const manifest = await harness.client.readResource({ uri: "uiq://runs/latest/manifest" });
      const summary = await harness.client.readResource({ uri: "uiq://runs/latest/summary" });
      const manifestText =
        manifest.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
      const summaryText =
        summary.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
      assert.match(manifestText, /\[REDACTED\]/);
      assert.doesNotMatch(manifestText, /top-secret-token|pw-xyz/);
      assert.match(summaryText, /\[REDACTED\]/);
      assert.doesNotMatch(summaryText, /abc-123/);
    } finally {
      await harness.close();
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
  },
);

test(
  "mcp resources enforce governed workspace allowlist with redacted detail",
  { timeout: 30_000 },
  async () => {
    const tempWorkspace = createTempWorkspace("uiq-mcp-resource-allowlist");
    const allowlistPath = mkdtempSync(resolve(tmpdir(), "uiq-mcp-resource-allowlist-deny-"));
    const harness = await startMcpHarnessDefault({
      workspaceRoot: tempWorkspace,
      env: {
        UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false",
        UIQ_MCP_WORKSPACE_ALLOWLIST: allowlistPath,
      },
    });
    try {
      const manifest = await harness.client.readResource({ uri: "uiq://runs/latest/manifest" });
      const text =
        manifest.contents.find((c): c is { uri: string; text: string } => "text" in c)?.text ?? "";
      const payload = JSON.parse(text) as { ok: boolean; reasonCode?: string; detail?: string };
      assert.equal(payload.ok, false);
      assert.equal(payload.reasonCode, "WORKSPACE_NOT_ALLOWLISTED");
      assert.equal(payload.detail?.includes(allowlistPath), false);
      assert.equal(payload.detail?.includes(tempWorkspace), false);
    } finally {
      await harness.close();
      rmSync(tempWorkspace, { recursive: true, force: true });
      rmSync(allowlistPath, { recursive: true, force: true });
    }
  },
);
