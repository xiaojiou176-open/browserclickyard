import assert from "node:assert/strict";
import test from "node:test";
import { buildProofArtifacts, buildStateModelSummary, runWithConcurrencyLimit } from "./run.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test("buildProofArtifacts computes coverage and stable status", () => {
  const artifacts = buildProofArtifacts({
    runId: "run-1",
    profile: "nightly",
    target: { type: "web", name: "demo" },
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
    },
    stateModel: {
      configuredRoutes: 2,
      configuredStories: 1,
      configuredTotal: 3,
      capturedRoutes: 2,
      capturedDiscovery: 1,
      capturedStories: 1,
    },
    states: [
      { id: "s1", source: "routes" },
      { id: "s2", source: "routes" },
      { id: "s3", source: "stories" },
      { id: "s4", source: "discovery" },
    ],
    summary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
    },
    gateResults: {
      status: "passed",
      checks: [
        {
          id: "console.error",
          expected: 0,
          actual: 0,
          severity: "BLOCKER",
          status: "passed",
          evidencePath: "reports/summary.json",
        },
      ],
    },
    blockedSteps: [],
    failureLocations: [],
    criticalPath: ["capture"],
    reportPath: "reports/summary.json",
    diagnosticsIndexPath: "reports/diagnostics.index.json",
    runEnvironment: {
      autostart: true,
      started: true,
      healthcheckPassed: true,
      healthcheckUrl: "http://localhost:4173",
      host: "darwin",
      node: "v20.0.0",
      ci: false,
    },
    toolVersions: {
      node: "v20.0.0",
      a11y: "axe",
      perf: "lhci",
      load: ["builtin"],
      security: "builtin",
    },
  });

  assert.equal(artifacts.summary.configuredCoverageRatio, 1);
  assert.equal(artifacts.summary.gatePassRatio, 1);
  assert.equal(artifacts.summary.stabilityStatus, "stable");
  assert.deepEqual(artifacts.summary.notApplicable, {
    configuredCoverageRatio: false,
    gatePassRatio: false,
  });
  const coverage = artifacts.coverage as { coverageModelVersion?: string };
  assert.equal(coverage.coverageModelVersion, "web.routes-stories.v1");
});

test("buildProofArtifacts marks failures and exposes gaps", () => {
  const artifacts = buildProofArtifacts({
    runId: "run-2",
    profile: "nightly",
    target: { type: "web", name: "demo" },
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
    },
    stateModel: {
      configuredRoutes: 3,
      configuredStories: 1,
      configuredTotal: 4,
      capturedRoutes: 2,
      capturedDiscovery: 0,
      capturedStories: 1,
    },
    states: [
      { id: "s1", source: "routes" },
      { id: "s2", source: "routes" },
      { id: "s3", source: "stories" },
    ],
    summary: {
      consoleError: 1,
      pageError: 0,
      http5xx: 0,
    },
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "test.e2e",
          expected: "passed",
          actual: "failed",
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.test_e2e.failed.suite_failed",
          evidencePath: "reports/test-e2e.json",
        },
      ],
    },
    blockedSteps: ["step.explore unsupported"],
    failureLocations: [
      {
        acId: "test.e2e",
        checkId: "test.e2e",
        status: "failed",
        reasonCode: "gate.test_e2e.failed.suite_failed",
        stepId: "e2e",
        artifactPath: "reports/test-e2e.json",
      },
    ],
    criticalPath: ["scenario.explore"],
    reportPath: "reports/summary.json",
    diagnosticsIndexPath: "reports/diagnostics.index.json",
    runEnvironment: {
      autostart: true,
      started: true,
      healthcheckPassed: true,
      healthcheckUrl: "http://localhost:4173",
      host: "darwin",
      node: "v20.0.0",
      ci: true,
    },
    toolVersions: {
      node: "v20.0.0",
      a11y: "axe",
      perf: "lhci",
      load: ["builtin"],
      security: "builtin",
    },
  });

  assert.equal(artifacts.summary.stabilityStatus, "failed");
  const gaps = artifacts.gaps as {
    gaps: {
      configuredStateGap: { missing: number };
      failedChecks: Array<{ id: string; acId: string }>;
    };
  };
  assert.equal(gaps.gaps.configuredStateGap.missing, 1);
  assert.equal(gaps.gaps.failedChecks[0]?.id, "test.e2e");
  assert.equal(gaps.gaps.failedChecks[0]?.acId, "test.e2e");
});

test("buildProofArtifacts uses desktop coverage model for non-web targets", () => {
  const artifacts = buildProofArtifacts({
    runId: "run-3",
    profile: "desktop-nightly",
    target: { type: "tauri", name: "desktop-app" },
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
    },
    stateModel: {
      modelType: "desktop",
      configuredRoutes: 0,
      configuredStories: 0,
      configuredTotal: 2,
      capturedRoutes: 0,
      capturedDiscovery: 0,
      capturedStories: 0,
      configuredDesktopScenarios: 2,
      capturedDesktopScenarios: 1,
      configuredDesktopScenarioIds: ["desktop.readiness", "desktop.e2e"],
      capturedDesktopScenarioIds: ["desktop.readiness"],
    },
    states: [],
    summary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
    },
    gateResults: {
      status: "passed",
      checks: [
        {
          id: "desktop.readiness",
          acId: "AC-DESKTOP-READINESS",
          expected: "passed",
          actual: "passed",
          severity: "BLOCKER",
          status: "passed",
          evidencePath: "reports/desktop-readiness.json",
        },
      ],
    },
    blockedSteps: [],
    failureLocations: [],
    criticalPath: ["desktop_readiness"],
    reportPath: "reports/summary.json",
    diagnosticsIndexPath: "reports/diagnostics.index.json",
    runEnvironment: {
      autostart: false,
      started: false,
      healthcheckPassed: false,
      healthcheckUrl: "",
      host: "darwin",
      node: "v20.0.0",
      ci: false,
    },
    toolVersions: {
      node: "v20.0.0",
      a11y: "axe",
      perf: "lhci",
      load: ["builtin"],
      security: "builtin",
    },
  });

  assert.equal(artifacts.summary.configuredCoverageRatio, 0.5);
  const coverage = artifacts.coverage as {
    coverageModelVersion?: string;
    coverage?: {
      stateModel?: {
        modelType?: string;
        configuredDesktopScenarios?: number;
        capturedDesktopScenarios?: number;
      };
    };
  };
  assert.equal(coverage.coverageModelVersion, "desktop.scenarios.v1");
  assert.equal(coverage.coverage?.stateModel?.modelType, "desktop");
  assert.equal(coverage.coverage?.stateModel?.configuredDesktopScenarios, 2);
  assert.equal(coverage.coverage?.stateModel?.capturedDesktopScenarios, 1);
});

test("buildStateModelSummary counts desktop captured scenarios only when passed", () => {
  const summary = buildStateModelSummary(
    "tauri",
    ["desktop_readiness", "desktop_smoke", "desktop_e2e", "desktop_soak"],
    {
      configuredRoutes: [],
      configuredStories: [],
      configuredTotal: 0,
    },
    [],
    {
      desktopReadinessResult: {
        targetType: "tauri",
        status: "passed",
        checks: [],
        reportPath: "reports/desktop-readiness.json",
      },
      desktopSmokeResult: {
        targetType: "tauri",
        status: "blocked",
        started: true,
        activated: false,
        quit: true,
        detail: "activate failed",
        reportPath: "reports/desktop-smoke.json",
      },
      desktopE2EResult: {
        targetType: "tauri",
        status: "passed",
        checks: [],
        reportPath: "reports/desktop-e2e.json",
      },
      desktopSoakResult: {
        targetType: "tauri",
        status: "blocked",
        durationSeconds: 10,
        intervalSeconds: 1,
        crashCount: 1,
        samples: [],
        reportPath: "reports/desktop-soak.json",
      },
    },
  );

  assert.equal(summary.modelType, "desktop");
  assert.equal(summary.configuredDesktopScenarios, 4);
  assert.equal(summary.capturedDesktopScenarios, 2);
  assert.deepEqual(summary.capturedDesktopScenarioIds, ["desktop.readiness", "desktop.e2e"]);
});

test("buildProofArtifacts returns zero ratio and notApplicable when denominator is zero", () => {
  const artifacts = buildProofArtifacts({
    runId: "run-4",
    profile: "nightly",
    target: { type: "web", name: "demo" },
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
    },
    stateModel: {
      configuredRoutes: 0,
      configuredStories: 0,
      configuredTotal: 0,
      capturedRoutes: 0,
      capturedDiscovery: 0,
      capturedStories: 0,
    },
    states: [],
    summary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
    },
    gateResults: {
      status: "passed",
      checks: [],
    },
    blockedSteps: [],
    failureLocations: [],
    criticalPath: [],
    reportPath: "reports/summary.json",
    diagnosticsIndexPath: "reports/diagnostics.index.json",
    runEnvironment: {
      autostart: true,
      started: true,
      healthcheckPassed: true,
      healthcheckUrl: "http://localhost:4173",
      host: "darwin",
      node: "v20.0.0",
      ci: false,
    },
    toolVersions: {
      node: "v20.0.0",
      a11y: "axe",
      perf: "lhci",
      load: ["builtin"],
      security: "builtin",
    },
  });

  assert.equal(artifacts.summary.configuredCoverageRatio, 0);
  assert.equal(artifacts.summary.gatePassRatio, 0);
  assert.deepEqual(artifacts.summary.notApplicable, {
    configuredCoverageRatio: true,
    gatePassRatio: true,
  });
});

test("runWithConcurrencyLimit stops dispatching new tasks after first failure", async () => {
  const started: number[] = [];
  const tasks = [
    async () => {
      started.push(0);
      throw new Error("boom");
    },
    async () => {
      started.push(1);
    },
  ];

  await assert.rejects(() => runWithConcurrencyLimit(tasks, 1), /boom/);
  assert.deepEqual(started, [0]);
});

test("runWithConcurrencyLimit propagates cancellation to in-flight tasks", async () => {
  let inFlightTaskSawAbort = false;
  let postFailureTaskStarted = false;
  const tasks = [
    async () => {
      await sleep(10);
      throw new Error("fail-fast");
    },
    async (signal: AbortSignal) => {
      while (!signal.aborted) {
        await sleep(2);
      }
      inFlightTaskSawAbort = true;
    },
    async () => {
      postFailureTaskStarted = true;
    },
  ];

  await assert.rejects(() => runWithConcurrencyLimit(tasks, 2), /fail-fast/);
  assert.equal(inFlightTaskSawAbort, true);
  assert.equal(postFailureTaskStarted, false);
});
