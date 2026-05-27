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

test(
  "mcp success paths: catalog/selfcheck/doc/runs/overview/gate/artifact",
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
      const listed = await harness.client.listTools();
      const names = listed.tools.map((t) => t.name);
      assert.ok(names.includes("uiq_catalog"));
      assert.ok(names.includes("uiq_run_overview"));
      assert.ok(names.includes("uiq_gate_failures"));
      assert.ok(names.includes("uiq_read_artifact"));

      const catalog = await callToolJson<{
        profiles: string[];
        targets: string[];
        commands: string[];
        commandDescriptions: Record<string, string>;
        backendBaseUrl: string;
        tokenConfigured: boolean;
      }>(harness.client, "uiq_catalog");
      assert.equal(catalog.isError, false);
      assert.ok(catalog.data.profiles.includes("pr"));
      assert.ok(catalog.data.targets.includes("web.local"));
      assert.deepEqual(catalog.data.commands, [
        "run",
        "capture",
        "explore",
        "chaos",
        "a11y",
        "perf",
        "visual",
        "e2e",
        "load",
        "security",
        "computer-use",
        "desktop-readiness",
        "desktop-e2e",
        "desktop-business",
        "desktop-soak",
        "engines:check",
        "report",
      ]);
      assert.match(catalog.data.commandDescriptions["computer-use"] ?? "", /computer-use/);
      assert.equal(catalog.data.backendBaseUrl, backend.baseUrl);

      const selfcheck = await callToolJson<{
        ok: boolean;
        checks: Array<{ name: string; ok: boolean }>;
      }>(harness.client, "uiq_server_selfcheck");
      assert.equal(selfcheck.isError, false);
      assert.equal(selfcheck.data.ok, true);
      assert.ok(selfcheck.data.checks.some((c) => c.name === "backend_health" && c.ok === true));

      const doc = await callToolText(harness.client, "uiq_read_repo_doc", {
        relativePath: "docs/hello.md",
      });
      assert.equal(doc.isError, false);
      assert.match(doc.text, /fixture doc/);

      const runs = await callToolJson<{ runs: string[] }>(harness.client, "uiq_list_runs", {
        limit: 10,
      });
      assert.equal(runs.isError, false);
      assert.ok(runs.data.runs.includes("run-a"));

      const overview = await callToolJson<{
        ok: boolean;
        gateStatus: string;
        failedChecks: Array<{ id: string; source: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_run_overview", { runId: "run-a" });
      assert.equal(overview.isError, false);
      assert.equal(overview.data.ok, true);
      assert.equal(overview.data.gateStatus, "failed");
      assert.ok(
        overview.data.failedChecks.some(
          (c) => c.id === "a11y" && c.source === "summary" && c.evidencePath === "a11y/axe.json",
        ),
      );

      const gateFailures = await callToolJson<{
        gateStatus: string;
        failedChecks: Array<{ id: string; source: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_gate_failures", { runId: "run-a" });
      assert.equal(gateFailures.isError, false);
      assert.equal(gateFailures.data.gateStatus, "failed");
      assert.ok(
        gateFailures.data.failedChecks.some(
          (c) => c.id === "a11y" && c.evidencePath === "a11y/axe.json",
        ),
      );

      const artifact = await callToolText(harness.client, "uiq_read_artifact", {
        runId: "run-a",
        relativePath: "a11y/axe.json",
      });
      assert.equal(artifact.isError, false);
      assert.match(artifact.text, /"violations": 2/);

      const perfDelta = await callToolJson<{
        runA: string;
        runB: string;
        deltas: Record<string, unknown>;
      }>(harness.client, "uiq_compare_perf", {
        runIdA: "run-a",
        runIdB: "run-b",
      });
      assert.equal(perfDelta.isError, false);
      assert.equal(perfDelta.data.runA, "run-a");
      assert.equal(perfDelta.data.runB, "run-b");
      assert.ok("fcp" in perfDelta.data.deltas);
      assert.ok("lcp" in perfDelta.data.deltas);

      const aiReview = await callToolJson<{
        run_id: string;
        enabled: boolean;
      }>(harness.client, "uiq_read_run_ai_review", {
        runId: "run-1",
      });
      assert.equal(aiReview.isError, false);
      assert.equal(aiReview.data.run_id, "run-1");
      assert.equal(aiReview.data.enabled, true);

      const releaseBrief = await callToolJson<{
        run_id: string;
        recommendation: string;
      }>(harness.client, "uiq_generate_release_brief", {
        runId: "run-1",
      });
      assert.equal(releaseBrief.isError, false);
      assert.equal(releaseBrief.data.run_id, "run-1");
      assert.equal(releaseBrief.data.recommendation, "review-ready");

      const similarFailures = await callToolJson<{
        run_id: string;
        matches: Array<{ run_id: string }>;
      }>(harness.client, "uiq_find_similar_failures", {
        runId: "run-1",
        limit: 5,
      });
      assert.equal(similarFailures.isError, false);
      assert.equal(similarFailures.data.run_id, "run-1");
      assert.equal(similarFailures.data.matches[0]?.run_id, "run-near");

      const feasibility = await callToolJson<{
        supported: boolean;
        explanation: string;
      }>(harness.client, "uiq_explain_template_feasibility", {
        templateId: "template-1",
        target: "swift.macos",
      });
      assert.equal(feasibility.isError, false);
      assert.equal(feasibility.data.supported, false);
      assert.match(feasibility.data.explanation, /Not ready|Supported/);

      const manualGates = await callToolJson<{
        totalWaiting: number;
        runs: Array<{ run_id: string }>;
      }>(harness.client, "uiq_list_manual_gates", {
        limit: 20,
      });
      assert.equal(manualGates.isError, false);
      assert.equal(manualGates.data.totalWaiting, 1);
      assert.equal(manualGates.data.runs[0]?.run_id, "run-1");
    } finally {
      await harness.close();
      await backend.close();
    }
  },
);

test(
  "mcp success paths: manifest-first checks include source and fallback evidencePath",
  { timeout: 60_000 },
  async () => {
    const workspaceRoot = createTempWorkspace("uiq-mcp-success");
    const runId = `run-manifest-only-${Date.now()}`;
    const runDir = resolve(workspaceRoot, ".runtime-cache/artifacts/runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, "manifest.json"),
      `${JSON.stringify({ runId, gateResults: { status: "failed", checks: [{ id: "security", status: "blocked", reasonCode: "MISSING_TOKEN" }] } }, null, 2)}\n`,
      "utf8",
    );

    const backend = await startStubBackend();
    const harness = await startMcpHarnessAdvanced({
      workspaceRoot,
      env: { UIQ_MCP_API_BASE_URL: backend.baseUrl, UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
    });

    try {
      const overview = await callToolJson<{
        gateStatus: string;
        failedChecks: Array<{ source: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_run_overview", { runId });
      assert.equal(overview.isError, false);
      assert.equal(overview.data.gateStatus, "failed");
      assert.equal(overview.data.failedChecks[0]?.source, "manifest");
      assert.equal(overview.data.failedChecks[0]?.evidencePath, "security/report.json");

      const gateFailures = await callToolJson<{
        failedChecks: Array<{ source: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_gate_failures", { runId });
      assert.equal(gateFailures.isError, false);
      assert.equal(gateFailures.data.failedChecks[0]?.source, "manifest");
      assert.equal(gateFailures.data.failedChecks[0]?.evidencePath, "security/report.json");
    } finally {
      await harness.close();
      await backend.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test(
  "mcp success paths: canonical check ids fallback to evidence artifacts",
  { timeout: 60_000 },
  async () => {
    const workspaceRoot = createTempWorkspace("uiq-mcp-canonical");
    const runId = `run-canonical-${Date.now()}`;
    const runDir = resolve(workspaceRoot, ".runtime-cache/artifacts/runs", runId);
    mkdirSync(resolve(runDir, "reports"), { recursive: true });
    writeFileSync(
      resolve(runDir, "manifest.json"),
      `${JSON.stringify({ runId, gateResults: { status: "failed" } }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      resolve(runDir, "reports/summary.json"),
      `${JSON.stringify(
        {
          status: "failed",
          checks: [
            { id: "a11y.serious_max", status: "failed", actual: 2, expected: 0 },
            { id: "perf.lcp_ms_max", status: "failed", actual: 5100, expected: 4000 },
            { id: "load.failed_requests", status: "failed", actual: 3, expected: 0 },
            { id: "load.p95_ms", status: "failed", actual: 320, expected: 250 },
            { id: "load.rps_min", status: "failed", actual: 4, expected: 10 },
            { id: "explore.under_explored", status: "blocked", actual: 1, expected: 2 },
            { id: "a11y.engine_ready", status: "blocked", actual: "builtin", expected: "axe" },
            { id: "perf.engine_ready", status: "blocked", actual: "builtin", expected: "lhci" },
            { id: "visual.baseline_ready", status: "blocked", actual: false, expected: true },
            { id: "visual.diff_pixels_max", status: "failed", actual: 128, expected: 0 },
          ],
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

    const expectedById = new Map<string, string>([
      ["a11y.serious_max", "a11y/axe.json"],
      ["perf.lcp_ms_max", "perf/lighthouse.json"],
      ["load.failed_requests", "metrics/load-summary.json"],
      ["load.p95_ms", "metrics/load-summary.json"],
      ["load.rps_min", "metrics/load-summary.json"],
      ["explore.under_explored", "explore/report.json"],
      ["a11y.engine_ready", "a11y/axe.json"],
      ["perf.engine_ready", "perf/lighthouse.json"],
      ["visual.baseline_ready", "visual/report.json"],
      ["visual.diff_pixels_max", "visual/report.json"],
    ]);

    try {
      const overview = await callToolJson<{
        failedChecks: Array<{ id: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_run_overview", { runId });
      assert.equal(overview.isError, false);
      for (const check of overview.data.failedChecks) {
        assert.equal(check.evidencePath, expectedById.get(check.id) ?? null);
      }

      const gateFailures = await callToolJson<{
        failedChecks: Array<{ id: string; evidencePath: string | null }>;
      }>(harness.client, "uiq_gate_failures", { runId });
      assert.equal(gateFailures.isError, false);
      for (const check of gateFailures.data.failedChecks) {
        assert.equal(check.evidencePath, expectedById.get(check.id) ?? null);
      }
    } finally {
      await harness.close();
      await backend.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("mcp register_orchestrate mode alias: midscene maps to ai", { timeout: 60_000 }, async () => {
  const backend = await startStubBackend();
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot: fixtureWorkspaceRoot,
    env: { UIQ_MCP_API_BASE_URL: backend.baseUrl, UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true" },
  });

  try {
    const listed = await harness.client.listTools();
    const hasRegisterOrchestrate = listed.tools.some(
      (tool) => tool.name === "uiq_register_orchestrate",
    );
    if (!hasRegisterOrchestrate) {
      return;
    }

    const fromMidscene = await callToolJson<{
      ok: boolean;
      preparedSession: { mode: string | null; start_url: string | null };
    }>(harness.client, "uiq_register_orchestrate", {
      action: "prepare",
      startUrl: "https://target.example/register",
      mode: "midscene",
    });
    assert.equal(fromMidscene.isError, false);
    assert.equal(fromMidscene.data.preparedSession.mode, "ai");

    const fromManual = await callToolJson<{
      ok: boolean;
      preparedSession: { mode: string | null; start_url: string | null };
    }>(harness.client, "uiq_register_orchestrate", {
      action: "prepare",
      startUrl: "https://target.example/register",
      mode: "manual",
    });
    assert.equal(fromManual.isError, false);
    assert.equal(fromManual.data.preparedSession.mode, "manual");
  } finally {
    await harness.close();
    await backend.close();
  }
});
