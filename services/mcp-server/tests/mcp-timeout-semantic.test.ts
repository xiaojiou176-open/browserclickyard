// @ts-nocheck
// 
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { __governanceForTests, withGovernedExecution } from "../src/core/governance.js";
import { callToolJson, startMcpHarnessAdvanced } from "./helpers/mcp-client.js";

const GOVERNANCE_ENV_KEYS = [
  "UIQ_MCP_GOVERN_RATE_LIMIT_CALLS",
  "UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS",
  "UIQ_MCP_GOVERN_TIMEOUT_MS",
  "UIQ_MCP_GOVERN_SESSION_BUDGET_MS",
] as const;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function withGovernanceEnv(
  overrides: Partial<Record<(typeof GOVERNANCE_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of GOVERNANCE_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const key of GOVERNANCE_ENV_KEYS) {
      const value = overrides[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    __governanceForTests.resetState();
  }
}

test("mcp timeout + semantic parsing", { timeout: 60_000 }, async () => {
  const harness = await startMcpHarnessAdvanced({
    workspaceRoot: resolve(import.meta.dirname, "fixtures/workspace"),
    env: {
      UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
    },
  });

  try {
    const timeoutRun = await callToolJson<{
      ok: boolean;
      detail: string;
      tool: string;
      reasonCode: string;
    }>(harness.client, "uiq_run_stream", {
      mode: "command",
      command: "sleep-forever",
      timeoutMs: 50,
    });
    assert.equal(timeoutRun.isError, true);
    assert.equal(timeoutRun.data.ok, false);
    assert.equal(timeoutRun.data.tool, "uiq_run_stream");
    assert.equal(timeoutRun.data.reasonCode, "TIMEOUT_BUDGET_EXCEEDED");
    assert.match(timeoutRun.data.detail, /timed out/);

    const failRun = await callToolJson<{
      ok: boolean;
      detail: string;
      tool: string;
      reasonCode: string;
    }>(harness.client, "uiq_run_command", {
      command: "fail-now",
    });
    assert.equal(failRun.isError, true);
    assert.equal(failRun.data.ok, false);
    assert.equal(failRun.data.tool, "uiq_run_command");
    assert.equal(failRun.data.reasonCode, "TOOL_EXECUTION_FAILED");

    const gate = await callToolJson<{ failedChecks: Array<{ id: string }> }>(
      harness.client,
      "uiq_gate_failures",
      { runId: "run-a" },
    );
    assert.equal(gate.isError, false);
    assert.equal(gate.data.failedChecks.length, 2);

    const a11y = await callToolJson<{ topIssues: Array<{ rank: number; id: string }> }>(
      harness.client,
      "uiq_a11y_top",
      {
        runId: "run-a",
        topN: 2,
      },
    );
    assert.equal(a11y.isError, false);
    assert.equal(a11y.data.topIssues.length, 2);
    assert.equal(a11y.data.topIssues[0].rank, 1);

    const perf = await callToolJson<{ metrics: { fcp: number } }>(
      harness.client,
      "uiq_perf_metrics",
      { runId: "run-a" },
    );
    assert.equal(perf.isError, false);
    assert.equal(perf.data.metrics.fcp, 1.2);

    const visual = await callToolJson<{ diffPixels: number }>(harness.client, "uiq_visual_status", {
      runId: "run-a",
    });
    assert.equal(visual.isError, false);
    assert.equal(visual.data.diffPixels, 124);

    const security = await callToolJson<{ ticketCount: number }>(
      harness.client,
      "uiq_security_summary",
      { runId: "run-a" },
    );
    assert.equal(security.isError, false);
    assert.equal(security.data.ticketCount, 2);

    const compared = await callToolJson<{ deltas: Record<string, { delta: number }> }>(
      harness.client,
      "uiq_compare_perf",
      {
        runIdA: "run-a",
        runIdB: "run-b",
      },
    );
    assert.equal(compared.isError, false);
    assert.equal(compared.data.deltas.fcp.delta, -0.2);
  } finally {
    await harness.close();
  }
});

test("withGovernedExecution reserves in-flight budget for concurrent runs", async () => {
  await withGovernanceEnv(
    {
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS: "100",
      UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS: "60",
      UIQ_MCP_GOVERN_TIMEOUT_MS: "80",
      UIQ_MCP_GOVERN_SESSION_BUDGET_MS: "80",
    },
    async () => {
      __governanceForTests.resetState();
      let secondExecuted = false;
      const first = withGovernedExecution("uiq_run_command", async () => {
        await sleepMs(40);
        return "first-ok";
      });
      const second = withGovernedExecution("uiq_run_stream", async () => {
        secondExecuted = true;
        return "second-ok";
      });
      const [firstResult, secondResult] = await Promise.allSettled([first, second]);
      assert.equal(firstResult.status, "fulfilled");
      assert.equal(secondExecuted, false);
      assert.equal(secondResult.status, "rejected");
      if (secondResult.status === "rejected") {
        assert.match(String(secondResult.reason), /session budget exceeded/);
      }
      assert.equal(__governanceForTests.snapshotState().reservedBudgetMs, 0);
    },
  );
});

test("withGovernedExecution enforces hard timeout before callback settles", async () => {
  await withGovernanceEnv(
    {
      UIQ_MCP_GOVERN_RATE_LIMIT_CALLS: "100",
      UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS: "60",
      UIQ_MCP_GOVERN_TIMEOUT_MS: "50",
      UIQ_MCP_GOVERN_SESSION_BUDGET_MS: "500",
    },
    async () => {
      __governanceForTests.resetState();
      const startedAt = Date.now();
      await assert.rejects(
        withGovernedExecution("uiq_run_command", async () => {
          await sleepMs(200);
          return "late-result";
        }),
        /timed out after 50ms/,
      );
      const elapsedMs = Date.now() - startedAt;
      assert.equal(
        elapsedMs < 180,
        true,
        `expected hard-timeout reject before 180ms, got ${elapsedMs}ms`,
      );
      assert.equal(__governanceForTests.snapshotState().reservedBudgetMs, 0);
    },
  );
});
