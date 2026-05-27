// @ts-nocheck
// 
//

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { startStubBackend } from "./stub-backend.js";

function createJsonSchemaValidator(): AjvJsonSchemaValidator {
  // The SDK default validator path is what currently crashes in this local
  // tsx-backed harness. Build the same Ajv-backed validator explicitly so the
  // smoke tests still exercise real schema validation after the client starts.
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  return new AjvJsonSchemaValidator(ajv);
}

export type McpHarness = {
  client: Client;
  close: () => Promise<void>;
};

export const CORE_TOOL_NAMES = [
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
  "uiq_api_templates",
  "uiq_api_runs",
] as const;

export const ADVANCED_TOOL_NAMES = [
  "uiq_register_orchestrate",
  "uiq_register_state",
  "uiq_api_automation_commands",
  "uiq_api_automation_tasks",
  "uiq_api_automation_task",
  "uiq_api_automation_run",
  "uiq_api_automation_cancel",
  "uiq_run_command",
  "uiq_computer_use_run",
  "uiq_list_runs",
  "uiq_read_manifest",
  "uiq_read_repo_doc",
  "uiq_summarize_failures",
  "uiq_a11y_top",
  "uiq_perf_metrics",
  "uiq_visual_status",
  "uiq_security_summary",
  "uiq_compare_perf",
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

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedRuntimeFixtures(workspaceRoot: string): void {
  const runsRoot = resolve(workspaceRoot, ".runtime-cache/artifacts/runs");
  const runARoot = resolve(runsRoot, "run-a");
  const runBRoot = resolve(runsRoot, "run-b");
  const logsRoot = resolve(workspaceRoot, ".runtime-cache/logs");
  const binRoot = resolve(workspaceRoot, ".runtime-cache/bin");
  mkdirSync(resolve(runARoot, "reports"), { recursive: true });
  mkdirSync(resolve(runARoot, "a11y"), { recursive: true });
  mkdirSync(resolve(runARoot, "perf"), { recursive: true });
  mkdirSync(resolve(runARoot, "visual"), { recursive: true });
  mkdirSync(resolve(runARoot, "security"), { recursive: true });
  mkdirSync(resolve(runARoot, "metrics"), { recursive: true });
  mkdirSync(resolve(runBRoot, "perf"), { recursive: true });
  mkdirSync(resolve(runBRoot, "reports"), { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(
    resolve(binRoot, "uiq"),
    `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
if [[ "$cmd" == "sleep-forever" ]]; then
  while true; do sleep 1; done
fi
if [[ "$cmd" == "fail-now" ]]; then
  echo "forced failure" >&2
  exit 17
fi
echo "runId=run-a"
echo "manifest=.runtime-cache/artifacts/runs/run-a/manifest.json"
`,
    { encoding: "utf8", mode: 0o755 },
  );

  writeJsonFile(resolve(runARoot, "manifest.json"), {
    runId: "run-a",
    gateResults: { status: "failed" },
  });
  writeJsonFile(resolve(runARoot, "reports/summary.json"), {
    status: "failed",
    checks: [
      { id: "a11y", status: "failed", actual: 2, expected: 0, reasonCode: "VIOLATIONS_FOUND" },
      {
        id: "performance",
        status: "blocked",
        actual: 1.2,
        expected: 1.0,
        reasonCode: "BUDGET_EXCEEDED",
      },
    ],
  });
  writeJsonFile(resolve(runARoot, "a11y/axe.json"), {
    counts: { violations: 2 },
    issues: [
      {
        id: "a11y-color-contrast",
        severity: "serious",
        message: "contrast ratio too low",
        selector: "#hero-title",
      },
      {
        id: "a11y-label",
        severity: "moderate",
        message: "form control missing label",
        selector: "#email",
      },
    ],
    scannedAt: "2026-02-19T00:00:00.000Z",
  });
  writeJsonFile(resolve(runARoot, "perf/lighthouse.json"), {
    engine: "lhci",
    preset: "desktop",
    metrics: { fcp: 1.2, lcp: 1.8 },
    measuredAt: "2026-02-19T00:00:00.000Z",
    fallbackUsed: false,
    deterministic: { seed: 1 },
  });
  writeJsonFile(resolve(runARoot, "visual/report.json"), {
    mode: "diff",
    diffPixels: 124,
    totalPixels: 100000,
    diffRatio: 0.00124,
    baselineCreated: false,
    baselinePath: "baseline.png",
    currentPath: "current.png",
    diffPath: "diff.png",
  });
  writeJsonFile(resolve(runARoot, "security/report.json"), {
    status: "warn",
    findings: [{ id: "sec-1" }],
  });
  writeJsonFile(resolve(runARoot, "metrics/security-tickets.json"), [
    { ticketId: "SEC-101" },
    { ticketId: "SEC-102" },
  ]);
  writeJsonFile(resolve(runBRoot, "perf/lighthouse.json"), {
    engine: "lhci",
    preset: "desktop",
    metrics: { fcp: 1.0, lcp: 1.6 },
    measuredAt: "2026-02-19T00:00:00.000Z",
    fallbackUsed: false,
    deterministic: { seed: 1 },
  });
  writeJsonFile(resolve(runBRoot, "manifest.json"), {
    runId: "run-b",
    gateResults: { status: "success" },
  });
  writeJsonFile(resolve(runBRoot, "reports/summary.json"), {
    status: "success",
    checks: [],
  });
}

export async function startMcpHarness(options?: {
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<McpHarness> {
  const repoRoot = resolve(import.meta.dirname, "../../../../");
  const workspaceRoot =
    options?.workspaceRoot ?? resolve(repoRoot, "services/mcp-server/tests/fixtures/workspace");
  seedRuntimeFixtures(workspaceRoot);
  const stubBackend =
    options?.env?.UIQ_MCP_API_BASE_URL || process.env.UIQ_MCP_API_BASE_URL
      ? null
      : await startStubBackend();
  const transport = new StdioClientTransport({
    command: "bash",
    args: [resolve(repoRoot, "scripts/lib/node-bin.sh"), "tsx", resolve(repoRoot, "services/mcp-server/src/server.ts")],
    cwd: workspaceRoot,
    stderr: "pipe",
    env: {
      ...process.env,
      ...(stubBackend ? { UIQ_MCP_API_BASE_URL: stubBackend.baseUrl } : {}),
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS:
        options?.env?.UIQ_MCP_GOVERN_RATE_LIMIT_CALLS ??
        process.env.UIQ_MCP_GOVERN_RATE_LIMIT_CALLS ??
        "20",
      UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS:
        options?.env?.UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS ??
        process.env.UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS ??
        "60",
      ...(options?.env ?? {}),
    },
  });

  const client = new Client(
    { name: "uiq-mcp-test", version: "0.1.0" },
    {
      capabilities: {},
      jsonSchemaValidator: createJsonSchemaValidator(),
    },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Preserve original connect failure; close failure is secondary cleanup noise.
    }
    throw error;
  }

  return {
    client,
    close: async () => {
      await transport.close();
      await stubBackend?.close();
    },
  };
}

export async function startMcpHarnessDefault(options?: {
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<McpHarness> {
  return startMcpHarness({
    ...options,
    env: {
      ...(options?.env ?? {}),
      UIQ_MCP_PERFECT_MODE: "false",
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: "false",
    },
  });
}

export async function startMcpHarnessAdvanced(options?: {
  workspaceRoot?: string;
  env?: Record<string, string | undefined>;
}): Promise<McpHarness> {
  return startMcpHarness({
    ...options,
    env: {
      ...(options?.env ?? {}),
      UIQ_MCP_PERFECT_MODE: "false",
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: "true",
    },
  });
}

export async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const textPart = res.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return {
    text: textPart?.text ?? "",
    isError: Boolean(res.isError),
  };
}

export async function callToolJson<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: T; isError: boolean }> {
  const { text, isError } = await callToolText(client, name, args);
  return {
    data: JSON.parse(text) as T,
    isError,
  };
}
