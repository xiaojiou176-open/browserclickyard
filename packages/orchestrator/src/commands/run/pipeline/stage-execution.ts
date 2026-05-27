import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest } from "../../../../../core/src/manifest/types.js";
import type { A11yConfig, A11yResult } from "../../a11y.js";
import { runA11y } from "../../a11y.js";
import { runCapture } from "../../capture.js";
import type { ChaosConfig } from "../../chaos.js";
import { runChaos } from "../../chaos.js";
import type { ComputerUseExecutionResult, ComputerUseOptions } from "../../computer-use.js";
import { type DesktopReadinessResult, runDesktopReadiness } from "../../desktop.js";
import {
  type DesktopBusinessResult,
  runDesktopBusinessRegression,
} from "../../desktop-business.js";
import { type DesktopE2EResult, runDesktopE2E } from "../../desktop-e2e.js";
import { type DesktopSmokeResult, runDesktopSmoke } from "../../desktop-smoke.js";
import { type DesktopSoakResult, runDesktopSoak } from "../../desktop-soak.js";
import { runExplore } from "../../explore.js";
import type { LoadConfig } from "../../load.js";
import { runLoad } from "../../load.js";
import type { PerfConfig, PerfResult } from "../../perf.js";
import { runPerf } from "../../perf.js";
import { runSecurity, type SecurityConfig, type SecurityResult } from "../../security.js";
import type { loadStateModel } from "../../state-model.js";
import type { TestSuiteResult } from "../../test-suite.js";
import type { VisualConfig, VisualResult } from "../../visual.js";
import { runVisual } from "../../visual.js";
import { type ConcurrentTask, runWithConcurrencyLimit, throwIfAborted } from "../concurrency.js";
import { gateReasonCode } from "../run-reporting.js";
import {
  optimizeNightlyChaosConfig,
  resolveA11yConfig,
  resolveAiReviewConfig,
  resolveChaosConfig,
  resolveComputerUseConfig,
  resolveDesktopSoakConfig,
  resolveExploreConfig,
  resolveLoadConfig,
  resolvePerfConfig,
  resolveSecurityConfig,
  resolveVisualConfig,
} from "../run-resolve.js";
import type {
  AiReviewConfig,
  ExploreConfig,
  ProfileConfig,
  RunOverrides,
  TargetConfig,
} from "../run-types.js";

export type DiagnosticsBucket = {
  consoleErrors: string[];
  pageErrors: string[];
  http5xxUrls: string[];
};

export type PostFixRegressionReport = {
  generatedAt: string;
  status: "passed" | "failed" | "skipped";
  reasonCode: string;
  maxIterations: number;
  iterationsExecuted: number;
  fixResultPath?: string;
  fixResultExecutable: boolean;
  converged: boolean;
  initialFailedSuites: Array<"unit" | "contract" | "ct" | "e2e">;
  remainingFailedSuites: Array<"unit" | "contract" | "ct" | "e2e">;
  iterations: Array<{
    iteration: number;
    rerunSuites: Array<"unit" | "contract" | "ct" | "e2e">;
    results: Array<{
      suite: "unit" | "contract" | "ct" | "e2e";
      status: "passed" | "failed";
      reportPath: string;
      exitCode: number;
    }>;
  }>;
};

export type PipelineStageState = {
  states: Manifest["states"];
  pageErrorFromChaos: number;
  consoleErrorFromChaos: number;
  http5xxFromChaos: number;
  dangerousActionHitsFromChaos: number;
  pageErrorFromExplore: number;
  consoleErrorFromExplore: number;
  http5xxFromExplore: number;
  dangerousActionHitsFromExplore: number;
  effectiveExploreConfig: ExploreConfig | undefined;
  effectiveChaosConfig: ChaosConfig | undefined;
  effectiveLoadConfig: LoadConfig | undefined;
  effectiveA11yConfig: A11yConfig | undefined;
  effectivePerfConfig: PerfConfig | undefined;
  effectiveVisualConfig: VisualConfig | undefined;
  effectiveSecurityConfig: SecurityConfig | undefined;
  effectiveAiReviewConfig: AiReviewConfig | undefined;
  exploreResultData: Awaited<ReturnType<typeof runExplore>> | undefined;
  exploreEngineBlockedReasonCode: string | undefined;
  visualEngineBlockedReasonCode: string | undefined;
  aiReviewReportPath: string | undefined;
  aiReviewReportMarkdownPath: string | undefined;
  aiReviewFindingCount: number | undefined;
  aiReviewHighOrAbove: number | undefined;
  captureSummary: {
    consoleError: number;
    pageError: number;
    http5xx: number;
  };
  captureDiagnostics: DiagnosticsBucket;
  exploreDiagnostics: DiagnosticsBucket;
  chaosDiagnostics: DiagnosticsBucket;
  highVulnCount: number;
  mediumVulnCount: number;
  lowVulnCount: number;
  securityResult: SecurityResult | undefined;
  securityBlocked: boolean;
  securityBlockedReason: string | undefined;
  securityFailed: boolean;
  securityFailedReason: string | undefined;
  loadSummary:
    | {
        totalRequests: number;
        failedRequests: number;
        http5xx: number;
        requestsPerSecond: number;
        latencyP95Ms: number;
        engines: Array<{
          engine: "builtin" | "artillery" | "k6";
          status: "ok" | "failed" | "blocked";
          detail: string;
          reasonCode?: string;
          requestsPerSecond?: number;
          p95Ms?: number;
          failedRequests?: number;
        }>;
      }
    | undefined;
  a11ySummary:
    | {
        serious: number;
        total: number;
      }
    | undefined;
  a11yResultData: A11yResult | undefined;
  perfSummary:
    | {
        lcpMs: number;
        fcpMs: number;
      }
    | undefined;
  perfResultData: PerfResult | undefined;
  visualSummary:
    | {
        diffPixels: number;
        baselineCreated: boolean;
      }
    | undefined;
  visualResultData: VisualResult | undefined;
  securityReportPath: string | undefined;
  securityTicketsPath: string | undefined;
  loadReportPath: string | undefined;
  desktopReadinessPath: string | undefined;
  desktopReadinessResult: DesktopReadinessResult | undefined;
  desktopSmokePath: string | undefined;
  desktopSmokeResult: DesktopSmokeResult | undefined;
  desktopE2EPath: string | undefined;
  desktopE2EResult: DesktopE2EResult | undefined;
  desktopBusinessPath: string | undefined;
  desktopBusinessResult: DesktopBusinessResult | undefined;
  desktopSoakPath: string | undefined;
  desktopSoakResult: DesktopSoakResult | undefined;
  a11yReportPath: string | undefined;
  perfReportPath: string | undefined;
  visualReportPath: string | undefined;
  unitTestResult: TestSuiteResult | undefined;
  contractTestResult: TestSuiteResult | undefined;
  ctTestResult: TestSuiteResult | undefined;
  e2eTestResult: TestSuiteResult | undefined;
  postFixRegression: PostFixRegressionReport | undefined;
  computerUseResult: ComputerUseExecutionResult | undefined;
  computerUseSafetyConfirmations: number;
  computerUseSafetyConfirmationEvidence:
    | {
        events: Array<Record<string, unknown>>;
      }
    | undefined;
  generatedReports: Record<string, string>;
};

export function createInitialPipelineStageState(runtimeReportPath: string): PipelineStageState {
  return {
    states: [],
    pageErrorFromChaos: 0,
    consoleErrorFromChaos: 0,
    http5xxFromChaos: 0,
    dangerousActionHitsFromChaos: 0,
    pageErrorFromExplore: 0,
    consoleErrorFromExplore: 0,
    http5xxFromExplore: 0,
    dangerousActionHitsFromExplore: 0,
    effectiveExploreConfig: undefined,
    effectiveChaosConfig: undefined,
    effectiveLoadConfig: undefined,
    effectiveA11yConfig: undefined,
    effectivePerfConfig: undefined,
    effectiveVisualConfig: undefined,
    effectiveSecurityConfig: undefined,
    effectiveAiReviewConfig: undefined,
    exploreResultData: undefined,
    exploreEngineBlockedReasonCode: undefined,
    visualEngineBlockedReasonCode: undefined,
    aiReviewReportPath: undefined,
    aiReviewReportMarkdownPath: undefined,
    aiReviewFindingCount: undefined,
    aiReviewHighOrAbove: undefined,
    captureSummary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
    },
    captureDiagnostics: {
      consoleErrors: [],
      pageErrors: [],
      http5xxUrls: [],
    },
    exploreDiagnostics: {
      consoleErrors: [],
      pageErrors: [],
      http5xxUrls: [],
    },
    chaosDiagnostics: {
      consoleErrors: [],
      pageErrors: [],
      http5xxUrls: [],
    },
    highVulnCount: 0,
    mediumVulnCount: 0,
    lowVulnCount: 0,
    securityResult: undefined,
    securityBlocked: false,
    securityBlockedReason: undefined,
    securityFailed: false,
    securityFailedReason: undefined,
    loadSummary: undefined,
    a11ySummary: undefined,
    a11yResultData: undefined,
    perfSummary: undefined,
    perfResultData: undefined,
    visualSummary: undefined,
    visualResultData: undefined,
    securityReportPath: undefined,
    securityTicketsPath: undefined,
    loadReportPath: undefined,
    desktopReadinessPath: undefined,
    desktopReadinessResult: undefined,
    desktopSmokePath: undefined,
    desktopSmokeResult: undefined,
    desktopE2EPath: undefined,
    desktopE2EResult: undefined,
    desktopBusinessPath: undefined,
    desktopBusinessResult: undefined,
    desktopSoakPath: undefined,
    desktopSoakResult: undefined,
    a11yReportPath: undefined,
    perfReportPath: undefined,
    visualReportPath: undefined,
    unitTestResult: undefined,
    contractTestResult: undefined,
    ctTestResult: undefined,
    e2eTestResult: undefined,
    postFixRegression: undefined,
    computerUseResult: undefined,
    computerUseSafetyConfirmations: 0,
    computerUseSafetyConfirmationEvidence: undefined,
    generatedReports: {
      runtime: runtimeReportPath,
    },
  };
}

type StageExecutionInput = {
  baseDir: string;
  profile: ProfileConfig;
  target: TargetConfig;
  overrides: RunOverrides | undefined;
  isWebTarget: boolean;
  effectiveBaseUrl: string;
  effectiveApp: string | undefined;
  effectiveBundleId: string | undefined;
  unsupportedSteps: Set<string>;
  maxParallelTasks: number;
  stateModel: ReturnType<typeof loadStateModel>;
  stepRequested: (stepId: string) => boolean;
  recordBlockedStep: (
    stepId: string,
    detail: string,
    options?: {
      reasonCode?: string;
      artifactPath?: string;
    },
  ) => void;
  runStage: (stageId: string, signal: AbortSignal, task: () => Promise<void>) => Promise<void>;
  ensureRuntimeReady: (stepId: string, signal: AbortSignal) => Promise<void>;
  ensureRuntimeReadySerialized: (stepId: string, signal: AbortSignal) => Promise<void>;
  runTestSuite: (
    suite: "unit" | "contract" | "ct" | "e2e",
    signal: AbortSignal,
  ) => Promise<TestSuiteResult>;
  runComputerUse: (options: ComputerUseOptions) => ComputerUseExecutionResult;
};

export async function executePipelineStages(
  input: StageExecutionInput,
  state: PipelineStageState,
): Promise<void> {
  const useCaptureApiMock =
    input.target.type === "web" &&
    (input.target.name === "web.ci" || process.env.UIQ_CAPTURE_API_MOCK === "1");
  const exploreConfigSnapshot =
    input.stepRequested("explore") && input.isWebTarget
      ? resolveExploreConfig(input.target, input.profile, input.overrides)
      : undefined;
  if (exploreConfigSnapshot) {
    state.effectiveExploreConfig = exploreConfigSnapshot;
  }

  const bootTasks: ConcurrentTask[] = [];
  if (input.stepRequested("capture") && input.isWebTarget) {
    bootTasks.push(async (signal) => {
      await input.runStage("capture", signal, async () => {
        throwIfAborted(signal);
        await input.ensureRuntimeReadySerialized("capture", signal);
        throwIfAborted(signal);
        const capture = await runCapture(input.baseDir, input.effectiveBaseUrl, {
          states: [...input.stateModel.configuredRoutes, ...input.stateModel.configuredStories],
          mockApis: useCaptureApiMock,
        });
        throwIfAborted(signal);
        state.states = capture.states;
        state.captureSummary = capture.summary;
        state.captureDiagnostics = capture.diagnostics;
      });
    });
  } else if (input.profile.steps.includes("capture") && !input.unsupportedSteps.has("capture")) {
    input.recordBlockedStep("capture", `unsupported for target.type=${input.target.type}`);
  }

  const testSuiteTasks: ConcurrentTask[] = [];
  if (input.profile.steps.includes("unit")) {
    testSuiteTasks.push(async (signal) => {
      await input.runStage("test.unit", signal, async () => {
        throwIfAborted(signal);
        const unitResult = await input.runTestSuite("unit", signal);
        throwIfAborted(signal);
        state.unitTestResult = unitResult;
        state.generatedReports.testUnit = state.unitTestResult.reportPath;
      });
    });
  }
  if (input.profile.steps.includes("contract")) {
    testSuiteTasks.push(async (signal) => {
      await input.runStage("test.contract", signal, async () => {
        throwIfAborted(signal);
        const contractResult = await input.runTestSuite("contract", signal);
        throwIfAborted(signal);
        state.contractTestResult = contractResult;
        state.generatedReports.testContract = state.contractTestResult.reportPath;
      });
    });
  }
  if (input.profile.steps.includes("ct")) {
    testSuiteTasks.push(async (signal) => {
      await input.runStage("test.ct", signal, async () => {
        throwIfAborted(signal);
        const ctResult = await input.runTestSuite("ct", signal);
        throwIfAborted(signal);
        state.ctTestResult = ctResult;
        state.generatedReports.testCt = state.ctTestResult.reportPath;
      });
    });
  }
  if (input.profile.steps.includes("e2e")) {
    testSuiteTasks.push(async (signal) => {
      await input.runStage("test.e2e", signal, async () => {
        throwIfAborted(signal);
        const e2eResult = await input.runTestSuite("e2e", signal);
        throwIfAborted(signal);
        state.e2eTestResult = e2eResult;
        state.generatedReports.testE2e = state.e2eTestResult.reportPath;
      });
    });
  }
  await runWithConcurrencyLimit([...bootTasks, ...testSuiteTasks], input.maxParallelTasks);

  const scenarioAndQualityTasks: ConcurrentTask[] = [];
  if (input.stepRequested("explore") && input.isWebTarget) {
    scenarioAndQualityTasks.push(async (signal) => {
      await input.runStage("scenario.explore", signal, async () => {
        throwIfAborted(signal);
        await input.ensureRuntimeReadySerialized("explore", signal);
        throwIfAborted(signal);
        const effectiveExploreConfig =
          exploreConfigSnapshot ??
          resolveExploreConfig(input.target, input.profile, input.overrides);
        const explore = await runExplore(input.baseDir, effectiveExploreConfig);
        throwIfAborted(signal);
        state.effectiveExploreConfig = effectiveExploreConfig;
        state.exploreResultData = explore;
        state.generatedReports.explore = explore.reportPath;
        state.states = [...state.states, ...explore.states];
        state.pageErrorFromExplore = explore.crashCount;
        state.consoleErrorFromExplore = explore.consoleErrorCount;
        state.http5xxFromExplore = explore.http5xxCount;
        state.dangerousActionHitsFromExplore = explore.dangerousActionHits;
        if (explore.executionStatus === "blocked") {
          state.exploreEngineBlockedReasonCode = explore.blockedReasonCode;
        }
        state.exploreDiagnostics = {
          consoleErrors: explore.consoleErrors,
          pageErrors: explore.pageErrors,
          http5xxUrls: explore.http5xxUrls,
        };
      });
    });
  } else if (input.profile.steps.includes("explore") && !input.unsupportedSteps.has("explore")) {
    input.recordBlockedStep("explore", `unsupported for target.type=${input.target.type}`);
  }

  if (input.stepRequested("chaos") && input.isWebTarget) {
    scenarioAndQualityTasks.push(async (signal) => {
      await input.runStage("scenario.chaos", signal, async () => {
        throwIfAborted(signal);
        await input.ensureRuntimeReadySerialized("chaos", signal);
        throwIfAborted(signal);
        const resolvedChaosConfig = resolveChaosConfig(
          input.target,
          input.profile,
          input.overrides,
        );
        const effectiveChaosConfig = optimizeNightlyChaosConfig(
          resolvedChaosConfig,
          input.profile,
          exploreConfigSnapshot,
          input.overrides,
        );
        const chaos = await runChaos(input.baseDir, effectiveChaosConfig);
        throwIfAborted(signal);
        state.effectiveChaosConfig = effectiveChaosConfig;
        state.pageErrorFromChaos = chaos.pageErrorCount;
        state.consoleErrorFromChaos = chaos.consoleErrorCount;
        state.http5xxFromChaos = chaos.http5xxCount;
        state.dangerousActionHitsFromChaos = chaos.dangerousActionHits;
        state.chaosDiagnostics = {
          consoleErrors: chaos.consoleErrors,
          pageErrors: chaos.pageErrors,
          http5xxUrls: chaos.http5xxUrls,
        };
        state.generatedReports.chaos = chaos.reportPath;
      });
    });
  } else if (input.profile.steps.includes("chaos") && !input.unsupportedSteps.has("chaos")) {
    input.recordBlockedStep("chaos", `unsupported for target.type=${input.target.type}`);
  }

  const wantsA11y = input.stepRequested("a11y");
  const wantsPerf = input.stepRequested("perf");
  const wantsVisual = input.stepRequested("visual");
  if ((wantsA11y || wantsPerf || wantsVisual) && input.isWebTarget) {
    if (wantsA11y) {
      scenarioAndQualityTasks.push(async (signal) => {
        await input.runStage("quality.a11y", signal, async () => {
          throwIfAborted(signal);
          await input.ensureRuntimeReadySerialized("a11y", signal);
          throwIfAborted(signal);
          state.effectiveA11yConfig = resolveA11yConfig(
            input.target,
            input.profile,
            input.overrides,
          );
          const a11y = await runA11y(input.baseDir, state.effectiveA11yConfig);
          throwIfAborted(signal);
          state.a11yResultData = a11y;
          state.a11ySummary = {
            serious: a11y.counts.serious + a11y.counts.critical,
            total: a11y.counts.total,
          };
          state.a11yReportPath = a11y.reportPath;
        });
      });
    }
    if (wantsPerf) {
      scenarioAndQualityTasks.push(async (signal) => {
        await input.runStage("quality.perf", signal, async () => {
          throwIfAborted(signal);
          await input.ensureRuntimeReadySerialized("perf", signal);
          throwIfAborted(signal);
          state.effectivePerfConfig = resolvePerfConfig(
            input.target,
            input.profile,
            input.overrides,
          );
          const perf = await runPerf(input.baseDir, state.effectivePerfConfig);
          throwIfAborted(signal);
          state.perfResultData = perf;
          state.perfSummary = {
            lcpMs: perf.metrics.largestContentfulPaintMs,
            fcpMs: perf.metrics.firstContentfulPaintMs,
          };
          state.perfReportPath = perf.reportPath;
        });
      });
    }
    if (wantsVisual) {
      scenarioAndQualityTasks.push(async (signal) => {
        await input.runStage("quality.visual", signal, async () => {
          throwIfAborted(signal);
          await input.ensureRuntimeReadySerialized("visual", signal);
          throwIfAborted(signal);
          state.effectiveVisualConfig = resolveVisualConfig(
            input.target,
            input.profile,
            input.overrides,
          );
          const visual = await runVisual(input.baseDir, state.effectiveVisualConfig);
          throwIfAborted(signal);
          state.visualResultData = visual;
          state.visualSummary = {
            diffPixels: visual.diffPixels,
            baselineCreated: visual.baselineCreated,
          };
          if (visual.executionStatus === "blocked") {
            state.visualEngineBlockedReasonCode = visual.blockedReasonCode;
          }
          state.visualReportPath = visual.reportPath;
        });
      });
    }
  } else {
    if (wantsA11y) {
      input.recordBlockedStep("a11y", `unsupported for target.type=${input.target.type}`);
    }
    if (wantsPerf) {
      input.recordBlockedStep("perf", `unsupported for target.type=${input.target.type}`);
    }
    if (wantsVisual) {
      input.recordBlockedStep("visual", `unsupported for target.type=${input.target.type}`);
    }
  }

  if (input.stepRequested("load") && input.isWebTarget) {
    scenarioAndQualityTasks.push(async (signal) => {
      await input.runStage("scenario.load", signal, async () => {
        throwIfAborted(signal);
        await input.ensureRuntimeReadySerialized("load", signal);
        throwIfAborted(signal);
        state.effectiveLoadConfig = resolveLoadConfig(input.target, input.profile, input.overrides);
        const load = await runLoad(input.baseDir, state.effectiveLoadConfig);
        throwIfAborted(signal);
        state.loadSummary = {
          totalRequests: load.totalRequests,
          failedRequests: load.failedRequests,
          http5xx: load.http5xx,
          requestsPerSecond: load.requestsPerSecond,
          latencyP95Ms: load.latencyMs.p95,
          engines: load.engines,
        };
        state.loadReportPath = load.reportPath;
      });
    });
  } else if (input.profile.steps.includes("load") && !input.unsupportedSteps.has("load")) {
    input.recordBlockedStep("load", `unsupported for target.type=${input.target.type}`);
  }
  if (input.stepRequested("computer_use") && input.isWebTarget) {
    const computerUse = resolveComputerUseConfig(input.target, input.profile, input.overrides);
    const computerUseTask = computerUse.task?.trim();
    if (computerUse.enabled === false) {
      input.recordBlockedStep("computer_use", "computerUse.enabled=false", {
        reasonCode: gateReasonCode("scenario.computer_use", "blocked", "disabled_by_config"),
        artifactPath: "reports/computer-use.json",
      });
    } else if (!computerUseTask) {
      input.recordBlockedStep(
        "computer_use",
        "missing computer-use task (profile.computerUse.task > target.computerUse.task > UIQ_COMPUTER_USE_TASK)",
        {
          reasonCode: gateReasonCode("scenario.computer_use", "blocked", "task_missing"),
          artifactPath: "reports/computer-use.json",
        },
      );
    } else {
      scenarioAndQualityTasks.push(async (signal) => {
        await input.runStage("scenario.computer_use", signal, async () => {
          throwIfAborted(signal);
          await input.ensureRuntimeReadySerialized("computer_use", signal);
          throwIfAborted(signal);
          const result = input.runComputerUse({
            task: computerUseTask,
            maxSteps: computerUse.maxSteps,
            speedMode: computerUse.speedMode,
          });
          throwIfAborted(signal);
          state.computerUseResult = result;
          state.computerUseSafetyConfirmations = result.computerUseSafetyConfirmations;
          state.computerUseSafetyConfirmationEvidence = result.safetyConfirmationEvidence;
          const reportPath = "reports/computer-use.json";
          writeFileSync(
            resolve(input.baseDir, reportPath),
            `${JSON.stringify(result, null, 2)}\n`,
            "utf8",
          );
          state.generatedReports.computerUse = reportPath;
        });
      });
    }
  } else if (
    input.profile.steps.includes("computer_use") &&
    !input.unsupportedSteps.has("computer_use")
  ) {
    input.recordBlockedStep("computer_use", `unsupported for target.type=${input.target.type}`, {
      reasonCode: gateReasonCode("scenario.computer_use", "blocked", "unsupported_target_type"),
      artifactPath: "reports/computer-use.json",
    });
  }

  if (input.profile.steps.includes("security")) {
    scenarioAndQualityTasks.push(async (signal) => {
      await input.runStage("scenario.security", signal, async () => {
        throwIfAborted(signal);
        state.effectiveSecurityConfig = resolveSecurityConfig(input.target, input.profile);
        const security = runSecurity(input.baseDir, state.effectiveSecurityConfig);
        throwIfAborted(signal);
        state.securityResult = security;
        state.securityBlocked = security.executionStatus === "blocked";
        state.securityBlockedReason = security.blockedReason;
        state.securityFailed = security.executionStatus === "failed";
        state.securityFailedReason = security.errorMessage;
        state.highVulnCount = security.highVulnCount;
        state.mediumVulnCount = security.mediumVulnCount;
        state.lowVulnCount = security.lowVulnCount;
        state.securityReportPath = security.reportPath;
        state.securityTicketsPath = security.ticketsPath;
      });
    });
  }
  await runWithConcurrencyLimit(scenarioAndQualityTasks, input.maxParallelTasks);

  if (input.stepRequested("desktop_readiness")) {
    state.desktopReadinessResult = runDesktopReadiness(input.baseDir, {
      targetType: input.target.type,
      app: input.effectiveApp,
      bundleId: input.effectiveBundleId,
    });
    state.desktopReadinessPath = state.desktopReadinessResult.reportPath;
  }
  if (input.stepRequested("desktop_smoke")) {
    state.desktopSmokeResult = await runDesktopSmoke(input.baseDir, {
      targetType: input.target.type,
      app: input.effectiveApp,
      bundleId: input.effectiveBundleId,
    });
    state.desktopSmokePath = state.desktopSmokeResult.reportPath;
  }
  if (input.stepRequested("desktop_e2e")) {
    state.desktopE2EResult = await runDesktopE2E(input.baseDir, {
      targetType: input.target.type,
      app: input.effectiveApp,
      bundleId: input.effectiveBundleId,
    });
    state.desktopE2EPath = state.desktopE2EResult.reportPath;
  }
  if (input.stepRequested("desktop_business_regression")) {
    state.desktopBusinessResult = await runDesktopBusinessRegression(input.baseDir, {
      targetType: input.target.type,
      app: input.effectiveApp,
      bundleId: input.effectiveBundleId,
      businessInteractionRequired: input.profile.desktopE2E?.keyboardInteractionRequired !== false,
    });
    state.desktopBusinessPath = state.desktopBusinessResult.reportPath;
  }
  if (input.stepRequested("desktop_soak")) {
    state.desktopSoakResult = await runDesktopSoak(
      input.baseDir,
      resolveDesktopSoakConfig(input.target, input.profile, input.overrides),
    );
    state.desktopSoakPath = state.desktopSoakResult.reportPath;
  }

  state.effectiveAiReviewConfig = resolveAiReviewConfig(
    input.target,
    input.profile,
    input.overrides,
  );
}
