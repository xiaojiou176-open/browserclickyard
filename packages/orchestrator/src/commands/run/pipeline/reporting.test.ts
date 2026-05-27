import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { deriveCacheStatsFromReports } from "../run-reporting.js";
import { resolveAiFixAllowlistFromEnv, resolveAiFixModeFromEnv } from "./fix-executor.js";
import {
  finalizePipelineReporting,
  resolveAiReviewGeminiMultimodalFromEnv,
  resolveAiReviewGeminiTopScreenshotsFromEnv,
  resolveAiReviewModeFromEnv,
  resolveGateResultsStatus,
  resolveGeminiGateCheck,
  resolveGeminiModelFromEnv,
  resolveGeminiThoughtSignatureCheck,
} from "./reporting.js";
import { createInitialPipelineStageState } from "./stage-execution.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveGeminiModelFromEnv uses primary model when speed mode is disabled", () => {
  withEnv(
    {
      AI_SPEED_MODE: "false",
      GEMINI_MODEL: "models/gemini-3.1-pro-preview",
      GEMINI_FAST_MODEL: "models/gemini-3-flash-preview",
    },
    () => {
      assert.equal(resolveGeminiModelFromEnv(), "models/gemini-3.1-pro-preview");
    },
  );
});

test("resolveGeminiModelFromEnv uses flash model when speed mode is enabled", () => {
  withEnv(
    {
      AI_SPEED_MODE: "true",
      GEMINI_MODEL: "models/gemini-3.1-pro-preview",
      GEMINI_FAST_MODEL: "models/gemini-3-flash-preview",
    },
    () => {
      assert.equal(resolveGeminiModelFromEnv(), "models/gemini-3-flash-preview");
    },
  );
});

test("resolveAiReviewModeFromEnv defaults to llm", () => {
  withEnv(
    {
      AI_REVIEW_MODE: undefined,
    },
    () => {
      assert.equal(resolveAiReviewModeFromEnv(), "llm");
    },
  );
});

test("resolveAiReviewModeFromEnv supports rule_fallback override", () => {
  withEnv(
    {
      AI_REVIEW_MODE: "rule_fallback",
    },
    () => {
      assert.equal(resolveAiReviewModeFromEnv(), "rule_fallback");
    },
  );
});

test("resolveAiReviewGeminiMultimodalFromEnv defaults to enabled", () => {
  withEnv({ AI_REVIEW_GEMINI_MULTIMODAL: undefined }, () => {
    assert.equal(resolveAiReviewGeminiMultimodalFromEnv(), true);
  });
});

test("resolveAiReviewGeminiMultimodalFromEnv parses truthy values", () => {
  withEnv({ AI_REVIEW_GEMINI_MULTIMODAL: "true" }, () => {
    assert.equal(resolveAiReviewGeminiMultimodalFromEnv(), true);
  });
});

test("resolveAiReviewGeminiTopScreenshotsFromEnv defaults to 5", () => {
  withEnv({ AI_REVIEW_GEMINI_TOP_SCREENSHOTS: undefined }, () => {
    assert.equal(resolveAiReviewGeminiTopScreenshotsFromEnv(), 5);
  });
});

test("resolveAiReviewGeminiTopScreenshotsFromEnv rejects invalid values", () => {
  withEnv({ AI_REVIEW_GEMINI_TOP_SCREENSHOTS: "0" }, () => {
    assert.throws(
      () => resolveAiReviewGeminiTopScreenshotsFromEnv(),
      /must be an integer in \[1,10\]/,
    );
  });
});

test("resolveGeminiGateCheck returns blocked with explicit missing reason code when artifact is absent", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-gemini-gate-missing-"));
  try {
    const result = resolveGeminiGateCheck({
      baseDir,
      checkId: "ai_review.gemini_accuracy",
      expectedCheckId: "gemini_accuracy_min",
      reportPath: "reports/uiq-gemini-accuracy-gate-pr.json",
      metricField: "accuracy",
      thresholdField: "accuracyMin",
      missingReasonCode: "gate.ai_review.gemini_accuracy.blocked.report_missing",
      parseErrorReasonCode: "gate.ai_review.gemini_accuracy.blocked.report_parse_error",
      invalidPayloadReasonCode: "gate.ai_review.gemini_accuracy.blocked.invalid_report_payload",
    });
    assert.equal(result.reportExists, false);
    assert.equal(result.check.status, "blocked");
    assert.equal(result.check.reasonCode, "gate.ai_review.gemini_accuracy.blocked.report_missing");
    assert.equal(result.check.evidencePath, "reports/uiq-gemini-accuracy-gate-pr.json");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveGeminiGateCheck propagates status and reasonCode from valid gate report", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-gemini-gate-valid-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/uiq-gemini-concurrency-gate-pr.json"),
      JSON.stringify(
        {
          checkId: "gemini_parallel_consistency_min",
          status: "passed",
          reasonCode: "gate.gemini_parallel_consistency_min.passed.threshold_met",
          metrics: { parallelConsistency: 0.97, sampleSize: 12 },
          thresholds: { parallelConsistencyMin: 0.95, sampleSizeMin: 10 },
        },
        null,
        2,
      ),
      "utf8",
    );
    const result = resolveGeminiGateCheck({
      baseDir,
      checkId: "ai_review.gemini_concurrency",
      expectedCheckId: "gemini_parallel_consistency_min",
      reportPath: "reports/uiq-gemini-concurrency-gate-pr.json",
      metricField: "parallelConsistency",
      thresholdField: "parallelConsistencyMin",
      missingReasonCode: "gate.ai_review.gemini_concurrency.blocked.report_missing",
      parseErrorReasonCode: "gate.ai_review.gemini_concurrency.blocked.report_parse_error",
      invalidPayloadReasonCode: "gate.ai_review.gemini_concurrency.blocked.invalid_report_payload",
    });
    assert.equal(result.reportExists, true);
    assert.equal(result.check.status, "passed");
    assert.equal(
      result.check.reasonCode,
      "gate.gemini_parallel_consistency_min.passed.threshold_met",
    );
    assert.equal(result.check.evidencePath, "reports/uiq-gemini-concurrency-gate-pr.json");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveGeminiThoughtSignatureCheck passes when signature exists", () => {
  const check = resolveGeminiThoughtSignatureCheck({
    report: {
      thought_signatures: {
        status: "present",
        reason_code: "ai.gemini.thought_signature.present",
        signatures: ["sig-1"],
        signature_count: 1,
      },
    },
    evidencePath: "reports/ui-ux-gemini-report.json",
  });
  assert.equal(check.status, "passed");
  assert.equal(check.reasonCode, "gate.ai_review.gemini_thought_signature.passed.present");
});

test("resolveGeminiThoughtSignatureCheck fails with explicit reason when signature is missing", () => {
  const check = resolveGeminiThoughtSignatureCheck({
    report: {
      thought_signatures: {
        status: "missing",
        reason_code: "ai.gemini.thought_signature.missing",
        signatures: [],
        signature_count: 0,
      },
    },
    evidencePath: "reports/ui-ux-gemini-report.json",
  });
  assert.equal(check.status, "failed");
  assert.equal(check.reasonCode, "ai.gemini.thought_signature.missing");
});

test("resolveGeminiThoughtSignatureCheck blocks on parse failure", () => {
  const check = resolveGeminiThoughtSignatureCheck({
    report: {
      thought_signatures: {
        status: "parse_failed",
        reason_code: "ai.gemini.thought_signature.parse_failed",
        signatures: [],
        signature_count: 0,
      },
    },
    evidencePath: "reports/ui-ux-gemini-report.json",
  });
  assert.equal(check.status, "blocked");
  assert.equal(check.reasonCode, "ai.gemini.thought_signature.parse_failed");
});

test("resolveGeminiThoughtSignatureCheck blocks invalid payload instead of crashing", () => {
  const check = resolveGeminiThoughtSignatureCheck({
    report: {},
    evidencePath: "reports/ui-ux-gemini-report.json",
  });
  assert.equal(check.status, "blocked");
  assert.equal(
    check.reasonCode,
    "gate.ai_review.gemini_thought_signature.blocked.invalid_report_payload",
  );
});

test("deriveCacheStatsFromReports aggregates cache stats from report files", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-cache-stats-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/a.json"),
      JSON.stringify({ summary: { cacheStats: { hits: 3, misses: 1, hitRate: 0.75 } } }),
      "utf8",
    );
    writeFileSync(
      resolve(baseDir, "reports/b.json"),
      JSON.stringify({ diagnostics: { cache: { hit: 2, miss: 2 } } }),
      "utf8",
    );

    const resolved = deriveCacheStatsFromReports(baseDir, ["reports/a.json", "reports/b.json"]);
    assert.equal(resolved.hits, 5);
    assert.equal(resolved.misses, 3);
    assert.equal(resolved.hitRate, 0.625);
    assert.equal(resolved.reason, "derived_from_report_cache_fields");
    assert.equal(resolved.sourceCount, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("deriveCacheStatsFromReports reports no-field reason when cache stats are unavailable", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-cache-stats-empty-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/a.json"),
      JSON.stringify({ summary: { ok: true } }),
      "utf8",
    );
    const resolved = deriveCacheStatsFromReports(baseDir, [
      "reports/a.json",
      "reports/missing.json",
    ]);
    assert.equal(resolved.hits, 0);
    assert.equal(resolved.misses, 0);
    assert.equal(resolved.hitRate, 0);
    assert.equal(resolved.reason, "cache_stats_unavailable_no_report_fields");
    assert.equal(resolved.missingReports, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("deriveCacheStatsFromReports reports parse-error reason when report JSON is invalid", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-cache-stats-invalid-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(resolve(baseDir, "reports/a.json"), "{", "utf8");
    const resolved = deriveCacheStatsFromReports(baseDir, ["reports/a.json"]);
    assert.equal(resolved.hits, 0);
    assert.equal(resolved.misses, 0);
    assert.equal(resolved.reason, "cache_stats_unavailable_parse_error");
    assert.equal(resolved.parseErrors, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("resolveAiFixModeFromEnv defaults to report_only", () => {
  withEnv(
    {
      UIQ_AI_FIX_MODE: undefined,
    },
    () => {
      assert.equal(resolveAiFixModeFromEnv(), "report_only");
    },
  );
});

test("resolveAiFixModeFromEnv supports auto override", () => {
  withEnv(
    {
      UIQ_AI_FIX_MODE: "auto",
    },
    () => {
      assert.equal(resolveAiFixModeFromEnv(), "auto");
    },
  );
});

test("resolveAiFixAllowlistFromEnv falls back to defaults and parses custom values", () => {
  withEnv(
    {
      UIQ_AI_FIX_ALLOWLIST: undefined,
    },
    () => {
      assert.ok(resolveAiFixAllowlistFromEnv().length > 0);
    },
  );
  withEnv(
    {
      UIQ_AI_FIX_ALLOWLIST: "packages, apps ,packages",
    },
    () => {
      assert.deepEqual(resolveAiFixAllowlistFromEnv(), ["packages", "apps"]);
    },
  );
});

test("resolveGateResultsStatus prioritizes failed over blocked over passed", () => {
  assert.equal(resolveGateResultsStatus([{ status: "passed" }]), "passed");
  assert.equal(resolveGateResultsStatus([{ status: "blocked" }, { status: "passed" }]), "blocked");
  assert.equal(
    resolveGateResultsStatus([{ status: "failed" }, { status: "blocked" }, { status: "passed" }]),
    "failed",
  );
});

test("finalizePipelineReporting records runtime healthcheck reason in gate check and runEnvironment", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-reporting-runtime-reason-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/runtime.json"),
      JSON.stringify({ started: true }),
      "utf8",
    );
    const stageState = createInitialPipelineStageState("reports/runtime.json");

    const result = finalizePipelineReporting({
      baseDir,
      resolvedRunId: "run-runtime-reason",
      startedAt: "2026-02-22T10:00:00.000Z",
      profile: {
        name: "pr",
        steps: [],
        gates: {
          consoleErrorMax: 0,
          pageErrorMax: 0,
          http5xxMax: 0,
        },
      },
      target: {
        name: "web.ci",
        type: "web",
        driver: "web-playwright",
        baseUrl: "http://127.0.0.1:4173",
      },
      effectiveBaseUrl: "http://127.0.0.1:4173",
      effectiveApp: undefined,
      effectiveBundleId: undefined,
      stateModel: {
        configuredRoutes: [],
        configuredStories: [],
        configuredTotal: 0,
      } as never,
      runtimeStart: {
        autostart: true,
        started: true,
        healthcheckPassed: false,
        healthcheckUrl: "http://127.0.0.1:4173/health",
        healthcheckReason: "healthcheck_non_2xx",
        healthcheckDetail: "last_http_status=503",
        processes: [],
        reportPath: "reports/runtime.json",
        teardown: () => Promise.resolve(),
      },
      driverContract: {
        driverId: "web-playwright",
        targetTypes: ["web"],
        capabilities: {
          navigate: true,
          interact: true,
          capture: true,
          logs: true,
          network: true,
          trace: true,
          lifecycle: false,
        },
      },
      blockedStepReasons: [],
      blockedStepDetails: [],
      effectiveDiagnosticsConfig: {
        maxItems: 10,
      },
      maxParallelTasks: 1,
      stageDurationsMs: {},
      baseUrlPolicy: {
        enabled: true,
        requestedUrl: "http://127.0.0.1:4173",
        requestedOrigin: "http://127.0.0.1:4173",
        allowedOrigins: ["http://127.0.0.1:4173"],
        matched: true,
        reason: "origin_allowed",
      },
      state: stageState,
    });

    const manifest = JSON.parse(readFileSync(resolve(baseDir, result.manifestPath), "utf8")) as {
      gateResults: {
        checks: Array<{ id: string; actual: string }>;
      };
      runEnvironment: {
        healthcheckReason?: string;
        healthcheckDetail?: string;
      };
    };

    const runtimeHealthcheck = manifest.gateResults.checks.find(
      (check) => check.id === "runtime.healthcheck",
    );
    assert.equal(runtimeHealthcheck?.actual, "failed;reason=healthcheck_non_2xx");
    assert.equal(manifest.runEnvironment.healthcheckReason, "healthcheck_non_2xx");
    assert.equal(manifest.runEnvironment.healthcheckDetail, "last_http_status=503");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("finalizePipelineReporting marks failed computer_use with reason code and persisted diagnostics", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-reporting-computer-use-fail-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/runtime.json"),
      JSON.stringify({ started: false }),
      "utf8",
    );
    writeFileSync(
      resolve(baseDir, "reports/computer-use.json"),
      JSON.stringify({ status: "failed", reason: "ai.gemini.computer_use.max_steps_exceeded" }),
      "utf8",
    );
    const stageState = createInitialPipelineStageState("reports/runtime.json");
    stageState.computerUseResult = {
      status: "failed",
      reason: "ai.gemini.computer_use.max_steps_exceeded",
      exitCode: 2,
      command: "python3",
      args: ["scripts/computer-use/gemini-computer-use.py", "task"],
      scriptPath: "scripts/computer-use/gemini-computer-use.py",
      stdoutTail: "",
      stderrTail: "max steps exceeded",
      computerUseSafetyConfirmations: 1,
      safetyConfirmationEvidence: { events: [{ kind: "confirm", label: "safe-click" }] },
      error: "max steps exceeded",
    };
    stageState.computerUseSafetyConfirmations = 1;
    stageState.computerUseSafetyConfirmationEvidence = {
      events: [{ kind: "confirm", label: "safe-click" }],
    };
    stageState.generatedReports.computerUse = "reports/computer-use.json";

    const result = finalizePipelineReporting({
      baseDir,
      resolvedRunId: "run-computer-use-failed",
      startedAt: "2026-02-22T10:00:00.000Z",
      profile: {
        name: "pr",
        steps: ["computer_use"],
        gates: {
          consoleErrorMax: 0,
          pageErrorMax: 0,
          http5xxMax: 0,
        },
      },
      target: {
        name: "web.ci",
        type: "web",
        driver: "web-playwright",
        baseUrl: "http://127.0.0.1:4173",
      },
      effectiveBaseUrl: "http://127.0.0.1:4173",
      effectiveApp: undefined,
      effectiveBundleId: undefined,
      stateModel: {
        configuredRoutes: [],
        configuredStories: [],
        configuredTotal: 0,
      } as never,
      runtimeStart: {
        autostart: false,
        started: false,
        healthcheckPassed: false,
        healthcheckUrl: "http://127.0.0.1:4173/health",
        processes: [],
        reportPath: "reports/runtime.json",
        teardown: () => Promise.resolve(),
      },
      driverContract: {
        driverId: "web-playwright",
        targetTypes: ["web"],
        capabilities: {
          navigate: true,
          interact: true,
          capture: true,
          logs: true,
          network: true,
          trace: true,
          lifecycle: false,
        },
      },
      blockedStepReasons: [],
      blockedStepDetails: [],
      effectiveDiagnosticsConfig: {
        maxItems: 10,
      },
      maxParallelTasks: 1,
      stageDurationsMs: {
        "scenario.computer_use": 1200,
      },
      baseUrlPolicy: {
        enabled: true,
        requestedUrl: "http://127.0.0.1:4173",
        requestedOrigin: "http://127.0.0.1:4173",
        allowedOrigins: ["http://127.0.0.1:4173"],
        matched: true,
        reason: "origin_allowed",
      },
      state: stageState,
    });

    const manifest = JSON.parse(readFileSync(resolve(baseDir, result.manifestPath), "utf8")) as {
      gateResults: {
        status: string;
        checks: Array<{ id: string; status: string; reasonCode: string }>;
      };
      summary: {
        computerUseSafetyConfirmations: number;
      };
      diagnostics: {
        computerUse?: {
          reason: string;
          status: string;
        };
      };
    };

    const computerUseCheck = manifest.gateResults.checks.find(
      (check) => check.id === "scenario.computer_use",
    );
    assert.ok(computerUseCheck);
    assert.equal(computerUseCheck?.status, "failed");
    assert.equal(computerUseCheck?.reasonCode, "ai.gemini.computer_use.max_steps_exceeded");
    assert.equal(manifest.gateResults.status, "failed");
    assert.equal(manifest.summary.computerUseSafetyConfirmations, 1);
    assert.equal(manifest.diagnostics.computerUse?.status, "failed");
    assert.equal(
      manifest.diagnostics.computerUse?.reason,
      "ai.gemini.computer_use.max_steps_exceeded",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("finalizePipelineReporting prioritizes failed when failed and blocked checks coexist", () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "uiq-reporting-status-priority-"));
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  try {
    writeFileSync(
      resolve(baseDir, "reports/runtime.json"),
      JSON.stringify({ started: false }),
      "utf8",
    );
    writeFileSync(
      resolve(baseDir, "reports/computer-use.json"),
      JSON.stringify({ status: "failed", reason: "ai.gemini.computer_use.max_steps_exceeded" }),
      "utf8",
    );

    const stageState = createInitialPipelineStageState("reports/runtime.json");
    stageState.computerUseResult = {
      status: "failed",
      reason: "ai.gemini.computer_use.max_steps_exceeded",
      exitCode: 2,
      command: "python3",
      args: ["scripts/computer-use/gemini-computer-use.py", "task"],
      scriptPath: "scripts/computer-use/gemini-computer-use.py",
      stdoutTail: "",
      stderrTail: "max steps exceeded",
      computerUseSafetyConfirmations: 0,
      safetyConfirmationEvidence: { events: [] },
      error: "max steps exceeded",
    };
    stageState.generatedReports.computerUse = "reports/computer-use.json";

    const result = finalizePipelineReporting({
      baseDir,
      resolvedRunId: "run-status-priority",
      startedAt: "2026-02-22T10:00:00.000Z",
      profile: {
        name: "pr",
        steps: ["computer_use"],
        gates: {
          consoleErrorMax: 0,
          pageErrorMax: 0,
          http5xxMax: 0,
        },
      },
      target: {
        name: "web.ci",
        type: "web",
        driver: "web-playwright",
        baseUrl: "http://127.0.0.1:4173",
      },
      effectiveBaseUrl: "http://127.0.0.1:4173",
      effectiveApp: undefined,
      effectiveBundleId: undefined,
      stateModel: {
        configuredRoutes: [],
        configuredStories: [],
        configuredTotal: 0,
      } as never,
      runtimeStart: {
        autostart: false,
        started: false,
        healthcheckPassed: false,
        healthcheckUrl: "http://127.0.0.1:4173/health",
        processes: [],
        reportPath: "reports/runtime.json",
        teardown: () => Promise.resolve(),
      },
      driverContract: {
        driverId: "web-playwright",
        targetTypes: ["web"],
        capabilities: {
          navigate: true,
          interact: true,
          capture: true,
          logs: true,
          network: true,
          trace: true,
          lifecycle: false,
        },
      },
      blockedStepReasons: ["desktop.smoke unsupported by driver"],
      blockedStepDetails: [],
      effectiveDiagnosticsConfig: {
        maxItems: 10,
      },
      maxParallelTasks: 1,
      stageDurationsMs: {
        "scenario.computer_use": 1200,
      },
      baseUrlPolicy: {
        enabled: true,
        requestedUrl: "http://127.0.0.1:4173",
        requestedOrigin: "http://127.0.0.1:4173",
        allowedOrigins: ["http://127.0.0.1:4173"],
        matched: true,
        reason: "origin_allowed",
      },
      state: stageState,
    });

    const manifest = JSON.parse(readFileSync(resolve(baseDir, result.manifestPath), "utf8")) as {
      gateResults: {
        status: string;
        checks: Array<{ id: string; status: string }>;
      };
    };

    const failedCheck = manifest.gateResults.checks.find(
      (check) => check.id === "scenario.computer_use",
    );
    const blockedCheck = manifest.gateResults.checks.find(
      (check) => check.id === "driver.capability",
    );
    assert.equal(failedCheck?.status, "failed");
    assert.equal(blockedCheck?.status, "blocked");
    assert.equal(manifest.gateResults.status, "failed");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
