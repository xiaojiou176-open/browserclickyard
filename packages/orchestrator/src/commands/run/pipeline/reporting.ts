import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAiReviewInput } from "../../../../../ai-review/src/build-input.js";
import {
  AiReviewGenerationError,
  generateAiReviewReport,
  writeAiReviewReportArtifacts,
} from "../../../../../ai-review/src/generate-findings.js";
import {
  AI_REVIEW_PROMPT_ID,
  AI_REVIEW_PROMPT_VERSION,
} from "../../../../../ai-review/src/prompt-entry.js";
import { writeManifest } from "../../../../../core/src/manifest/io.js";
import type { Manifest } from "../../../../../core/src/manifest/types.js";
import type { getDriverCapabilityContract } from "../../../../../drivers/capabilities.js";
import {
  buildGateChecks,
  type GateThresholds,
  writeSummaryReportWithContext,
} from "../../report.js";
import type { loadStateModel } from "../../state-model.js";
import type { startTargetRuntime } from "../../target-runtime.js";
import {
  buildEvidenceIndex,
  collectFailureLocations,
  deriveCacheStatsFromReports,
  gateReasonCode,
  getGitInfo,
  normalizeCheckReasonCode,
  normalizeDiagnosticsSection,
  normalizeList,
  writeDiagnosticsIndex,
  writeEvidenceIndex,
} from "../run-reporting.js";
import {
  CROSS_TARGET_KEY_GATE_CHECK_IDS,
  PR_GATE_BUDGET_MS,
  TOOLCHAIN_VERSION,
} from "../run-schema.js";
import type {
  BaseUrlPolicyResult,
  BlockedStepDetail,
  DiagnosticsConfig,
  ProfileConfig,
  TargetConfig,
} from "../run-types.js";
import {
  executeFixExecutor,
  type FixExecutorResult,
  resolveAiFixAllowlistFromEnv,
  resolveAiFixModeFromEnv,
} from "./fix-executor.js";
import type { PipelineStageState } from "./stage-execution.js";

const DEFAULT_GEMINI_MODEL = "models/gemini-3.1-pro-preview";
const DEFAULT_UI_UX_GEMINI_REPORT_PATH = "reports/ui-ux-gemini-report.json";

type UiUxGeminiReportSummary = {
  total_findings?: number;
  high_or_above?: number;
  overall_score?: number;
};

type UiUxGeminiReport = {
  schemaVersion?: string;
  reason_code?: string;
  thought_signatures?: {
    include_thoughts_enabled?: boolean;
    status?: string;
    reason_code?: string;
    signatures?: string[];
    signature_count?: number;
  };
  summary?: UiUxGeminiReportSummary;
};

type GeminiGateStatus = "passed" | "failed" | "blocked";

type GeminiGateReport = {
  checkId?: string;
  status?: string;
  reasonCode?: string;
  metrics?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
};

type GeminiGateCheckArgs = {
  baseDir: string;
  checkId: string;
  expectedCheckId: string;
  reportPath: string;
  metricField: string;
  thresholdField: string;
  missingReasonCode: string;
  parseErrorReasonCode: string;
  invalidPayloadReasonCode: string;
};

function asGeminiGateStatus(value: unknown): GeminiGateStatus | undefined {
  if (value === "passed" || value === "failed" || value === "blocked") {
    return value;
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Number(value.toFixed(6));
}

function buildGeminiGateActual(
  report: GeminiGateReport,
  metricField: string,
  thresholdField: string,
): string {
  const metric = asFiniteNumber(report.metrics?.[metricField]);
  const threshold = asFiniteNumber(report.thresholds?.[thresholdField]);
  const sampleSize = asFiniteNumber(report.metrics?.sampleSize);
  const reportCheckId = typeof report.checkId === "string" ? report.checkId : "<missing>";
  return `check_id=${reportCheckId};metric=${metric ?? "n/a"};threshold=${threshold ?? "n/a"};sample_size=${sampleSize ?? "n/a"}`;
}

export function resolveGeminiGateCheck(args: GeminiGateCheckArgs): {
  check: {
    id: string;
    expected: string;
    actual: string;
    severity: "MAJOR";
    status: GeminiGateStatus;
    reasonCode: string;
    evidencePath: string;
  };
  reportExists: boolean;
} {
  const absoluteReportPath = resolve(args.baseDir, args.reportPath);
  if (!existsSync(absoluteReportPath)) {
    return {
      check: {
        id: args.checkId,
        expected: "report_present",
        actual: "missing",
        severity: "MAJOR",
        status: "blocked",
        reasonCode: args.missingReasonCode,
        evidencePath: args.reportPath,
      },
      reportExists: false,
    };
  }

  let report: GeminiGateReport;
  try {
    report = JSON.parse(readFileSync(absoluteReportPath, "utf8")) as GeminiGateReport;
  } catch {
    return {
      check: {
        id: args.checkId,
        expected: args.expectedCheckId,
        actual: "report_parse_error",
        severity: "MAJOR",
        status: "blocked",
        reasonCode: args.parseErrorReasonCode,
        evidencePath: args.reportPath,
      },
      reportExists: true,
    };
  }

  const status = asGeminiGateStatus(report.status);
  const reasonCode = typeof report.reasonCode === "string" ? report.reasonCode.trim() : "";
  const checkIdMatches =
    typeof report.checkId === "string" && report.checkId.trim() === args.expectedCheckId;
  if (!status || !reasonCode || !checkIdMatches) {
    return {
      check: {
        id: args.checkId,
        expected: args.expectedCheckId,
        actual: buildGeminiGateActual(report, args.metricField, args.thresholdField),
        severity: "MAJOR",
        status: "blocked",
        reasonCode: args.invalidPayloadReasonCode,
        evidencePath: args.reportPath,
      },
      reportExists: true,
    };
  }

  return {
    check: {
      id: args.checkId,
      expected: args.expectedCheckId,
      actual: buildGeminiGateActual(report, args.metricField, args.thresholdField),
      severity: "MAJOR",
      status,
      reasonCode,
      evidencePath: args.reportPath,
    },
    reportExists: true,
  };
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolveGeminiModelFromEnv(): string {
  const speedMode = (process.env.AI_SPEED_MODE ?? "").trim().toLowerCase() === "true";
  if (speedMode) {
    return (
      pickFirstNonEmpty(
        process.env.GEMINI_FAST_MODEL,
        process.env.GEMINI_MODEL,
        process.env.GEMINI_MODEL,
      ) ?? DEFAULT_GEMINI_MODEL
    );
  }
  return (
    pickFirstNonEmpty(process.env.GEMINI_MODEL, process.env.GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL
  );
}

export function resolveAiReviewModeFromEnv(): "llm" | "rule_fallback" {
  const mode = (process.env.AI_REVIEW_MODE ?? "").trim().toLowerCase();
  if (mode === "rule_fallback") {
    return "rule_fallback";
  }
  return "llm";
}

export function resolveAiReviewGeminiMultimodalFromEnv(): boolean {
  const raw = (process.env.AI_REVIEW_GEMINI_MULTIMODAL ?? "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function resolveAiReviewGeminiTopScreenshotsFromEnv(): number {
  const raw = (process.env.AI_REVIEW_GEMINI_TOP_SCREENSHOTS ?? "").trim();
  if (!raw) {
    return 5;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(
      `AI_REVIEW_GEMINI_TOP_SCREENSHOTS must be an integer in [1,10], received '${raw}'`,
    );
  }
  return parsed;
}

function runUiUxGeminiReport(args: {
  resolvedRunId: string;
  speedMode: boolean;
  parallelConsistency: number;
}): {
  reportPath: string;
  report: UiUxGeminiReport;
} {
  const runsDir = resolve(process.cwd(), ".runtime-cache/artifacts/runs");
  const reportPath = DEFAULT_UI_UX_GEMINI_REPORT_PATH;
  const scriptPath = resolve(process.cwd(), "tooling/automation/scripts/generate-ui-ux-gemini-report.ts");
  const commandArgs = [
    "--import",
    "tsx",
    scriptPath,
    `--runs_dir=${runsDir}`,
    `--run_id=${args.resolvedRunId}`,
    `--output=${reportPath}`,
    `--speed_mode=${args.speedMode ? "true" : "false"}`,
    `--top_screenshots=${resolveAiReviewGeminiTopScreenshotsFromEnv()}`,
    `--parallel_consistency=${String(args.parallelConsistency)}`,
  ];

  try {
    execFileSync(process.execPath, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? "").trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Gemini multimodal UI/UX report generation failed: ${details}`);
  }

  const absoluteReportPath = resolve(runsDir, args.resolvedRunId, reportPath);
  const report = JSON.parse(readFileSync(absoluteReportPath, "utf8")) as UiUxGeminiReport;
  return { reportPath, report };
}

function runGeminiGateReport(args: {
  scriptName: "uiq-gemini-accuracy-gate.mjs" | "uiq-gemini-concurrency-gate.mjs";
  profileName: string;
  reportPath: string;
  baseDir: string;
}): string {
  const reportsDir = resolve(args.baseDir, "reports");
  const scriptPath = resolve(process.cwd(), "scripts/ci", args.scriptName);
  const artifactPath = resolve(args.baseDir, args.reportPath);
  const basename =
    args.scriptName === "uiq-gemini-accuracy-gate.mjs"
      ? `uiq-gemini-accuracy-gate-${args.profileName}.json`
      : `uiq-gemini-concurrency-gate-${args.profileName}.json`;
  const relativePath = `reports/${basename}`;
  try {
    execFileSync(
      process.execPath,
      [
        scriptPath,
        "--profile",
        args.profileName,
        "--strict",
        "true",
        "--artifact",
        artifactPath,
        "--out-dir",
        reportsDir,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "pipe",
      },
    );
  } catch {
    if (!existsSync(resolve(args.baseDir, relativePath))) {
      throw new Error(`Gemini gate report missing after ${args.scriptName}`);
    }
  }
  return relativePath;
}

export function resolveGeminiThoughtSignatureCheck(args: {
  report: UiUxGeminiReport;
  evidencePath: string;
}): {
  id: string;
  expected: string;
  actual: string;
  severity: "MAJOR";
  status: "passed" | "failed" | "blocked";
  reasonCode: string;
  evidencePath: string;
} {
  const thought = args.report.thought_signatures;
  if (!thought || typeof thought !== "object") {
    return {
      id: "ai_review.gemini_thought_signature",
      expected: "status=present",
      actual: "missing_payload",
      severity: "MAJOR",
      status: "blocked",
      reasonCode: "gate.ai_review.gemini_thought_signature.blocked.invalid_report_payload",
      evidencePath: args.evidencePath,
    };
  }
  const statusRaw = typeof thought.status === "string" ? thought.status.trim() : "";
  const reasonCodeRaw = typeof thought.reason_code === "string" ? thought.reason_code.trim() : "";
  const signatures = Array.isArray(thought.signatures)
    ? thought.signatures.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  const signatureCount =
    typeof thought.signature_count === "number" && Number.isFinite(thought.signature_count)
      ? thought.signature_count
      : signatures.length;

  if (!statusRaw || !reasonCodeRaw || !["present", "missing", "parse_failed"].includes(statusRaw)) {
    return {
      id: "ai_review.gemini_thought_signature",
      expected: "status=present",
      actual: `status=${statusRaw || "<missing>"};count=${signatureCount}`,
      severity: "MAJOR",
      status: "blocked",
      reasonCode: "gate.ai_review.gemini_thought_signature.blocked.invalid_report_payload",
      evidencePath: args.evidencePath,
    };
  }

  if (statusRaw === "present") {
    return {
      id: "ai_review.gemini_thought_signature",
      expected: "status=present",
      actual: `status=present;count=${signatureCount}`,
      severity: "MAJOR",
      status: signatureCount > 0 ? "passed" : "blocked",
      reasonCode:
        signatureCount > 0
          ? "gate.ai_review.gemini_thought_signature.passed.present"
          : "gate.ai_review.gemini_thought_signature.blocked.invalid_report_payload",
      evidencePath: args.evidencePath,
    };
  }

  if (statusRaw === "missing") {
    return {
      id: "ai_review.gemini_thought_signature",
      expected: "status=present",
      actual: "status=missing;count=0",
      severity: "MAJOR",
      status: "failed",
      reasonCode: reasonCodeRaw || "gate.ai_review.gemini_thought_signature.failed.missing",
      evidencePath: args.evidencePath,
    };
  }

  return {
    id: "ai_review.gemini_thought_signature",
    expected: "status=present",
    actual: `status=parse_failed;count=${signatureCount}`,
    severity: "MAJOR",
    status: "blocked",
    reasonCode: reasonCodeRaw || "gate.ai_review.gemini_thought_signature.blocked.parse_failed",
    evidencePath: args.evidencePath,
  };
}

type PipelineReportingInput = {
  baseDir: string;
  resolvedRunId: string;
  startedAt: string;
  profile: ProfileConfig;
  target: TargetConfig;
  effectiveBaseUrl: string;
  effectiveApp: string | undefined;
  effectiveBundleId: string | undefined;
  stateModel: ReturnType<typeof loadStateModel>;
  runtimeStart: Awaited<ReturnType<typeof startTargetRuntime>>;
  driverContract: ReturnType<typeof getDriverCapabilityContract>;
  blockedStepReasons: string[];
  blockedStepDetails: BlockedStepDetail[];
  effectiveDiagnosticsConfig: DiagnosticsConfig;
  maxParallelTasks: number;
  stageDurationsMs: Record<string, number>;
  baseUrlPolicy: BaseUrlPolicyResult;
  state: PipelineStageState;
};

export function resolveGateResultsStatus(
  checks: Array<{ status: "passed" | "failed" | "blocked" }>,
): "passed" | "failed" | "blocked" {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "blocked")) {
    return "blocked";
  }
  return "passed";
}

export function finalizePipelineReporting(input: PipelineReportingInput): { manifestPath: string } {
  const {
    baseDir,
    resolvedRunId,
    startedAt,
    profile,
    target,
    effectiveBaseUrl,
    effectiveApp,
    effectiveBundleId,
    stateModel,
    runtimeStart,
    driverContract,
    blockedStepReasons,
    blockedStepDetails,
    effectiveDiagnosticsConfig,
    maxParallelTasks,
    stageDurationsMs,
    baseUrlPolicy,
    state,
  } = input;

  const {
    states,
    pageErrorFromChaos,
    consoleErrorFromChaos,
    http5xxFromChaos,
    dangerousActionHitsFromChaos,
    pageErrorFromExplore,
    consoleErrorFromExplore,
    http5xxFromExplore,
    dangerousActionHitsFromExplore,
    effectiveExploreConfig,
    effectiveChaosConfig,
    effectiveLoadConfig,
    effectiveA11yConfig,
    effectivePerfConfig,
    effectiveVisualConfig,
    effectiveSecurityConfig,
    effectiveAiReviewConfig,
    exploreResultData,
    exploreEngineBlockedReasonCode,
    visualEngineBlockedReasonCode,
    captureSummary,
    captureDiagnostics,
    exploreDiagnostics,
    chaosDiagnostics,
    highVulnCount,
    mediumVulnCount,
    lowVulnCount,
    securityResult,
    securityBlocked,
    securityBlockedReason,
    securityFailed,
    securityFailedReason,
    loadSummary,
    a11ySummary,
    a11yResultData,
    perfSummary,
    perfResultData,
    visualSummary,
    visualResultData,
    securityReportPath,
    securityTicketsPath,
    loadReportPath,
    desktopReadinessPath,
    desktopReadinessResult,
    desktopSmokePath,
    desktopSmokeResult,
    desktopE2EPath,
    desktopE2EResult,
    desktopBusinessPath,
    desktopBusinessResult,
    desktopSoakPath,
    desktopSoakResult,
    a11yReportPath,
    perfReportPath,
    visualReportPath,
    unitTestResult,
    contractTestResult,
    ctTestResult,
    e2eTestResult,
    computerUseSafetyConfirmations,
    computerUseSafetyConfirmationEvidence,
    computerUseResult,
    generatedReports,
  } = state;

  const cacheStatsResolution = deriveCacheStatsFromReports(baseDir, [
    ...Object.values(generatedReports),
    ...(loadReportPath ? [loadReportPath] : []),
    ...(a11yReportPath ? [a11yReportPath] : []),
    ...(perfReportPath ? [perfReportPath] : []),
    ...(visualReportPath ? [visualReportPath] : []),
    ...(securityReportPath ? [securityReportPath] : []),
    ...(securityTicketsPath ? [securityTicketsPath] : []),
    ...(state.aiReviewReportPath ? [state.aiReviewReportPath] : []),
    ...(state.aiReviewReportMarkdownPath ? [state.aiReviewReportMarkdownPath] : []),
    ...(desktopReadinessPath ? [desktopReadinessPath] : []),
    ...(desktopSmokePath ? [desktopSmokePath] : []),
    ...(desktopE2EPath ? [desktopE2EPath] : []),
    ...(desktopBusinessPath ? [desktopBusinessPath] : []),
    ...(desktopSoakPath ? [desktopSoakPath] : []),
  ]);
  const configuredAiModel = resolveGeminiModelFromEnv();
  let aiReviewPromptId = AI_REVIEW_PROMPT_ID;
  let aiReviewPromptVersion = AI_REVIEW_PROMPT_VERSION;
  let aiReviewActualModel = configuredAiModel;
  let aiReviewMode = resolveAiReviewModeFromEnv();
  let _aiReviewGeminiMultimodalPath: string | undefined;
  let aiReviewGeminiMultimodalReasonCode: string | undefined;
  let _aiReviewGeminiMultimodalHighOrAbove: number | undefined;
  let fixResult: FixExecutorResult | undefined;
  const baseSummary = {
    consoleError: captureSummary.consoleError + consoleErrorFromExplore + consoleErrorFromChaos,
    pageError: captureSummary.pageError + pageErrorFromChaos + pageErrorFromExplore,
    http5xx: captureSummary.http5xx + http5xxFromExplore + http5xxFromChaos,
    dangerousActionHits: dangerousActionHitsFromExplore + dangerousActionHitsFromChaos,
    highVuln: securityReportPath !== undefined ? highVulnCount : undefined,
    a11ySerious: a11ySummary?.serious,
    perfLcpMs: perfSummary?.lcpMs,
    perfFcpMs: perfSummary?.fcpMs,
    visualDiffPixels: visualSummary?.diffPixels,
    loadFailedRequests: loadSummary?.failedRequests,
    loadP95Ms: loadSummary?.latencyP95Ms,
    loadRps: loadSummary?.requestsPerSecond,
    aiModel: configuredAiModel,
    promptVersion: AI_REVIEW_PROMPT_VERSION,
    cacheStats: {
      hits: cacheStatsResolution.hits,
      misses: cacheStatsResolution.misses,
      hitRate: cacheStatsResolution.hitRate,
    },
    computerUseSafetyConfirmations,
  };
  const thresholds: GateThresholds = {
    consoleErrorMax: profile.gates?.consoleErrorMax ?? 0,
    pageErrorMax: profile.gates?.pageErrorMax ?? 0,
    http5xxMax: profile.gates?.http5xxMax ?? 0,
    dangerousActionHitsMax: profile.gates?.dangerousActionHitsMax ?? 0,
    contractStatus: contractTestResult ? (profile.gates?.contractStatus ?? "passed") : undefined,
    securityHighVulnMax: profile.gates?.securityHighVulnMax,
    a11ySeriousMax: a11ySummary ? profile.gates?.a11ySeriousMax : undefined,
    perfLcpMsMax: perfSummary ? profile.gates?.perfLcpMsMax : undefined,
    perfFcpMsMax: perfSummary ? profile.gates?.perfFcpMsMax : undefined,
    visualDiffPixelsMax: visualSummary ? profile.gates?.visualDiffPixelsMax : undefined,
    loadFailedRequestsMax: loadSummary ? profile.gates?.loadFailedRequestsMax : undefined,
    loadP95MsMax: loadSummary ? profile.gates?.loadP95MsMax : undefined,
    loadRpsMin: loadSummary ? profile.gates?.loadRpsMin : undefined,
  };
  const primaryCapturedStateId = states[0]?.id ?? "home_default";
  const fallbackEvidencePath =
    desktopBusinessPath ??
    desktopE2EPath ??
    desktopSmokePath ??
    desktopReadinessPath ??
    runtimeStart.reportPath;
  const checks = buildGateChecks(
    baseSummary,
    thresholds,
    {
      consoleError:
        consoleErrorFromExplore > 0
          ? "logs/explore.log"
          : states.length > 0
            ? `logs/${primaryCapturedStateId}.log`
            : fallbackEvidencePath,
      pageError:
        pageErrorFromChaos > 0
          ? "reports/chaos.json"
          : pageErrorFromExplore > 0
            ? "logs/explore.log"
            : states.length > 0
              ? `logs/${primaryCapturedStateId}.log`
              : fallbackEvidencePath,
      http5xx:
        http5xxFromChaos > 0
          ? "network/chaos.har"
          : http5xxFromExplore > 0
            ? "network/explore.har"
            : states.length > 0
              ? "network/capture.har"
              : fallbackEvidencePath,
      highVuln: "security/report.json",
      a11y: a11yReportPath ?? "a11y/axe.json",
      perf: perfReportPath ?? "perf/lighthouse.json",
      visual: visualReportPath ?? "visual/report.json",
      load: "metrics/load-summary.json",
    },
    {
      securityBlocked,
      securityBlockedReason,
      securityFailed,
      securityFailedReason,
    },
  ).map(normalizeCheckReasonCode);
  if (exploreEngineBlockedReasonCode) {
    checks.push({
      id: "explore.engine",
      expected: effectiveExploreConfig?.engine ?? "builtin",
      actual: "blocked",
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: exploreEngineBlockedReasonCode,
      evidencePath: "reports/explore.json",
    });
  }
  if (visualEngineBlockedReasonCode) {
    checks.push({
      id: "visual.engine",
      expected: effectiveVisualConfig?.engine ?? "builtin",
      actual: "blocked",
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: visualEngineBlockedReasonCode,
      evidencePath: "visual/report.json",
    });
  }
  if (runtimeStart.started) {
    const runtimeHealthcheckActual = runtimeStart.healthcheckPassed
      ? "passed"
      : `failed;reason=${runtimeStart.healthcheckReason ?? "unknown"}`;
    checks.push({
      id: "runtime.healthcheck",
      expected: "passed",
      actual: runtimeHealthcheckActual,
      severity: "BLOCKER",
      status: runtimeStart.healthcheckPassed ? "passed" : "blocked",
      reasonCode: runtimeStart.healthcheckPassed
        ? gateReasonCode("runtime.healthcheck", "passed", "healthy")
        : gateReasonCode("runtime.healthcheck", "blocked", "runtime_unreachable"),
      evidencePath: runtimeStart.reportPath,
    });
  }
  if (unitTestResult) {
    checks.push({
      id: "test.unit",
      expected: "passed",
      actual: unitTestResult.status,
      severity: "BLOCKER",
      status: unitTestResult.status,
      reasonCode:
        unitTestResult.status === "passed"
          ? gateReasonCode("test.unit", "passed", "suite_passed")
          : gateReasonCode("test.unit", "failed", "suite_failed"),
      evidencePath: unitTestResult.reportPath,
    });
  }
  if (contractTestResult) {
    const expectedStatus = profile.gates?.contractStatus ?? "passed";
    checks.push({
      id: "test.contract",
      expected: expectedStatus,
      actual: contractTestResult.status,
      severity: "BLOCKER",
      status: contractTestResult.status === expectedStatus ? "passed" : "failed",
      reasonCode:
        contractTestResult.status === expectedStatus
          ? gateReasonCode("test.contract", "passed", "suite_passed")
          : gateReasonCode("test.contract", "failed", "suite_failed"),
      evidencePath: contractTestResult.reportPath,
    });
  }
  if (ctTestResult) {
    checks.push({
      id: "test.ct",
      expected: "passed",
      actual: ctTestResult.status,
      severity: "MAJOR",
      status: ctTestResult.status,
      reasonCode:
        ctTestResult.status === "passed"
          ? gateReasonCode("test.ct", "passed", "suite_passed")
          : gateReasonCode("test.ct", "failed", "suite_failed"),
      evidencePath: ctTestResult.reportPath,
    });
  }
  if (e2eTestResult) {
    checks.push({
      id: "test.e2e",
      expected: "passed",
      actual: e2eTestResult.status,
      severity: "BLOCKER",
      status: e2eTestResult.status,
      reasonCode:
        e2eTestResult.status === "passed"
          ? gateReasonCode("test.e2e", "passed", "suite_passed")
          : gateReasonCode("test.e2e", "failed", "suite_failed"),
      evidencePath: e2eTestResult.reportPath,
    });
  }
  const blockedComputerUse = blockedStepDetails.find((detail) => detail.stepId === "computer_use");
  if (computerUseResult) {
    checks.push({
      id: "scenario.computer_use",
      expected: "ok",
      actual: computerUseResult.status,
      severity: "BLOCKER",
      status: computerUseResult.status === "ok" ? "passed" : "failed",
      reasonCode:
        computerUseResult.status === "ok"
          ? gateReasonCode("scenario.computer_use", "passed", "task_completed")
          : computerUseResult.reason,
      evidencePath: generatedReports.computerUse ?? "reports/computer-use.json",
    });
  } else if (profile.steps.includes("computer_use") && blockedComputerUse) {
    checks.push({
      id: "scenario.computer_use",
      expected: "ok",
      actual: blockedComputerUse.detail,
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: blockedComputerUse.reasonCode,
      evidencePath: blockedComputerUse.artifactPath,
    });
  } else if (profile.steps.includes("computer_use")) {
    checks.push({
      id: "scenario.computer_use",
      expected: "report_present",
      actual: "missing",
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: gateReasonCode("scenario.computer_use", "blocked", "report_missing"),
      evidencePath: "reports/computer-use.json",
    });
  }
  if (state.postFixRegression && state.postFixRegression.status === "failed") {
    checks.push({
      id: "post_fix.regression",
      expected: "converged",
      actual: `iterations=${state.postFixRegression.iterationsExecuted};remaining=${state.postFixRegression.remainingFailedSuites.join(",") || "none"}`,
      severity: "BLOCKER",
      status: "failed",
      reasonCode: state.postFixRegression.reasonCode,
      evidencePath: generatedReports.postFixRegression ?? "reports/post-fix-regression.json",
    });
  }
  if (blockedStepReasons.length > 0) {
    checks.push({
      id: "driver.capability",
      expected: "all_requested_steps_supported",
      actual: blockedStepReasons.join("; "),
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: gateReasonCode("driver.capability", "blocked", "unsupported_steps"),
      evidencePath: "reports/summary.json",
    });
  }
  if (desktopReadinessResult) {
    checks.push({
      id: "desktop.readiness",
      expected: "passed",
      actual: desktopReadinessResult.status,
      severity: "BLOCKER",
      status: desktopReadinessResult.status === "passed" ? "passed" : "blocked",
      reasonCode:
        desktopReadinessResult.status === "passed"
          ? gateReasonCode("desktop.readiness", "passed", "requirement_satisfied")
          : gateReasonCode("desktop.readiness", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopReadinessResult.reportPath,
    });
  }
  if (desktopSmokeResult) {
    checks.push({
      id: "desktop.smoke",
      expected: "passed",
      actual: desktopSmokeResult.status,
      severity: "BLOCKER",
      status: desktopSmokeResult.status === "passed" ? "passed" : "blocked",
      reasonCode:
        desktopSmokeResult.status === "passed"
          ? gateReasonCode("desktop.smoke", "passed", "requirement_satisfied")
          : gateReasonCode("desktop.smoke", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopSmokeResult.reportPath,
    });
  }
  if (desktopE2EResult) {
    checks.push({
      id: "desktop.e2e",
      expected: "passed",
      actual: desktopE2EResult.status,
      severity: "BLOCKER",
      status: desktopE2EResult.status === "passed" ? "passed" : "blocked",
      reasonCode:
        desktopE2EResult.status === "passed"
          ? gateReasonCode("desktop.e2e", "passed", "requirement_satisfied")
          : gateReasonCode("desktop.e2e", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopE2EResult.reportPath,
    });
  }
  if (desktopBusinessResult) {
    checks.push({
      id: "desktop.business_regression",
      expected: "passed",
      actual: desktopBusinessResult.status,
      severity: "BLOCKER",
      status: desktopBusinessResult.status === "passed" ? "passed" : "blocked",
      reasonCode:
        desktopBusinessResult.status === "passed"
          ? gateReasonCode("desktop.business_regression", "passed", "requirement_satisfied")
          : gateReasonCode("desktop.business_regression", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopBusinessResult.reportPath,
    });
  } else if (profile.steps.includes("desktop_business_regression")) {
    checks.push({
      id: "desktop.business_regression",
      expected: "report_present",
      actual: "missing",
      severity: "BLOCKER",
      status: "blocked",
      reasonCode: gateReasonCode("desktop.business_regression", "blocked", "report_missing"),
      evidencePath: "reports/summary.json",
    });
  }
  if (desktopSoakResult) {
    checks.push({
      id: "desktop.soak",
      expected: "passed",
      actual: desktopSoakResult.status,
      severity: "BLOCKER",
      status: desktopSoakResult.status === "passed" ? "passed" : "blocked",
      reasonCode:
        desktopSoakResult.status === "passed"
          ? gateReasonCode("desktop.soak", "passed", "requirement_satisfied")
          : gateReasonCode("desktop.soak", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopSoakResult.reportPath,
    });
  }
  if (profile.name === "pr") {
    const elapsedMs = Date.now() - new Date(startedAt).getTime();
    checks.push({
      id: "execution.pr_budget_ms",
      expected: PR_GATE_BUDGET_MS,
      actual: elapsedMs,
      severity: "MAJOR",
      status: elapsedMs <= PR_GATE_BUDGET_MS ? "passed" : "failed",
      reasonCode: gateReasonCode(
        "execution.pr_budget_ms",
        elapsedMs <= PR_GATE_BUDGET_MS ? "passed" : "failed",
        elapsedMs <= PR_GATE_BUDGET_MS ? "within_budget" : "threshold_exceeded",
      ),
      evidencePath: "reports/summary.json",
    });
  }

  if (effectiveAiReviewConfig?.enabled) {
    const aiReviewReports: Record<string, string> = {
      ...generatedReports,
      ...(a11yReportPath ? { a11y: a11yReportPath } : {}),
      ...(perfReportPath ? { perf: perfReportPath } : {}),
      ...(visualReportPath ? { visual: visualReportPath } : {}),
      ...(securityReportPath ? { security: securityReportPath } : {}),
      ...(loadReportPath ? { load: loadReportPath } : {}),
    };
    const nowIso = new Date().toISOString();
    const aiSnapshotChecks = checks.map(normalizeCheckReasonCode);
    const aiManifestSnapshot = {
      schemaVersion: "1.1",
      runId: resolvedRunId,
      target: {
        type: target.type,
        name: target.name,
        baseUrl: effectiveBaseUrl,
        app: effectiveApp ?? "",
        bundleId: effectiveBundleId ?? "",
      },
      profile: profile.name,
      git: getGitInfo(),
      timing: {
        startedAt,
        finishedAt: nowIso,
        durationMs: new Date(nowIso).getTime() - new Date(startedAt).getTime(),
      },
      execution: {
        maxParallelTasks,
        stagesMs: stageDurationsMs,
        criticalPath: [],
      },
      states,
      evidenceIndex: buildEvidenceIndex(states, aiReviewReports, aiSnapshotChecks),
      reports: aiReviewReports,
      summary: baseSummary,
      gateResults: {
        status: resolveGateResultsStatus(aiSnapshotChecks),
        checks: aiSnapshotChecks,
      },
      toolchain: {
        node: process.version,
      },
    } as Manifest;
    const aiReviewInput = buildAiReviewInput(aiManifestSnapshot, {
      maxArtifacts: effectiveAiReviewConfig.maxArtifacts,
    });
    writeFileSync(
      resolve(baseDir, "manifest.json"),
      `${JSON.stringify(aiManifestSnapshot, null, 2)}\n`,
      "utf8",
    );
    const aiReviewReport = (() => {
      try {
        return generateAiReviewReport(aiReviewInput, {
          severityThreshold: effectiveAiReviewConfig.severityThreshold,
          mode: aiReviewMode,
        });
      } catch (error) {
        if (error instanceof AiReviewGenerationError) {
          throw new Error(`AI review generation failed (${error.reasonCode}): ${error.message}`);
        }
        throw error;
      }
    })();
    aiReviewPromptId = aiReviewReport.generation.promptId;
    aiReviewPromptVersion = aiReviewReport.generation.promptVersion;
    aiReviewActualModel = aiReviewReport.generation.model;
    aiReviewMode = aiReviewReport.generation.mode;
    const aiArtifacts = writeAiReviewReportArtifacts(
      baseDir,
      aiReviewReport,
      "reports/ai-review.json",
      "reports/ai-review.md",
    );
    state.aiReviewReportPath = aiArtifacts.jsonPath;
    state.aiReviewReportMarkdownPath = aiArtifacts.markdownPath;
    state.aiReviewFindingCount = aiReviewReport.summary.totalFindings;
    state.aiReviewHighOrAbove = aiReviewReport.summary.highOrAbove;
    generatedReports.aiReview = aiArtifacts.jsonPath;
    generatedReports.aiReviewMarkdown = aiArtifacts.markdownPath;
    checks.push({
      id: "ai_review.severity_threshold",
      expected: `severity<${effectiveAiReviewConfig.severityThreshold}`,
      actual: `findings=${aiReviewReport.summary.totalFindings};high_or_above=${aiReviewReport.summary.highOrAbove}`,
      severity: "MAJOR",
      status: aiReviewReport.gate.status,
      reasonCode: aiReviewReport.gate.reasonCode,
      evidencePath: aiArtifacts.jsonPath,
    });
    if (resolveAiReviewGeminiMultimodalFromEnv()) {
      const geminiParallelAttempts = Math.max(
        1,
        Number(profile.geminiSampleSizeMin ?? 1),
        Number(profile.geminiParallelConsistencyMin ? 2 : 1),
      );
      const multimodal = runUiUxGeminiReport({
        resolvedRunId,
        speedMode: (process.env.AI_SPEED_MODE ?? "").trim().toLowerCase() === "true",
        parallelConsistency: geminiParallelAttempts,
      });
      const highOrAbove = Number(multimodal.report.summary?.high_or_above ?? 0);
      _aiReviewGeminiMultimodalPath = multimodal.reportPath;
      aiReviewGeminiMultimodalReasonCode =
        (multimodal.report.reason_code ?? "").trim() || "ai.gemini.ui_ux.report.generated";
      _aiReviewGeminiMultimodalHighOrAbove = highOrAbove;
      generatedReports.uiUxGemini = multimodal.reportPath;
      checks.push({
        id: "ai_review.gemini_multimodal",
        expected: "high_or_above=0",
        actual: `findings=${Number(multimodal.report.summary?.total_findings ?? 0)};high_or_above=${highOrAbove};score=${Number(multimodal.report.summary?.overall_score ?? 0)}`,
        severity: "MAJOR",
        status: highOrAbove > 0 ? "failed" : "passed",
        reasonCode:
          highOrAbove > 0
            ? aiReviewGeminiMultimodalReasonCode
            : "gate.ai_review.passed.gemini_multimodal_threshold_met",
        evidencePath: multimodal.reportPath,
      });
      checks.push(
        resolveGeminiThoughtSignatureCheck({
          report: multimodal.report,
          evidencePath: multimodal.reportPath,
        }),
      );

      try {
        generatedReports.geminiAccuracyGate = runGeminiGateReport({
          scriptName: "uiq-gemini-accuracy-gate.mjs",
          profileName: profile.name,
          reportPath: multimodal.reportPath,
          baseDir,
        });
      } catch {
        // Downstream checks remain authoritative.
      }
      try {
        generatedReports.geminiConcurrencyGate = runGeminiGateReport({
          scriptName: "uiq-gemini-concurrency-gate.mjs",
          profileName: profile.name,
          reportPath: multimodal.reportPath,
          baseDir,
        });
      } catch {
        // Downstream checks remain authoritative.
      }

      const geminiAccuracyReportPath =
        generatedReports.geminiAccuracyGate ??
        generatedReports.geminiAccuracy ??
        `reports/uiq-gemini-accuracy-gate-${profile.name}.json`;
      const accuracyGate = resolveGeminiGateCheck({
        baseDir,
        checkId: "ai_review.gemini_accuracy",
        expectedCheckId: "gemini_accuracy_min",
        reportPath: geminiAccuracyReportPath,
        metricField: "accuracy",
        thresholdField: "accuracyMin",
        missingReasonCode: "gate.ai_review.gemini_accuracy.blocked.report_missing",
        parseErrorReasonCode: "gate.ai_review.gemini_accuracy.blocked.report_parse_error",
        invalidPayloadReasonCode: "gate.ai_review.gemini_accuracy.blocked.invalid_report_payload",
      });
      if (accuracyGate.reportExists) {
        generatedReports.geminiAccuracyGate = geminiAccuracyReportPath;
      }
      checks.push(accuracyGate.check);

      const geminiConcurrencyReportPath =
        generatedReports.geminiConcurrencyGate ??
        generatedReports.geminiConcurrency ??
        `reports/uiq-gemini-concurrency-gate-${profile.name}.json`;
      const concurrencyGate = resolveGeminiGateCheck({
        baseDir,
        checkId: "ai_review.gemini_concurrency",
        expectedCheckId: "gemini_parallel_consistency_min",
        reportPath: geminiConcurrencyReportPath,
        metricField: "parallelConsistency",
        thresholdField: "parallelConsistencyMin",
        missingReasonCode: "gate.ai_review.gemini_concurrency.blocked.report_missing",
        parseErrorReasonCode: "gate.ai_review.gemini_concurrency.blocked.report_parse_error",
        invalidPayloadReasonCode:
          "gate.ai_review.gemini_concurrency.blocked.invalid_report_payload",
      });
      if (concurrencyGate.reportExists) {
        generatedReports.geminiConcurrencyGate = geminiConcurrencyReportPath;
      }
      checks.push(concurrencyGate.check);
    }
    fixResult = executeFixExecutor({
      baseDir,
      findings: aiReviewReport.findings,
      mode: resolveAiFixModeFromEnv(),
      allowlist: resolveAiFixAllowlistFromEnv(),
      reportPath: "reports/fix-result.json",
    });
    generatedReports.fixResult = fixResult.reportPath;
    checks.push({
      id: "ai_fix.execution",
      expected: fixResult.mode === "auto" ? "all_eligible_fixes_applied" : "report_only",
      actual: `mode=${fixResult.mode};tasks=${fixResult.summary.totalTasks};applied=${fixResult.summary.applied};failed=${fixResult.summary.failed};planned=${fixResult.summary.planned}`,
      severity: "MAJOR",
      status: fixResult.gate.status,
      reasonCode: fixResult.gate.reasonCode,
      evidencePath: fixResult.reportPath,
    });
  }

  const mapReasonCodeToEngine = (
    reasonCode: string | undefined,
  ): "crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6" | undefined => {
    const normalized = (reasonCode ?? "").toLowerCase();
    if (normalized.includes("crawlee_not_available")) {
      return "crawlee";
    }
    if (normalized.includes("lostpixel_not_available")) {
      return "lostpixel";
    }
    if (normalized.includes("backstop_not_available")) {
      return "backstop";
    }
    if (normalized.includes("semgrep_not_available")) {
      return "semgrep";
    }
    if (normalized.includes("k6_not_available")) {
      return "k6";
    }
    return undefined;
  };
  const blockedMissingFromChecks = checks
    .filter((check) => check.status === "blocked")
    .map((check) => mapReasonCodeToEngine(check.reasonCode))
    .filter(
      (engine): engine is "crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6" =>
        engine !== undefined,
    );
  const blockedMissingFromLoad = (loadSummary?.engines ?? [])
    .filter((engine) => engine.status === "blocked")
    .map((engine) => mapReasonCodeToEngine(engine.reasonCode ?? engine.detail))
    .filter(
      (engine): engine is "crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6" =>
        engine !== undefined,
    );
  const missingEngines = new Set([...blockedMissingFromChecks, ...blockedMissingFromLoad]);
  const availableEngines = new Set<"crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6">();
  if (effectiveExploreConfig?.engine === "crawlee" && !missingEngines.has("crawlee")) {
    availableEngines.add("crawlee");
  }
  if (effectiveVisualConfig?.engine === "lostpixel" && !missingEngines.has("lostpixel")) {
    availableEngines.add("lostpixel");
  }
  if (effectiveVisualConfig?.engine === "backstop" && !missingEngines.has("backstop")) {
    availableEngines.add("backstop");
  }
  if (effectiveSecurityConfig?.engine === "semgrep" && !missingEngines.has("semgrep")) {
    availableEngines.add("semgrep");
  }
  for (const engine of loadSummary?.engines ?? []) {
    if (engine.engine === "k6" && engine.status === "ok") {
      availableEngines.add("k6");
    }
  }
  const requiredEngines = (profile.enginePolicy?.required ?? []).filter(
    (engine): engine is "crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6" =>
      engine === "crawlee" ||
      engine === "lostpixel" ||
      engine === "backstop" ||
      engine === "semgrep" ||
      engine === "k6",
  );
  const allEngineKeys = new Set<"crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6">([
    ...requiredEngines,
    ...Array.from(availableEngines),
    ...Array.from(missingEngines),
  ]);
  const engineAvailability = Object.fromEntries(
    Array.from(allEngineKeys)
      .sort()
      .map((engine) => [
        engine,
        availableEngines.has(engine)
          ? "available"
          : missingEngines.has(engine)
            ? "missing"
            : "not_checked",
      ]),
  ) as Record<
    "crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6",
    "available" | "missing" | "not_checked"
  >;
  const missingRequiredEngines = requiredEngines.filter(
    (engine) => engineAvailability[engine] !== "available",
  );
  if (profile.enginePolicy?.failOnBlocked === true && requiredEngines.length > 0) {
    checks.push({
      id: "engine.policy.required",
      expected: "all_required_available",
      actual:
        missingRequiredEngines.length > 0
          ? `missing:${missingRequiredEngines.join(",")}`
          : "all_required_available",
      severity: "BLOCKER",
      status: missingRequiredEngines.length > 0 ? "failed" : "passed",
      reasonCode:
        missingRequiredEngines.length > 0
          ? gateReasonCode("engine.policy.required", "failed", "missing_required_engine")
          : gateReasonCode("engine.policy.required", "passed", "all_required_available"),
      evidencePath: "reports/summary.json",
    });
  }
  const blockedByMissingEngineCount = missingEngines.size;

  const startupChecks = checks.filter(
    (check) => check.id === "runtime.healthcheck" || check.id === "desktop.readiness",
  );
  const startupAvailable =
    startupChecks.length > 0
      ? startupChecks.every((check) => check.status === "passed")
        ? 1
        : 0
      : undefined;

  const desktopInteractionTotal = desktopE2EResult?.checks.length ?? 0;
  const desktopInteractionPassed =
    desktopE2EResult?.checks.filter((check) => check.status === "passed").length ?? 0;
  const fallbackInteractionChecks =
    desktopInteractionTotal > 0
      ? []
      : checks.filter((check) => check.id === "test.e2e" || check.id === "desktop.e2e");
  const interactionPassed =
    desktopInteractionPassed +
    fallbackInteractionChecks.filter((check) => check.status === "passed").length;
  const interactionTotal = desktopInteractionTotal + fallbackInteractionChecks.length;
  const interactionPassRatio =
    interactionTotal > 0 ? Number((interactionPassed / interactionTotal).toFixed(4)) : undefined;

  const configuredKeyGateChecks = checks.filter((check) =>
    CROSS_TARGET_KEY_GATE_CHECK_IDS.has(check.id),
  );
  const effectiveKeyGateChecks =
    configuredKeyGateChecks.length > 0 ? configuredKeyGateChecks : checks;
  const keyGatePassed = effectiveKeyGateChecks.filter((check) => check.status === "passed").length;
  const keyGateTotal = effectiveKeyGateChecks.length;
  const keyGatePassRatio =
    keyGateTotal > 0 ? Number((keyGatePassed / keyGateTotal).toFixed(4)) : undefined;

  const summary = {
    ...baseSummary,
    promptId: aiReviewPromptId,
    promptVersion: aiReviewPromptVersion,
    actualModel: aiReviewActualModel,
    aiModel: aiReviewActualModel,
    ...(typeof state.aiReviewFindingCount === "number"
      ? { aiReviewFindings: state.aiReviewFindingCount }
      : {}),
    ...(typeof state.aiReviewHighOrAbove === "number"
      ? { aiReviewHighOrAbove: state.aiReviewHighOrAbove }
      : {}),
    ...(typeof state.postFixRegression?.iterationsExecuted === "number"
      ? { fixIterations: state.postFixRegression.iterationsExecuted }
      : {}),
    ...(typeof state.postFixRegression?.converged === "boolean"
      ? { fixConverged: state.postFixRegression.converged }
      : {}),
    ...(startupAvailable !== undefined ? { startupAvailable } : {}),
    ...(interactionPassRatio !== undefined ? { interactionPassRatio } : {}),
    ...(typeof desktopSoakResult?.crashCount === "number"
      ? { crashCount: desktopSoakResult.crashCount }
      : {}),
    ...(typeof desktopSoakResult?.rssGrowthMb === "number"
      ? { rssGrowthMb: desktopSoakResult.rssGrowthMb }
      : {}),
    ...(typeof desktopSoakResult?.cpuAvgPercent === "number"
      ? { cpuAvg: desktopSoakResult.cpuAvgPercent }
      : {}),
    ...(Object.keys(engineAvailability).length > 0 ? { engineAvailability } : {}),
    ...(blockedByMissingEngineCount > 0
      ? { blockedByMissingEngineCount }
      : { blockedByMissingEngineCount: 0 }),
    ...(keyGatePassRatio !== undefined ? { keyGatePassRatio } : {}),
    ...(!state.postFixRegression && fixResult
      ? {
          fixIterations: fixResult.summary.totalTasks,
          fixConverged: fixResult.gate.status !== "failed",
        }
      : {}),
  };

  const normalizedCaptureDiagnostics = normalizeDiagnosticsSection(
    captureDiagnostics,
    effectiveDiagnosticsConfig.maxItems,
  );
  const normalizedExploreDiagnostics = normalizeDiagnosticsSection(
    exploreDiagnostics,
    effectiveDiagnosticsConfig.maxItems,
  );
  const normalizedChaosDiagnostics = normalizeDiagnosticsSection(
    chaosDiagnostics,
    effectiveDiagnosticsConfig.maxItems,
  );
  const aggregateHttp5xx = normalizeList(
    [
      ...captureDiagnostics.http5xxUrls,
      ...exploreDiagnostics.http5xxUrls,
      ...chaosDiagnostics.http5xxUrls,
    ],
    effectiveDiagnosticsConfig.maxItems,
  );
  const executionCriticalPath = Object.entries(stageDurationsMs)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([stageId]) => stageId);
  const failureLocations = collectFailureLocations(checks);
  const diagnostics = {
    capture: normalizedCaptureDiagnostics,
    explore: {
      ...normalizedExploreDiagnostics,
      engineUsed: exploreResultData?.engineUsed ?? effectiveExploreConfig?.engine,
    },
    chaos: normalizedChaosDiagnostics,
    load: loadSummary,
    tests: {
      unit: unitTestResult,
      contract: contractTestResult,
      ct: ctTestResult,
      e2e: e2eTestResult,
    },
    runtime: runtimeStart,
    a11y:
      a11yResultData !== undefined
        ? {
            engine: a11yResultData.engine,
            standard: a11yResultData.standard,
            counts: a11yResultData.counts,
          }
        : undefined,
    perf:
      perfResultData !== undefined
        ? {
            engine: perfResultData.engine,
            preset: perfResultData.preset,
            metrics: perfResultData.metrics,
          }
        : undefined,
    visual:
      visualResultData !== undefined
        ? {
            engine: visualResultData.engine,
            engineUsed: visualResultData.engineUsed,
            mode: visualResultData.mode,
            baselineCreated: visualResultData.baselineCreated,
            diffPixels: visualResultData.diffPixels,
            totalPixels: visualResultData.totalPixels,
            diffRatio: visualResultData.diffRatio,
            baselinePath: visualResultData.baselinePath,
            currentPath: visualResultData.currentPath,
            diffPath: visualResultData.diffPath,
          }
        : undefined,
    aiReview:
      state.aiReviewReportPath !== undefined
        ? {
            enabled: effectiveAiReviewConfig?.enabled ?? false,
            mode: aiReviewMode,
            promptId: aiReviewPromptId,
            promptVersion: aiReviewPromptVersion,
            actualModel: aiReviewActualModel,
            maxArtifacts: effectiveAiReviewConfig?.maxArtifacts ?? 0,
            severityThreshold: effectiveAiReviewConfig?.severityThreshold ?? "high",
            findings: state.aiReviewFindingCount ?? 0,
            highOrAbove: state.aiReviewHighOrAbove ?? 0,
            reportPath: state.aiReviewReportPath,
            markdownPath: state.aiReviewReportMarkdownPath,
          }
        : undefined,
    computerUse:
      computerUseResult !== undefined
        ? {
            status: computerUseResult.status,
            reason: computerUseResult.reason,
            exitCode: computerUseResult.exitCode,
            command: computerUseResult.command,
            args: computerUseResult.args,
            scriptPath: computerUseResult.scriptPath,
            computerUseSafetyConfirmations,
            safetyConfirmationEvidence: computerUseSafetyConfirmationEvidence,
            error: computerUseResult.error,
          }
        : undefined,
    security:
      securityReportPath !== undefined
        ? {
            executionStatus: (securityBlocked ? "blocked" : securityFailed ? "failed" : "ok") as
              | "ok"
              | "failed"
              | "blocked",
            blockedReason: securityBlockedReason,
            errorMessage: securityFailedReason,
            totalIssueCount: securityResult?.totalIssueCount,
            dedupedIssueCount: securityResult?.dedupedIssueCount,
            ticketCount: securityResult?.tickets.length,
            topTickets: securityResult?.tickets.slice(0, 10).map((ticket) => ({
              ticketId: ticket.ticketId,
              severity: ticket.severity,
              impactScope: ticket.impactScope,
              affectedFileCount: ticket.affectedFiles.length,
            })),
            highVulnCount,
            mediumVulnCount,
            lowVulnCount,
            clusters: securityResult
              ? {
                  byRule: securityResult.clusters.byRule.slice(0, 10),
                  byComponent: securityResult.clusters.byComponent.slice(0, 10),
                }
              : undefined,
          }
        : undefined,
    desktopReadiness: desktopReadinessResult,
    desktopSmoke: desktopSmokeResult,
    desktopE2E: desktopE2EResult,
    desktopBusiness: desktopBusinessResult,
    desktopSoak: desktopSoakResult,
    crossTarget: {
      startupAvailable,
      interactionPassed,
      interactionTotal,
      interactionPassRatio,
      keyGatePassed,
      keyGateTotal,
      keyGatePassRatio,
      crashCount: desktopSoakResult?.crashCount,
      rssGrowthMb: desktopSoakResult?.rssGrowthMb,
      cpuAvg: desktopSoakResult?.cpuAvgPercent,
    },
    postFixRegression: state.postFixRegression,
    http5xxUrls: aggregateHttp5xx.items,
    truncation: {
      http5xxUrls: aggregateHttp5xx.truncation,
    },
    execution: {
      maxParallelTasks,
      stagesMs: stageDurationsMs,
      criticalPath: executionCriticalPath,
    },
    cacheStats: {
      hits: cacheStatsResolution.hits,
      misses: cacheStatsResolution.misses,
      hitRate: cacheStatsResolution.hitRate,
      reason: cacheStatsResolution.reason,
      sourceCount: cacheStatsResolution.sourceCount,
      sourcePaths: cacheStatsResolution.sourcePaths,
      parseErrors: cacheStatsResolution.parseErrors,
      missingReports: cacheStatsResolution.missingReports,
    },
    blockedSteps: blockedStepReasons,
    blockedStepDetails,
    failureLocations,
    engineAvailability,
  };
  const status = resolveGateResultsStatus(checks);
  const reportPath = writeSummaryReportWithContext(baseDir, {
    status,
    checks,
    summary,
    thresholds,
    diagnostics,
    effectiveConfig: {
      explore: effectiveExploreConfig,
      chaos: effectiveChaosConfig,
      a11y: effectiveA11yConfig,
      perf: effectivePerfConfig,
      visual: effectiveVisualConfig,
      load: effectiveLoadConfig,
      security: effectiveSecurityConfig,
      diagnostics: effectiveDiagnosticsConfig,
      baseUrlPolicy,
      runtimeStart,
    },
  });
  const diagnosticsIndexPath = writeDiagnosticsIndex(baseDir, {
    runId: resolvedRunId,
    status,
    profile: profile.name,
    target: { type: target.type, name: target.name },
    reports: {
      summary: reportPath,
      ...(a11yReportPath ? { a11y: a11yReportPath } : {}),
      ...(perfReportPath ? { perf: perfReportPath } : {}),
      ...(visualReportPath ? { visual: visualReportPath } : {}),
      ...(state.aiReviewReportPath ? { aiReview: state.aiReviewReportPath } : {}),
      ...(securityReportPath ? { security: securityReportPath } : {}),
      ...(loadReportPath ? { load: loadReportPath } : {}),
    },
    diagnostics: {
      capture: {
        consoleErrors: normalizedCaptureDiagnostics.consoleErrors.length,
        pageErrors: normalizedCaptureDiagnostics.pageErrors.length,
        http5xxUrls: normalizedCaptureDiagnostics.http5xxUrls.length,
      },
      explore: {
        consoleErrors: normalizedExploreDiagnostics.consoleErrors.length,
        pageErrors: normalizedExploreDiagnostics.pageErrors.length,
        http5xxUrls: normalizedExploreDiagnostics.http5xxUrls.length,
      },
      chaos: {
        consoleErrors: normalizedChaosDiagnostics.consoleErrors.length,
        pageErrors: normalizedChaosDiagnostics.pageErrors.length,
        http5xxUrls: normalizedChaosDiagnostics.http5xxUrls.length,
      },
      aggregateHttp5xx: aggregateHttp5xx.items.length,
      execution: {
        maxParallelTasks,
        stagesMs: stageDurationsMs,
        criticalPath: executionCriticalPath,
      },
      blockedSteps: blockedStepReasons,
      blockedStepDetails,
      failureLocations,
    },
  });

  const reportEntries: Record<string, string> = {
    report: reportPath,
    ...generatedReports,
    ...(a11yReportPath ? { a11y: a11yReportPath } : {}),
    ...(perfReportPath ? { perf: perfReportPath } : {}),
    ...(visualReportPath ? { visual: visualReportPath } : {}),
    ...(securityReportPath ? { security: securityReportPath } : {}),
    ...(securityTicketsPath ? { securityTickets: securityTicketsPath } : {}),
    ...(desktopReadinessPath ? { desktopReadiness: desktopReadinessPath } : {}),
    ...(desktopSmokePath ? { desktopSmoke: desktopSmokePath } : {}),
    ...(desktopE2EPath ? { desktopE2E: desktopE2EPath } : {}),
    ...(desktopBusinessPath ? { desktopBusiness: desktopBusinessPath } : {}),
    ...(desktopSoakPath ? { desktopSoak: desktopSoakPath } : {}),
    ...(loadReportPath ? { load: loadReportPath } : {}),
    diagnosticsIndex: diagnosticsIndexPath,
  };

  const execution = {
    maxParallelTasks,
    stagesMs: stageDurationsMs,
    criticalPath: executionCriticalPath,
  };

  const evidenceIndex = buildEvidenceIndex(
    states,
    reportEntries,
    checks.map(normalizeCheckReasonCode),
  );
  const evidenceIndexPath = writeEvidenceIndex(baseDir, {
    runId: resolvedRunId,
    profile: profile.name,
    target: { type: target.type, name: target.name },
    items: evidenceIndex,
  });
  reportEntries.evidenceIndex = evidenceIndexPath;
  const finishedAt = new Date().toISOString();
  const manifest: Manifest = {
    schemaVersion: "1.1",
    runId: resolvedRunId,
    target: {
      type: target.type,
      name: target.name,
      baseUrl: effectiveBaseUrl,
      app: effectiveApp ?? "",
      bundleId: effectiveBundleId ?? "",
    },
    profile: profile.name,
    git: getGitInfo(),
    timing: {
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    },
    execution,
    states,
    evidenceIndex,
    reports: reportEntries,
    stateModel: {
      configuredRoutes: stateModel.configuredRoutes.length,
      configuredStories: stateModel.configuredStories.length,
      configuredTotal: stateModel.configuredTotal,
      capturedRoutes: states.filter((item) => item.source === "routes").length,
      capturedDiscovery: states.filter((item) => item.source === "discovery").length,
      capturedStories: states.filter((item) => item.source === "stories").length,
    },
    summary,
    diagnostics,
    runEnvironment: {
      autostart: runtimeStart.autostart,
      started: runtimeStart.started,
      healthcheckPassed: runtimeStart.healthcheckPassed,
      healthcheckUrl: runtimeStart.healthcheckUrl ?? "",
      healthcheckReason: runtimeStart.healthcheckReason ?? "",
      healthcheckDetail: runtimeStart.healthcheckDetail ?? "",
      host: process.platform,
      node: process.version,
      ci: Boolean(process.env.CI),
    },
    toolVersions: {
      node: process.version,
      a11y: effectiveA11yConfig?.engine ?? "axe",
      perf: effectivePerfConfig?.engine ?? "lhci",
      load: effectiveLoadConfig?.engines ?? ["builtin", "artillery", "k6"],
      security: effectiveSecurityConfig?.engine ?? "builtin",
    },
    gateResults: {
      status,
      checks: checks.map(normalizeCheckReasonCode),
    },
    toolchain: {
      toolchainVersion: TOOLCHAIN_VERSION,
      node: process.version,
      driver: target.driver,
      playwright: "installed",
      driverCapabilities: driverContract.capabilities,
      config: {
        explore: effectiveExploreConfig,
        chaos: effectiveChaosConfig,
        load: effectiveLoadConfig,
        security: effectiveSecurityConfig,
        aiReview: effectiveAiReviewConfig,
        diagnostics: effectiveDiagnosticsConfig,
        baseUrlPolicy,
      },
    },
  };

  const manifestPath = writeManifest(baseDir, manifest);
  return { manifestPath };
}
