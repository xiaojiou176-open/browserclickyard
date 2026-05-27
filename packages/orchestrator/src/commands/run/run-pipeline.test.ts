import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { TestSuiteResult } from "../test-suite.js";
import { createInitialPipelineStageState } from "./pipeline/stage-execution.js";
import { loadTargetConfig } from "./run-config.js";
import {
  persistMinimalFailureArtifacts,
  runAiPreflight,
  runPostFixRegressionLoop,
  runProfile,
} from "./run-pipeline.js";

function withEnv<T>(overrides: Record<string, string | undefined>, task: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return task();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureStdStreams<T>(
  task: () => Promise<T> | T,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  const capture = (collector: string[]) =>
    ((chunk: string | Uint8Array, ...args: unknown[]) => {
      collector.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const callback = args.find(
        (arg): arg is (error?: Error | null | undefined) => void => typeof arg === "function",
      );
      callback?.();
      return true;
    }) as typeof process.stdout.write;

  process.stdout.write = capture(stdoutChunks);
  process.stderr.write = capture(stderrChunks);
  try {
    const result = await task();
    return {
      result,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test(
  "runAiPreflight writes provider policy load warning to stderr only",
  { concurrency: false },
  async () => {
    const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-ai-preflight-warn-stream-"));
    mkdirSync(resolve(baseDir, "reports"), { recursive: true });
    const missingPolicyPath = resolve(baseDir, "missing-policy.yaml");
    try {
      const { stdout, stderr } = await captureStdStreams(() =>
        withEnv(
          {
            PROVIDER_POLICY_PATH: missingPolicyPath,
            AI_PROVIDER: undefined,
            GEMINI_API_KEY: "dummy-key",
          },
          () => runAiPreflight("pr", { aiReview: { enabled: false } } as never, baseDir),
        ),
      );
      assert.equal(stdout, "");
      assert.match(stderr, /provider_policy_load_failed/u);
      assert.match(stderr, /ai\.gemini\.preflight\.provider_policy_read_failed/u);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
);

test("runAiPreflight blocks strict no-fallback when gemini key is missing", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-ai-preflight-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    assert.throws(
      () =>
        withEnv(
          {
            AI_PROVIDER: undefined,
            GEMINI_API_KEY: undefined,
          },
          () => runAiPreflight("pr", { aiReview: { enabled: true } } as never, baseDir),
        ),
      /ai\.gemini\.strict_policy_violation/i,
    );
    const report = JSON.parse(
      readFileSync(resolve(baseDir, "reports/ai-preflight.json"), "utf8"),
    ) as {
      status: string;
      reasonCode: string;
      policySnapshot?: {
        sourcePath: string;
        provider: string;
        primary: string;
        fallback: string;
        fallbackMode: string;
        strictNoFallback: boolean;
      };
    };
    assert.equal(report.status, "blocked");
    assert.equal(report.reasonCode, "ai.gemini.strict_policy_violation");
    assert.ok(report.policySnapshot);
    assert.equal(report.policySnapshot?.provider, "gemini");
    assert.equal(report.policySnapshot?.primary, "gemini");
    assert.equal(report.policySnapshot?.fallback, "none");
    assert.equal(report.policySnapshot?.fallbackMode, "strict");
    assert.equal(report.policySnapshot?.strictNoFallback, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runAiPreflight blocks strict policy when policy primary is non-gemini", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-ai-preflight-policy-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  const policyPath = resolve(baseDir, "provider-policy.yaml");
  writeFileSync(
    policyPath,
    "provider: unsupported\nprimary: unsupported\nfallback: none\nfallbackMode: strict\n",
    "utf8",
  );
  try {
    assert.throws(
      () =>
        withEnv(
          {
            PROVIDER_POLICY_PATH: policyPath,
            AI_PROVIDER: undefined,
            GEMINI_API_KEY: "dummy-key",
          },
          () => runAiPreflight("pr", { aiReview: { enabled: true } } as never, baseDir),
        ),
      /ai\.gemini\.strict_policy_violation/i,
    );
    const report = JSON.parse(
      readFileSync(resolve(baseDir, "reports/ai-preflight.json"), "utf8"),
    ) as {
      status: string;
      reasonCode: string;
    };
    assert.equal(report.status, "blocked");
    assert.equal(report.reasonCode, "ai.gemini.strict_policy_violation");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runAiPreflight blocks provider mismatch under strict no-fallback policy", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-ai-preflight-blocked-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    assert.throws(
      () =>
        withEnv(
          {
            AI_PROVIDER: "unsupported",
            GEMINI_API_KEY: undefined,
          },
          () => runAiPreflight("pr", { aiReview: { enabled: true } } as never, baseDir),
        ),
      /ai\.gemini\.strict_policy_violation/i,
    );
    const report = JSON.parse(
      readFileSync(resolve(baseDir, "reports/ai-preflight.json"), "utf8"),
    ) as {
      status: string;
      reasonCode: string;
    };
    assert.equal(report.status, "blocked");
    assert.equal(report.reasonCode, "ai.gemini.strict_policy_violation");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("persistMinimalFailureArtifacts writes minimal summary and manifest", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-minimal-failure-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  mkdirSync(resolve(baseDir, "logs"), { recursive: true });
  try {
    const target = loadTargetConfig("swift.macos");
    const result = persistMinimalFailureArtifacts({
      baseDir,
      resolvedRunId: "test-run-id",
      startedAt: "2026-02-25T00:00:00.000Z",
      profileName: "nightly",
      target,
      effectiveBaseUrl: "http://localhost:4173",
      reasonCode: "ai.gemini.strict_policy_violation",
      detail: "[ai.gemini.strict_policy_violation] GEMINI_API_KEY is required",
      runtimeReportPath: "reports/runtime.json",
      aiPreflightPath: "reports/ai-preflight.json",
      maxParallelTasks: 1,
      stageDurationsMs: {},
    });

    assert.equal(result.summaryPath, "reports/summary.json");
    assert.equal(existsSync(resolve(baseDir, "reports/summary.json")), true);
    assert.equal(existsSync(resolve(baseDir, result.manifestPath)), true);

    const summary = JSON.parse(readFileSync(resolve(baseDir, "reports/summary.json"), "utf8")) as {
      status: string;
      checks: Array<{ reasonCode?: string }>;
    };
    assert.equal(summary.status, "failed");
    assert.equal(summary.checks[0]?.reasonCode, "ai.gemini.strict_policy_violation");

    const manifest = JSON.parse(readFileSync(resolve(baseDir, result.manifestPath), "utf8")) as {
      gateResults: { status: string; checks: Array<{ reasonCode?: string }> };
    };
    assert.equal(manifest.gateResults.status, "failed");
    assert.equal(manifest.gateResults.checks[0]?.reasonCode, "ai.gemini.strict_policy_violation");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runProfile persists minimal artifacts when AI preflight fails", async () => {
  const runId = `uiq-ai-preflight-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runDir = resolve(process.cwd(), ".runtime-cache/artifacts/runs", runId);
  try {
    await assert.rejects(
      () =>
        withEnv(
          {
            GEMINI_API_KEY: undefined,
            AI_PROVIDER: undefined,
          },
          () => runProfile("nightly", "swift.macos", runId),
        ),
      /ai\.gemini\.strict_policy_violation/i,
    );

    assert.equal(existsSync(resolve(runDir, "reports/summary.json")), true);
    assert.equal(existsSync(resolve(runDir, "manifest.json")), true);

    const summary = JSON.parse(readFileSync(resolve(runDir, "reports/summary.json"), "utf8")) as {
      status: string;
      checks: Array<{ reasonCode?: string }>;
    };
    assert.equal(summary.status, "failed");
    assert.equal(summary.checks[0]?.reasonCode, "ai.gemini.strict_policy_violation");

    const manifest = JSON.parse(readFileSync(resolve(runDir, "manifest.json"), "utf8")) as {
      gateResults: { status: string; checks: Array<{ reasonCode?: string }> };
      reports: { aiPreflight?: string };
    };
    assert.equal(manifest.gateResults.status, "failed");
    assert.equal(manifest.gateResults.checks[0]?.reasonCode, "ai.gemini.strict_policy_violation");
    assert.equal(manifest.reports.aiPreflight, "reports/ai-preflight.json");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runProfile honors allowAllUrls override in base URL policy", async () => {
  const runId = `uiq-allow-all-urls-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runDir = resolve(process.cwd(), ".runtime-cache/artifacts/runs", runId);
  try {
    await assert.rejects(
      () =>
        withEnv(
          {
            PROVIDER_POLICY_PATH: "configs/ai/provider-policy.yaml",
            GEMINI_API_KEY: undefined,
            AI_PROVIDER: undefined,
          },
          () =>
            runProfile("nightly", "web.local", runId, {
              baseUrl: "https://example.com",
              allowAllUrls: true,
              autostartTarget: false,
            }),
        ),
      /ai\.gemini\.strict_policy_violation/i,
    );

    const summary = JSON.parse(readFileSync(resolve(runDir, "reports/summary.json"), "utf8")) as {
      checks: Array<{ reasonCode?: string }>;
    };
    assert.equal(summary.checks[0]?.reasonCode, "ai.gemini.strict_policy_violation");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test(
  "runProfile persists minimal artifacts when initial target runtime start fails",
  { concurrency: false },
  async () => {
    const runId = `uiq-runtime-start-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runDir = resolve(process.cwd(), ".runtime-cache/artifacts/runs", runId);
    try {
      await assert.rejects(
        () =>
          withEnv(
            {
              PATH: "",
              UIQ_TRUSTED_BIN_DIRS: undefined,
            },
            () => runProfile("pr", "web.local", runId),
          ),
        /not resolvable from PATH/i,
      );

      assert.equal(existsSync(resolve(runDir, "reports/summary.json")), true);
      assert.equal(existsSync(resolve(runDir, "manifest.json")), true);
      assert.equal(existsSync(resolve(runDir, "reports/runtime-start.json")), true);

      const summary = JSON.parse(readFileSync(resolve(runDir, "reports/summary.json"), "utf8")) as {
        status: string;
        checks: Array<{ reasonCode?: string }>;
      };
      assert.equal(summary.status, "failed");
      assert.equal(summary.checks[0]?.reasonCode, "gate.execution.failed.unhandled_error");

      const runtimeReport = JSON.parse(
        readFileSync(resolve(runDir, "reports/runtime-start.json"), "utf8"),
      ) as {
        started: boolean;
        healthcheckPassed: boolean;
        healthcheckReason?: string;
        healthcheckDetail?: string;
      };
      assert.equal(runtimeReport.started, false);
      assert.equal(runtimeReport.healthcheckPassed, false);
      assert.equal(runtimeReport.healthcheckReason, "startup_command_failed");
      assert.match(runtimeReport.healthcheckDetail ?? "", /not resolvable from PATH/i);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

function failedSuiteResult(suite: "unit" | "contract" | "ct" | "e2e"): TestSuiteResult {
  return {
    suite,
    status: "failed",
    exitCode: 1,
    durationMs: 1,
    command: "pnpm",
    args: [],
    reportPath: `reports/test-${suite}.json`,
    stdoutTail: "",
    stderrTail: "",
  };
}

function passedSuiteResult(suite: "unit" | "contract" | "ct" | "e2e"): TestSuiteResult {
  return {
    ...failedSuiteResult(suite),
    status: "passed",
    exitCode: 0,
  };
}

test("post-fix regression loop fails immediately when max iterations is 0", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-post-fix-0-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  writeFileSync(
    resolve(baseDir, "reports/fix-result.json"),
    JSON.stringify({ executable: true }),
    "utf8",
  );
  try {
    const state = createInitialPipelineStageState("reports/runtime.json");
    state.unitTestResult = failedSuiteResult("unit");
    const report = await runPostFixRegressionLoop(
      baseDir,
      state,
      async () => passedSuiteResult("unit"),
      0,
    );
    assert.equal(report.status, "failed");
    assert.equal(report.iterationsExecuted, 0);
    assert.equal(report.converged, false);
    assert.deepEqual(report.remainingFailedSuites, ["unit"]);
    const persisted = JSON.parse(
      readFileSync(resolve(baseDir, "reports/post-fix-regression.json"), "utf8"),
    ) as {
      status: string;
      iterationsExecuted: number;
    };
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.iterationsExecuted, 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("post-fix regression loop converges within one iteration", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-post-fix-1-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  writeFileSync(
    resolve(baseDir, "reports/fix-result.json"),
    JSON.stringify({ executable: true }),
    "utf8",
  );
  try {
    const state = createInitialPipelineStageState("reports/runtime.json");
    state.unitTestResult = failedSuiteResult("unit");
    let called = 0;
    const report = await runPostFixRegressionLoop(
      baseDir,
      state,
      async (suite) => {
        called += 1;
        return passedSuiteResult(suite);
      },
      1,
    );
    assert.equal(called, 1);
    assert.equal(report.status, "passed");
    assert.equal(report.iterationsExecuted, 1);
    assert.equal(report.converged, true);
    assert.deepEqual(report.remainingFailedSuites, []);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("post-fix regression loop can converge on second iteration", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-post-fix-2-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  writeFileSync(
    resolve(baseDir, "reports/fix-result.json"),
    JSON.stringify({ executable: true }),
    "utf8",
  );
  try {
    const state = createInitialPipelineStageState("reports/runtime.json");
    state.unitTestResult = failedSuiteResult("unit");
    let call = 0;
    const report = await runPostFixRegressionLoop(
      baseDir,
      state,
      async (suite) => {
        call += 1;
        return call === 1 ? failedSuiteResult(suite) : passedSuiteResult(suite);
      },
      2,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.iterationsExecuted, 2);
    assert.equal(report.converged, true);
    assert.equal(report.iterations.length, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("post-fix regression loop hard-fails when not converged after max iterations", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-post-fix-fail-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  writeFileSync(
    resolve(baseDir, "reports/fix-result.json"),
    JSON.stringify({ executable: true }),
    "utf8",
  );
  try {
    const state = createInitialPipelineStageState("reports/runtime.json");
    state.unitTestResult = failedSuiteResult("unit");
    const report = await runPostFixRegressionLoop(
      baseDir,
      state,
      async (suite) => failedSuiteResult(suite),
      2,
    );
    assert.equal(report.status, "failed");
    assert.equal(report.reasonCode, "gate.post_fix_regression.failed.not_converged");
    assert.equal(report.iterationsExecuted, 2);
    assert.equal(report.converged, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("post-fix regression loop reruns unit/contract/ct concurrently and keeps e2e serialized", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-post-fix-grouped-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  writeFileSync(
    resolve(baseDir, "reports/fix-result.json"),
    JSON.stringify({ executable: true }),
    "utf8",
  );
  try {
    const state = createInitialPipelineStageState("reports/runtime.json");
    state.unitTestResult = failedSuiteResult("unit");
    state.contractTestResult = failedSuiteResult("contract");
    state.ctTestResult = failedSuiteResult("ct");
    state.e2eTestResult = failedSuiteResult("e2e");

    const pendingResolves: Record<"unit" | "contract" | "ct", (result: TestSuiteResult) => void> = {
      unit: () => undefined,
      contract: () => undefined,
      ct: () => undefined,
    };
    let groupReleased = false;
    let e2eStarted = false;
    let e2eStartedAfterGroupRelease = false;
    const startedSuites: Array<"unit" | "contract" | "ct" | "e2e"> = [];

    const loopPromise = runPostFixRegressionLoop(
      baseDir,
      state,
      async (suite) => {
        startedSuites.push(suite);
        if (suite === "e2e") {
          e2eStarted = true;
          e2eStartedAfterGroupRelease = groupReleased;
          return passedSuiteResult("e2e");
        }
        return await new Promise<TestSuiteResult>((resolvePromise) => {
          pendingResolves[suite] = resolvePromise;
        });
      },
      1,
    );

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.ok(startedSuites.includes("unit"));
    assert.ok(startedSuites.includes("contract"));
    assert.ok(startedSuites.includes("ct"));
    assert.equal(e2eStarted, false);

    groupReleased = true;
    pendingResolves.unit(passedSuiteResult("unit"));
    pendingResolves.contract(passedSuiteResult("contract"));
    pendingResolves.ct(passedSuiteResult("ct"));

    const report = await loopPromise;
    assert.equal(report.status, "passed");
    assert.equal(e2eStarted, true);
    assert.equal(e2eStartedAfterGroupRelease, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
