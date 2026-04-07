import { ensureRunDirectories } from "../../../../core/src/artifacts/runtimePaths.js";
import type { Manifest } from "../../../../core/src/manifest/types.js";
import { type A11yConfig, type A11yResult, runA11y } from "../a11y.js";
import { runCapture } from "../capture.js";
import { type ChaosConfig, runChaos } from "../chaos.js";
import { type DesktopReadinessResult, runDesktopReadiness } from "../desktop.js";
import { type DesktopE2EResult, runDesktopE2E } from "../desktop-e2e.js";
import { type DesktopSmokeResult, runDesktopSmoke } from "../desktop-smoke.js";
import { type DesktopSoakResult, runDesktopSoak } from "../desktop-soak.js";
import { runExplore } from "../explore.js";
import { type LoadConfig, runLoad } from "../load.js";
import { type PerfConfig, type PerfResult, runPerf } from "../perf.js";
import { runSecurity, type SecurityConfig, type SecurityResult } from "../security.js";
import { loadStateModel } from "../state-model.js";
import { startTargetRuntime } from "../target-runtime.js";
import type { TestSuiteResult } from "../test-suite.js";
import { runVisual, type VisualConfig, type VisualResult } from "../visual.js";
import {
  type ConcurrentTask,
  resolveMaxParallelTasks,
  runTestSuiteAsync,
  runWithConcurrencyLimit,
  throwIfAborted,
} from "./concurrency.js";
import {
  assertBaseUrlAllowed,
  type ExploreConfig,
  loadProfileConfig,
  loadTargetConfig,
  normalizeBaseUrl,
  optimizeNightlyChaosConfig,
  type RunOverrides,
  resolveA11yConfig,
  resolveChaosConfig,
  resolveDesktopSoakConfig,
  resolveDiagnosticsConfig,
  resolveExploreConfig,
  resolveLoadConfig,
  resolvePerfConfig,
  resolveSecurityConfig,
  resolveVisualConfig,
} from "./config.js";
import { finalizeProfileRunArtifacts } from "./profile-finalize.js";
import type { BlockedStepDetail } from "./reporting.js";

function applyGeminiStrategyEnv(overrides?: RunOverrides): Record<string, string | undefined> {
  const mappings: Array<[string, string | undefined]> = [
    ["GEMINI_MODEL", overrides?.geminiModel],
    ["GEMINI_THINKING_LEVEL", overrides?.geminiThinkingLevel],
    ["GEMINI_TOOL_MODE", overrides?.geminiToolMode],
    ["GEMINI_CONTEXT_CACHE_MODE", overrides?.geminiContextCacheMode],
    ["GEMINI_MEDIA_RESOLUTION_DEFAULT", overrides?.geminiMediaResolution],
  ];
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of mappings) {
    previous.set(key, process.env[key]);
    if (value && value.trim().length > 0) {
      process.env[key] = value;
    }
  }
  return Object.fromEntries(previous);
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export async function runProfile(
  profileName: string,
  targetName: string,
  runId?: string,
  overrides?: RunOverrides,
): Promise<{ runId: string; manifestPath: string }> {
  const geminiEnvSnapshot = applyGeminiStrategyEnv(overrides);
  const profile = loadProfileConfig(profileName);
  const target = loadTargetConfig(targetName);
  const isWebTarget = target.type === "web";

  const resolvedRunId = runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();
  const baseDir = ensureRunDirectories(resolvedRunId);
  const effectiveApp = overrides?.app ?? target.app;
  const effectiveBundleId = overrides?.bundleId ?? target.bundleId;
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  const effectiveBaseUrl = effectiveBaseUrlRaw
    ? normalizeBaseUrl(effectiveBaseUrlRaw, target.name)
    : undefined;
  if (isWebTarget && !effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for web profile run`);
  }
  const requireEffectiveBaseUrl = (): string => {
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for web profile run`);
    }
    return effectiveBaseUrl;
  };
  const baseUrlPolicy = assertBaseUrlAllowed(
    target,
    effectiveBaseUrl ?? "http://127.0.0.1",
    overrides?.allowAllUrls ?? false,
  );
  const stateModel = loadStateModel();
  const autostartEnabled = overrides?.autostartTarget ?? true;
  const startConfig = {
    enabled: isWebTarget && autostartEnabled,
    baseDir,
    startCommands: target.start,
    healthcheckUrl: target.healthcheck?.url ?? effectiveBaseUrl,
  };
  const healthcheckUrl = startConfig.healthcheckUrl;
  let runtimeStart = await startTargetRuntime(startConfig);
  const blockedStepReasons: string[] = [];
  const blockedStepDetails: BlockedStepDetail[] = [];
  const recordBlockedStep = (stepId: string, detail: string): void => {
    blockedStepReasons.push(`step.${stepId} ${detail}`);
    blockedStepDetails.push({
      stepId,
      reasonCode: "gate.driver_capability.blocked.unsupported_target_type",
      detail,
      artifactPath: "reports/summary.json",
    });
  };

  let states = [] as Manifest["states"];
  let pageErrorFromChaos = 0;
  let consoleErrorFromChaos = 0;
  let http5xxFromChaos = 0;
  let pageErrorFromExplore = 0;
  let consoleErrorFromExplore = 0;
  let http5xxFromExplore = 0;
  let effectiveExploreConfig: ExploreConfig | undefined;
  let effectiveChaosConfig: ChaosConfig | undefined;
  let effectiveLoadConfig: LoadConfig | undefined;
  let effectiveA11yConfig: A11yConfig | undefined;
  let effectivePerfConfig: PerfConfig | undefined;
  let effectiveVisualConfig: VisualConfig | undefined;
  let effectiveSecurityConfig: SecurityConfig | undefined;
  const effectiveDiagnosticsConfig = resolveDiagnosticsConfig(
    target,
    profile,
    overrides?.diagnosticsMaxItems,
  );
  let captureSummary = {
    consoleError: 0,
    pageError: 0,
    http5xx: 0,
  };
  let captureDiagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    http5xxUrls: [] as string[],
  };
  let exploreDiagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    http5xxUrls: [] as string[],
  };
  let exploreResultData: Awaited<ReturnType<typeof runExplore>> | undefined;
  let chaosDiagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    http5xxUrls: [] as string[],
  };
  let highVulnCount = 0;
  let mediumVulnCount = 0;
  let lowVulnCount = 0;
  let securityResult: SecurityResult | undefined;
  let securityBlocked = false;
  let securityBlockedReason: string | undefined;
  let securityFailed = false;
  let securityFailedReason: string | undefined;
  let loadSummary:
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
          requestsPerSecond?: number;
          p95Ms?: number;
          failedRequests?: number;
        }>;
      }
    | undefined;
  let a11ySummary:
    | {
        serious: number;
        total: number;
      }
    | undefined;
  let a11yResultData: A11yResult | undefined;
  let perfSummary:
    | {
        lcpMs: number;
        fcpMs: number;
      }
    | undefined;
  let perfResultData: PerfResult | undefined;
  let visualSummary:
    | {
        diffPixels: number;
        baselineCreated: boolean;
      }
    | undefined;
  let visualResultData: VisualResult | undefined;
  let securityReportPath: string | undefined;
  let securityTicketsPath: string | undefined;
  let loadReportPath: string | undefined;
  let desktopReadinessPath: string | undefined;
  let desktopReadinessResult: DesktopReadinessResult | undefined;
  let desktopSmokePath: string | undefined;
  let desktopSmokeResult: DesktopSmokeResult | undefined;
  let desktopE2EPath: string | undefined;
  let desktopE2EResult: DesktopE2EResult | undefined;
  let desktopSoakPath: string | undefined;
  let desktopSoakResult: DesktopSoakResult | undefined;
  let a11yReportPath: string | undefined;
  let perfReportPath: string | undefined;
  let visualReportPath: string | undefined;
  let unitTestResult: TestSuiteResult | undefined;
  let contractTestResult: TestSuiteResult | undefined;
  let ctTestResult: TestSuiteResult | undefined;
  let e2eTestResult: TestSuiteResult | undefined;
  const generatedReports: Record<string, string> = {
    runtime: runtimeStart.reportPath,
  };
  const effectiveGeminiStrategy = {
    model: overrides?.geminiModel ?? process.env.GEMINI_MODEL ?? "gemini-3.1-pro-preview",
    thinking: overrides?.geminiThinkingLevel ?? process.env.GEMINI_THINKING_LEVEL ?? "high",
    toolMode: overrides?.geminiToolMode ?? process.env.GEMINI_TOOL_MODE ?? "auto",
    contextCacheMode:
      overrides?.geminiContextCacheMode ?? process.env.GEMINI_CONTEXT_CACHE_MODE ?? "memory",
    mediaResolution:
      overrides?.geminiMediaResolution ??
      process.env.GEMINI_MEDIA_RESOLUTION_DEFAULT ??
      process.env.GEMINI_MEDIA_RESOLUTION ??
      "high",
  } as const;
  const e2eSuite = profile.tests?.e2eSuite ?? "smoke";
  const maxParallelTasks = resolveMaxParallelTasks();
  const isAcceptedRuntimeStatus = (status: number): boolean =>
    (status >= 200 && status < 400) || status === 401 || status === 403;
  const stageDurationsMs: Record<string, number> = {};
  const runStage = async (
    stageId: string,
    signal: AbortSignal,
    task: () => Promise<void>,
  ): Promise<void> => {
    throwIfAborted(signal);
    const startedAtMs = Date.now();
    await task();
    throwIfAborted(signal);
    stageDurationsMs[stageId] = Date.now() - startedAtMs;
  };
  const waitForRuntimeReady = async (timeoutMs: number, signal: AbortSignal): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const remainingMs = deadline - Date.now();
      const requestTimeoutMs = Math.max(100, Math.min(2_000, remainingMs));
      const requestController = new AbortController();
      const timeout = setTimeout(() => requestController.abort(), requestTimeoutMs);
      const abortParent = () => requestController.abort();
      signal.addEventListener("abort", abortParent, { once: true });
      try {
        const response = await fetch(healthcheckUrl ?? "", {
          method: "GET",
          signal: requestController.signal,
        });
        if (isAcceptedRuntimeStatus(response.status)) {
          return true;
        }
      } catch {
        // keep polling until timeout
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortParent);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  };
  const ensureRuntimeReady = async (stepId: string, signal: AbortSignal): Promise<void> => {
    throwIfAborted(signal);
    if (!isWebTarget) {
      return;
    }
    if (await waitForRuntimeReady(8_000, signal)) {
      return;
    }
    if (
      !startConfig.enabled ||
      (!startConfig.startCommands?.web && !startConfig.startCommands?.api)
    ) {
      throw new Error(`[${stepId}] runtime_unreachable url=${healthcheckUrl}`);
    }
    await runtimeStart.teardown();
    runtimeStart = await startTargetRuntime(startConfig);
    generatedReports.runtime = runtimeStart.reportPath;
    if (!runtimeStart.healthcheckPassed) {
      throw new Error(`[${stepId}] runtime_restart_failed url=${healthcheckUrl}`);
    }
  };
  let runtimeReadyLock = Promise.resolve();
  const ensureRuntimeReadySerialized = async (
    stepId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const ensured = runtimeReadyLock.then(async () => ensureRuntimeReady(stepId, signal));
    runtimeReadyLock = ensured.then(
      () => undefined,
      () => undefined,
    );
    await ensured;
  };

  try {
    const bootTasks: ConcurrentTask[] = [];
    if (profile.steps.includes("capture") && isWebTarget) {
      bootTasks.push(async (signal) => {
        await runStage("capture", signal, async () => {
          throwIfAborted(signal);
          await ensureRuntimeReady("capture", signal);
          const capture = await runCapture(baseDir, requireEffectiveBaseUrl(), {
            states: [...stateModel.configuredRoutes, ...stateModel.configuredStories],
          });
          states = capture.states;
          captureSummary = capture.summary;
          captureDiagnostics = capture.diagnostics;
        });
      });
    } else if (profile.steps.includes("capture")) {
      recordBlockedStep("capture", `unsupported for target.type=${target.type}`);
    }
    const testSuiteTasks: ConcurrentTask[] = [];
    if (profile.steps.includes("unit")) {
      testSuiteTasks.push(async (signal) => {
        await runStage("test.unit", signal, async () => {
          throwIfAborted(signal);
          unitTestResult = await runTestSuiteAsync(baseDir, "unit", effectiveBaseUrl);
          generatedReports.testUnit = unitTestResult.reportPath;
        });
      });
    }
    if (profile.steps.includes("contract")) {
      testSuiteTasks.push(async (signal) => {
        await runStage("test.contract", signal, async () => {
          throwIfAborted(signal);
          contractTestResult = await runTestSuiteAsync(baseDir, "contract", effectiveBaseUrl);
          generatedReports.testContract = contractTestResult.reportPath;
        });
      });
    }
    if (profile.steps.includes("ct")) {
      testSuiteTasks.push(async (signal) => {
        await runStage("test.ct", signal, async () => {
          throwIfAborted(signal);
          ctTestResult = await runTestSuiteAsync(baseDir, "ct", effectiveBaseUrl, e2eSuite);
          generatedReports.testCt = ctTestResult.reportPath;
        });
      });
    }
    if (profile.steps.includes("e2e")) {
      testSuiteTasks.push(async (signal) => {
        await runStage("test.e2e", signal, async () => {
          throwIfAborted(signal);
          e2eTestResult = await runTestSuiteAsync(baseDir, "e2e", effectiveBaseUrl, e2eSuite);
          generatedReports.testE2e = e2eTestResult.reportPath;
        });
      });
    }
    await runWithConcurrencyLimit([...bootTasks, ...testSuiteTasks], maxParallelTasks);
    const scenarioTasks: ConcurrentTask[] = [];
    if (profile.steps.includes("explore") && isWebTarget) {
      scenarioTasks.push(async (signal) => {
        await runStage("scenario.explore", signal, async () => {
          throwIfAborted(signal);
          await ensureRuntimeReadySerialized("explore", signal);
          effectiveExploreConfig = resolveExploreConfig(target, profile, overrides);
          const explore = await runExplore(baseDir, effectiveExploreConfig);
          exploreResultData = explore;
          generatedReports.explore = explore.reportPath;
          states = [...states, ...explore.states];
          pageErrorFromExplore = explore.crashCount;
          consoleErrorFromExplore = explore.consoleErrorCount;
          http5xxFromExplore = explore.http5xxCount;
          exploreDiagnostics = {
            consoleErrors: explore.consoleErrors,
            pageErrors: explore.pageErrors,
            http5xxUrls: explore.http5xxUrls,
          };
        });
      });
    } else if (profile.steps.includes("explore")) {
      recordBlockedStep("explore", `unsupported for target.type=${target.type}`);
    }
    if (profile.steps.includes("chaos") && isWebTarget) {
      scenarioTasks.push(async (signal) => {
        await runStage("scenario.chaos", signal, async () => {
          throwIfAborted(signal);
          await ensureRuntimeReadySerialized("chaos", signal);
          const resolvedChaosConfig = resolveChaosConfig(target, profile, overrides);
          effectiveChaosConfig = optimizeNightlyChaosConfig(
            resolvedChaosConfig,
            profile,
            effectiveExploreConfig,
            overrides,
          );
          const chaos = await runChaos(baseDir, effectiveChaosConfig);
          pageErrorFromChaos = chaos.pageErrorCount;
          consoleErrorFromChaos = chaos.consoleErrorCount;
          http5xxFromChaos = chaos.http5xxCount;
          chaosDiagnostics = {
            consoleErrors: chaos.consoleErrors,
            pageErrors: chaos.pageErrors,
            http5xxUrls: chaos.http5xxUrls,
          };
          generatedReports.chaos = chaos.reportPath;
        });
      });
    } else if (profile.steps.includes("chaos")) {
      recordBlockedStep("chaos", `unsupported for target.type=${target.type}`);
    }
    const wantsA11y = profile.steps.includes("a11y");
    const wantsPerf = profile.steps.includes("perf");
    const wantsVisual = profile.steps.includes("visual");
    if ((wantsA11y || wantsPerf || wantsVisual) && isWebTarget) {
      const qualityTasks: ConcurrentTask[] = [];
      if (wantsA11y) {
        qualityTasks.push(async (signal) => {
          await runStage("quality.a11y", signal, async () => {
            throwIfAborted(signal);
            await ensureRuntimeReadySerialized("a11y", signal);
            effectiveA11yConfig = resolveA11yConfig(target, profile, overrides);
            const a11y = await runA11y(baseDir, effectiveA11yConfig);
            a11yResultData = a11y;
            a11ySummary = {
              serious: a11y.counts.serious + a11y.counts.critical,
              total: a11y.counts.total,
            };
            a11yReportPath = a11y.reportPath;
          });
        });
      }
      if (wantsPerf) {
        qualityTasks.push(async (signal) => {
          await runStage("quality.perf", signal, async () => {
            throwIfAborted(signal);
            await ensureRuntimeReadySerialized("perf", signal);
            effectivePerfConfig = resolvePerfConfig(target, profile, overrides);
            const perf = await runPerf(baseDir, effectivePerfConfig);
            perfResultData = perf;
            perfSummary = {
              lcpMs: perf.metrics.largestContentfulPaintMs,
              fcpMs: perf.metrics.firstContentfulPaintMs,
            };
            perfReportPath = perf.reportPath;
          });
        });
      }
      if (wantsVisual) {
        qualityTasks.push(async (signal) => {
          await runStage("quality.visual", signal, async () => {
            throwIfAborted(signal);
            await ensureRuntimeReadySerialized("visual", signal);
            effectiveVisualConfig = resolveVisualConfig(target, profile, overrides);
            const visual = await runVisual(baseDir, effectiveVisualConfig);
            visualResultData = visual;
            visualSummary = {
              diffPixels: visual.diffPixels,
              baselineCreated: visual.baselineCreated,
            };
            visualReportPath = visual.reportPath;
          });
        });
      }
      await runWithConcurrencyLimit(qualityTasks, maxParallelTasks);
    } else {
      if (wantsA11y) {
        recordBlockedStep("a11y", `unsupported for target.type=${target.type}`);
      }
      if (wantsPerf) {
        recordBlockedStep("perf", `unsupported for target.type=${target.type}`);
      }
      if (wantsVisual) {
        recordBlockedStep("visual", `unsupported for target.type=${target.type}`);
      }
    }
    if (profile.steps.includes("load") && isWebTarget) {
      scenarioTasks.push(async (signal) => {
        await runStage("scenario.load", signal, async () => {
          throwIfAborted(signal);
          await ensureRuntimeReadySerialized("load", signal);
          effectiveLoadConfig = resolveLoadConfig(target, profile, overrides);
          const load = await runLoad(baseDir, effectiveLoadConfig);
          loadSummary = {
            totalRequests: load.totalRequests,
            failedRequests: load.failedRequests,
            http5xx: load.http5xx,
            requestsPerSecond: load.requestsPerSecond,
            latencyP95Ms: load.latencyMs.p95,
            engines: load.engines,
          };
          loadReportPath = load.reportPath;
        });
      });
    } else if (profile.steps.includes("load")) {
      recordBlockedStep("load", `unsupported for target.type=${target.type}`);
    }
    if (profile.steps.includes("security")) {
      scenarioTasks.push(async (signal) => {
        await runStage("scenario.security", signal, async () => {
          throwIfAborted(signal);
          effectiveSecurityConfig = resolveSecurityConfig(target, profile);
          const security = runSecurity(baseDir, effectiveSecurityConfig);
          securityResult = security;
          securityBlocked = security.executionStatus === "blocked";
          securityBlockedReason = security.blockedReason;
          securityFailed = security.executionStatus === "failed";
          securityFailedReason = security.errorMessage;
          highVulnCount = security.highVulnCount;
          mediumVulnCount = security.mediumVulnCount;
          lowVulnCount = security.lowVulnCount;
          securityReportPath = security.reportPath;
          securityTicketsPath = security.ticketsPath;
        });
      });
    }
    await runWithConcurrencyLimit(scenarioTasks, maxParallelTasks);
    if (profile.steps.includes("desktop_readiness")) {
      await runStage("desktop.readiness", new AbortController().signal, async () => {
        desktopReadinessResult = runDesktopReadiness(baseDir, {
          targetType: target.type,
          app: effectiveApp,
          bundleId: effectiveBundleId,
        });
        desktopReadinessPath = desktopReadinessResult.reportPath;
      });
    }
    if (profile.steps.includes("desktop_smoke")) {
      await runStage("desktop.smoke", new AbortController().signal, async () => {
        desktopSmokeResult = await runDesktopSmoke(baseDir, {
          targetType: target.type,
          app: effectiveApp,
          bundleId: effectiveBundleId,
        });
        desktopSmokePath = desktopSmokeResult.reportPath;
      });
    }
    if (profile.steps.includes("desktop_e2e")) {
      await runStage("desktop.e2e", new AbortController().signal, async () => {
        desktopE2EResult = await runDesktopE2E(baseDir, {
          targetType: target.type,
          app: effectiveApp,
          bundleId: effectiveBundleId,
          businessInteractionRequired: true,
        });
        desktopE2EPath = desktopE2EResult.reportPath;
      });
    }
    if (profile.steps.includes("desktop_soak")) {
      await runStage("desktop.soak", new AbortController().signal, async () => {
        desktopSoakResult = await runDesktopSoak(
          baseDir,
          resolveDesktopSoakConfig(target, profile, overrides),
        );
        desktopSoakPath = desktopSoakResult.reportPath;
      });
    }

    return finalizeProfileRunArtifacts({
      baseDir,
      resolvedRunId,
      startedAt,
      profile,
      target,
      effectiveBaseUrl,
      effectiveApp,
      effectiveBundleId,
      stateModel,
      states,
      captureSummary,
      consoleErrorFromExplore,
      consoleErrorFromChaos,
      pageErrorFromChaos,
      pageErrorFromExplore,
      http5xxFromExplore,
      http5xxFromChaos,
      highVulnCount,
      mediumVulnCount,
      lowVulnCount,
      securityResult,
      securityBlocked,
      securityBlockedReason,
      securityFailed,
      securityFailedReason,
      securityReportPath,
      securityTicketsPath,
      loadSummary,
      a11ySummary,
      a11yResultData,
      perfSummary,
      perfResultData,
      visualSummary,
      visualResultData,
      loadReportPath,
      a11yReportPath,
      perfReportPath,
      visualReportPath,
      unitTestResult,
      contractTestResult,
      ctTestResult,
      e2eTestResult,
      generatedReports,
      maxParallelTasks,
      stageDurationsMs,
      runtimeStart,
      blockedStepReasons,
      blockedStepDetails,
      exploreResultData,
      captureDiagnostics,
      exploreDiagnostics,
      chaosDiagnostics,
      effectiveDiagnosticsConfig,
      effectiveGeminiStrategy,
      desktopReadinessPath,
      desktopReadinessResult,
      desktopSmokePath,
      desktopSmokeResult,
      desktopE2EPath,
      desktopE2EResult,
      desktopSoakPath,
      desktopSoakResult,
      effectiveExploreConfig,
      effectiveChaosConfig,
      effectiveLoadConfig,
      effectiveA11yConfig,
      effectivePerfConfig,
      effectiveVisualConfig,
      effectiveSecurityConfig,
      baseUrlPolicy,
    });
  } finally {
    await runtimeStart.teardown();
    restoreEnv(geminiEnvSnapshot);
  }
}
