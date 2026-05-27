import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGateChecks, writeSummaryReportWithContext } from "./report.js";

test("writeSummaryReportWithContext exposes gateStatus/failedChecks/blockedChecks/checksTotal", () => {
  const dir = mkdtempSync(join(tmpdir(), "uiq-report-contract-"));
  try {
    mkdirSync(join(dir, "reports"), { recursive: true });
    const reportPath = writeSummaryReportWithContext(dir, {
      status: "failed",
      checks: [
        {
          id: "console.error",
          expected: 0,
          actual: 0,
          severity: "BLOCKER",
          status: "passed",
          evidencePath: "logs/route_home.log",
        },
        {
          id: "page.error",
          expected: 0,
          actual: 20,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "reports/summary.json",
        },
        {
          id: "driver.capability",
          expected: "all_requested_steps_supported",
          actual: "step.visual unsupported for target.type=api",
          severity: "BLOCKER",
          status: "blocked",
          reasonCode: "gate.driver_capability.blocked.unsupported_steps",
          evidencePath: "reports/summary.json",
        },
      ],
      summary: {
        consoleError: 0,
        pageError: 20,
        http5xx: 0,
        loadFailedRequests: 3,
      },
      diagnostics: {
        load: {
          attribution: {
            topFailingEndpoints: [
              {
                endpoint: "/api/login",
                failedRequests: 2,
                timeoutErrors: 1,
                networkErrors: 0,
              },
            ],
            statusDistribution: [
              { status: "503", count: 2 },
              { status: "timeout", count: 1 },
            ],
            timeoutErrors: 1,
            networkErrors: 0,
            otherErrors: 0,
          },
        },
      },
      qualitySignals: {
        a11yTrust: "fallback_untrusted",
        perfTrust: "release_untrusted",
        visualTrust: "no_historical_baseline",
      },
    });

    assert.equal(reportPath, "reports/summary.json");
    const payload = JSON.parse(readFileSync(join(dir, reportPath), "utf8")) as {
      gateStatus: string;
      failedChecks: Array<{ id: string; evidencePath: string }>;
      blockedChecks: Array<{ id: string }>;
      checksTotal: { total: number; passed: number; failed: number; blocked: number };
      qualitySignals: { a11yTrust: string; perfTrust: string; visualTrust: string };
      summary: { compare: { current: { pageError: number } } };
      informationalFailures?: {
        load?: {
          failedRequests: number;
          timeoutErrors?: number;
          statusDistribution?: Array<{ status?: string; count?: number }>;
          topFailingEndpoints?: Array<{ endpoint?: string; failedRequests?: number }>;
        };
      };
    };

    assert.equal(payload.gateStatus, "failed");
    assert.equal(payload.failedChecks.length, 1);
    assert.equal(payload.failedChecks[0]?.id, "page.error");
    assert.equal(payload.failedChecks[0]?.evidencePath, "reports/summary.json");
    assert.equal(payload.blockedChecks.length, 1);
    assert.equal(payload.blockedChecks[0]?.id, "driver.capability");
    assert.deepEqual(payload.checksTotal, { total: 3, passed: 1, failed: 1, blocked: 1 });
    assert.equal(payload.informationalFailures?.load?.failedRequests, 3);
    assert.equal(payload.informationalFailures?.load?.timeoutErrors, 1);
    assert.equal(
      payload.informationalFailures?.load?.topFailingEndpoints?.[0]?.endpoint,
      "/api/login",
    );
    assert.equal(payload.informationalFailures?.load?.statusDistribution?.[0]?.status, "503");
    assert.deepEqual(payload.qualitySignals, {
      a11yTrust: "fallback_untrusted",
      perfTrust: "release_untrusted",
      visualTrust: "no_historical_baseline",
    });
    assert.equal(payload.summary.compare.current.pageError, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGateChecks only emits load.p95_ms/load.rps_min when corresponding thresholds are configured", () => {
  const withoutThresholds = buildGateChecks(
    {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      loadP95Ms: 1234,
      loadRps: 2.5,
    },
    {
      consoleErrorMax: 0,
      pageErrorMax: 0,
      http5xxMax: 0,
    },
  );
  assert.equal(
    withoutThresholds.some((check) => check.id === "load.p95_ms"),
    false,
  );
  assert.equal(
    withoutThresholds.some((check) => check.id === "load.rps_min"),
    false,
  );
  assert.equal(
    withoutThresholds.some((check) => check.id === "load.p99_ms"),
    false,
  );

  const withThresholds = buildGateChecks(
    {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      loadP95Ms: 1234,
      loadRps: 2.5,
    },
    {
      consoleErrorMax: 0,
      pageErrorMax: 0,
      http5xxMax: 0,
      loadP95MsMax: 2500,
      loadRpsMin: 1,
    },
  );
  assert.equal(
    withThresholds.some((check) => check.id === "load.p95_ms"),
    true,
  );
  assert.equal(
    withThresholds.some((check) => check.id === "load.rps_min"),
    true,
  );
  assert.equal(
    withThresholds.some((check) => check.id === "load.p99_ms"),
    true,
  );
});

test("buildGateChecks emits load.engine_ready/load.error_budget/load.stage_thresholds and fails hard when violated", () => {
  const checks = buildGateChecks(
    {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      loadFailedRequests: 2,
      loadP95Ms: 3400,
      loadRps: 0,
    },
    {
      consoleErrorMax: 0,
      pageErrorMax: 0,
      http5xxMax: 0,
      loadFailedRequestsMax: 0,
      loadP95MsMax: 2500,
      loadRpsMin: 1,
    },
  );

  const engineReady = checks.find((check) => check.id === "load.engine_ready");
  const errorBudget = checks.find((check) => check.id === "load.error_budget");
  const stageThresholds = checks.find((check) => check.id === "load.stage_thresholds");
  const p99Gate = checks.find((check) => check.id === "load.p99_ms");

  assert.equal(engineReady?.status, "failed");
  assert.equal(errorBudget?.status, "failed");
  assert.equal(stageThresholds?.status, "failed");
  assert.equal(p99Gate?.status, "failed");
});

test("buildGateChecks emits UX/autofix/coverage gates when thresholds are configured", () => {
  const checks = buildGateChecks(
    {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      uxScore: 72,
      uxCriticalIssues: 2,
      interactiveControlsCoverage: 0.61,
      autofixRegressionPassed: 0,
    },
    {
      consoleErrorMax: 0,
      pageErrorMax: 0,
      http5xxMax: 0,
      uxScoreMin: 85,
      uxCriticalIssuesMax: 0,
      coverageInteractiveControlsMin: 0.9,
      autofixRegressionPassedRequired: true,
    },
  );

  assert.equal(checks.find((check) => check.id === "ux.score_min")?.status, "failed");
  assert.equal(checks.find((check) => check.id === "ux.critical_issues_max")?.status, "failed");
  assert.equal(
    checks.find((check) => check.id === "coverage.interactive_controls_min")?.status,
    "failed",
  );
  assert.equal(checks.find((check) => check.id === "autofix.regression_passed")?.status, "failed");
});
