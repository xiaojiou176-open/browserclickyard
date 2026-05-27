import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeManifest } from "../../../../core/src/manifest/io.js";
import type { Manifest, ManifestProof } from "../../../../core/src/manifest/types.js";
import { ORCHESTRATOR_ENV } from "../env.js";
import { buildGateChecks, type GateThresholds, writeSummaryReportWithContext } from "../report.js";
import { buildStateModelSummary, TOOLCHAIN_VERSION } from "./config.js";
import {
  buildA11yEngineReadyCheck,
  buildExploreUnderExploredCheck,
  buildPerfEngineReadyCheck,
  buildVisualBaselineReadyCheck,
  gateReasonCode,
} from "./gate-checks.js";
import { buildProofArtifacts } from "./proof.js";
import {
  collectFailureLocations,
  normalizeDiagnosticsSection,
  normalizeList,
  writeDiagnosticsIndex,
} from "./reporting.js";
import { buildEvidenceIndex, normalizeCheckReasonCode, writeEvidenceIndex } from "./run-reporting.js";

function getGitInfo(): { branch: string; commit: string; dirty: boolean } {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim().length > 0;
    return { branch, commit, dirty };
  } catch {
    return { branch: "no-git", commit: "no-git", dirty: false };
  }
}

export function finalizeProfileRunArtifacts(input: any): { runId: string; manifestPath: string } {
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
  } = input;

  const summary = {
    consoleError: captureSummary.consoleError + consoleErrorFromExplore + consoleErrorFromChaos,
    pageError: captureSummary.pageError + pageErrorFromChaos + pageErrorFromExplore,
    http5xx: captureSummary.http5xx + http5xxFromExplore + http5xxFromChaos,
    highVuln: securityReportPath !== undefined ? highVulnCount : undefined,
    a11ySerious: a11ySummary?.serious,
    perfLcpMs: perfSummary?.lcpMs,
    perfFcpMs: perfSummary?.fcpMs,
    visualDiffPixels: visualSummary?.diffPixels,
    loadFailedRequests: loadSummary?.failedRequests,
    loadP95Ms: loadSummary?.latencyP95Ms,
    loadP99Ms: loadSummary?.latencyP99Ms,
    loadRps: loadSummary?.requestsPerSecond,
    uxScore: typeof input.geminiUxScore === "number" ? input.geminiUxScore : undefined,
    uxCriticalIssues:
      typeof input.geminiUxCriticalIssues === "number" ? input.geminiUxCriticalIssues : undefined,
    interactiveControlsCoverage:
      typeof input.interactiveControlsCoverage === "number"
        ? input.interactiveControlsCoverage
        : undefined,
    autofixRegressionPassed:
      typeof input.autofixRegressionPassed === "boolean"
        ? input.autofixRegressionPassed
          ? 1
          : 0
        : undefined,
  };
  const effectiveGates: GateThresholds = {
    ...(profile.gates ?? {}),
    ...(target.gates ?? {}),
  } as GateThresholds;
  const thresholds: GateThresholds = {
    consoleErrorMax: effectiveGates.consoleErrorMax ?? 0,
    pageErrorMax: effectiveGates.pageErrorMax ?? 0,
    http5xxMax: effectiveGates.http5xxMax ?? 0,
    contractStatus: contractTestResult ? (effectiveGates.contractStatus ?? "passed") : undefined,
    securityHighVulnMax: effectiveGates.securityHighVulnMax,
    a11ySeriousMax: a11ySummary ? effectiveGates.a11ySeriousMax : undefined,
    perfLcpMsMax: perfSummary ? effectiveGates.perfLcpMsMax : undefined,
    perfFcpMsMax: perfSummary ? effectiveGates.perfFcpMsMax : undefined,
    visualDiffPixelsMax: visualSummary ? effectiveGates.visualDiffPixelsMax : undefined,
    loadFailedRequestsMax: loadSummary ? effectiveGates.loadFailedRequestsMax : undefined,
    loadP95MsMax: loadSummary ? effectiveGates.loadP95MsMax : undefined,
    loadP99MsMax: loadSummary ? effectiveGates.loadP99MsMax : undefined,
    loadErrorBudgetMax: loadSummary ? effectiveGates.loadErrorBudgetMax : undefined,
    loadStageFailureMax: loadSummary ? effectiveGates.loadStageFailureMax : undefined,
    loadEngineReadyRequired: loadSummary ? effectiveGates.loadEngineReadyRequired : undefined,
    loadRpsMin: loadSummary ? effectiveGates.loadRpsMin : undefined,
    uxScoreMin: effectiveGates.uxScoreMin,
    uxCriticalIssuesMax: effectiveGates.uxCriticalIssuesMax,
    autofixRegressionPassedRequired: effectiveGates.autofixRegressionPassedRequired,
    coverageInteractiveControlsMin: effectiveGates.coverageInteractiveControlsMin,
  };
  const primaryCapturedStateId = states[0]?.id ?? "home_default";
  const checks = buildGateChecks(
    summary,
    thresholds,
    {
      consoleError:
        consoleErrorFromExplore > 0 ? "logs/explore.log" : `logs/${primaryCapturedStateId}.log`,
      // page.error actual is aggregate(capture + explore + chaos), so evidence must point to aggregate report.
      pageError: "reports/summary.json",
      http5xx:
        http5xxFromChaos > 0
          ? "network/chaos.har"
          : http5xxFromExplore > 0
            ? "network/explore.har"
            : "network/capture.har",
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
  );
  if (runtimeStart.started) {
    checks.push({
      id: "runtime.healthcheck",
      expected: "passed",
      actual: runtimeStart.healthcheckPassed ? "passed" : "failed",
      severity: "BLOCKER",
      status: runtimeStart.healthcheckPassed ? "passed" : "blocked",
      reasonCode: runtimeStart.healthcheckPassed
        ? undefined
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
          ? undefined
          : gateReasonCode("test.unit", "failed", "suite_failed"),
      evidencePath: unitTestResult.reportPath,
    });
  }
  if (contractTestResult) {
    const expectedStatus = effectiveGates.contractStatus ?? "passed";
    checks.push({
      id: "test.contract",
      expected: expectedStatus,
      actual: contractTestResult.status,
      severity: "BLOCKER",
      status: contractTestResult.status === expectedStatus ? "passed" : "failed",
      reasonCode:
        contractTestResult.status === expectedStatus
          ? undefined
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
          ? undefined
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
          ? undefined
          : gateReasonCode("test.e2e", "failed", "suite_failed"),
      evidencePath: e2eTestResult.reportPath,
    });
  }
  const exploreUnderExploredCheck = buildExploreUnderExploredCheck(
    exploreResultData,
    summary.pageError,
    {
      required: effectiveGates.exploreUnderExploredRequired,
      minDiscoveredStates: effectiveGates.exploreMinDiscoveredStates,
    },
  );
  if (exploreUnderExploredCheck) {
    checks.push(exploreUnderExploredCheck);
  }
  const a11yEngineReadyCheck = buildA11yEngineReadyCheck(
    a11yResultData,
    effectiveA11yConfig?.engine,
  );
  if (a11yEngineReadyCheck) {
    checks.push(a11yEngineReadyCheck);
  }
  const perfEngineReadyCheck = buildPerfEngineReadyCheck(perfResultData, {
    required: effectiveGates.perfEngineReadyRequired,
  });
  if (perfEngineReadyCheck) {
    checks.push(perfEngineReadyCheck);
  }
  const visualBaselineReadyCheck = buildVisualBaselineReadyCheck(
    visualResultData,
    effectiveVisualConfig?.mode,
    {
      required: effectiveGates.visualBaselineReadyRequired,
    },
  );
  if (visualBaselineReadyCheck) {
    checks.push(visualBaselineReadyCheck);
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
          ? undefined
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
          ? undefined
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
          ? undefined
          : gateReasonCode("desktop.e2e", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopE2EResult.reportPath,
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
          ? undefined
          : gateReasonCode("desktop.soak", "blocked", "requirement_unsatisfied"),
      evidencePath: desktopSoakResult.reportPath,
    });
  }
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
  const executionCriticalPath = Object.entries(stageDurationsMs as Record<string, number>)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([stageId]) => stageId);
  const normalizedChecks = checks.map(normalizeCheckReasonCode);
  const failureLocations = collectFailureLocations(normalizedChecks);
  const securityExecutionStatus: "ok" | "failed" | "blocked" = securityBlocked
    ? "blocked"
    : securityFailed
      ? "failed"
      : "ok";
  const diagnostics = {
    capture: normalizedCaptureDiagnostics,
    explore: normalizedExploreDiagnostics,
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
            fallbackUsed: perfResultData.fallbackUsed ?? false,
            metricsCompleteness: perfResultData.metricsCompleteness,
          }
        : undefined,
    visual:
      visualResultData !== undefined
        ? {
            engine: visualResultData.engine,
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
    security:
      securityReportPath !== undefined
        ? {
            executionStatus: securityExecutionStatus,
            blockedReason: securityBlockedReason,
            errorMessage: securityFailedReason,
            totalIssueCount: securityResult?.totalIssueCount,
            dedupedIssueCount: securityResult?.dedupedIssueCount,
            ticketCount: securityResult?.tickets.length,
            topTickets: securityResult?.tickets.slice(0, 10).map((ticket: any) => ({
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
    desktopSoak: desktopSoakResult,
    http5xxUrls: aggregateHttp5xx.items,
    truncation: {
      http5xxUrls: aggregateHttp5xx.truncation,
    },
    execution: {
      maxParallelTasks,
      stagesMs: stageDurationsMs,
      criticalPath: executionCriticalPath,
    },
    blockedSteps: blockedStepReasons,
    blockedStepDetails,
    failureLocations,
  };
  const hasBlocked = normalizedChecks.some((check) => check.status === "blocked");
  const hasFailed = normalizedChecks.some((check) => check.status === "failed");
  const status: "passed" | "failed" | "blocked" = hasBlocked
    ? "blocked"
    : hasFailed
      ? "failed"
      : "passed";
  const reportPath = writeSummaryReportWithContext(baseDir, {
    status,
    checks: normalizedChecks,
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
      gemini: effectiveGeminiStrategy,
      baseUrlPolicy,
      runtimeStart,
    },
    qualitySignals: {
      a11yTrust: a11yResultData?.fallbackUsed ? "fallback_untrusted" : "trusted",
      perfTrust: perfResultData?.fallbackUsed ? "release_untrusted" : "release_trusted",
      visualTrust:
        visualResultData &&
        (effectiveVisualConfig?.mode ?? visualResultData.mode) === "diff" &&
        visualResultData.baselineCreated
          ? "no_historical_baseline"
          : "historical_baseline_available",
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

  const finishedAt = new Date().toISOString();
  const timing = {
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
  };
  const stateModelSummary = buildStateModelSummary(target.type, profile.steps, stateModel, states, {
    desktopReadinessResult,
    desktopSmokeResult,
    desktopE2EResult,
    desktopSoakResult,
  });
  const runEnvironment = {
    autostart: runtimeStart.autostart,
    started: runtimeStart.started,
    healthcheckPassed: runtimeStart.healthcheckPassed,
    healthcheckUrl: runtimeStart.healthcheckUrl ?? "",
    host: process.platform,
    node: process.version,
    ci: Boolean(ORCHESTRATOR_ENV.CI),
  };
  const toolVersions = {
    node: process.version,
    a11y: effectiveA11yConfig?.engine ?? "axe",
    perf: effectivePerfConfig?.engine ?? "lhci",
    load: effectiveLoadConfig?.engines ?? ["builtin", "artillery", "k6"],
    security: effectiveSecurityConfig?.engine ?? "builtin",
  };
  const proofReports = {
    coveragePath: "reports/proof.coverage.json",
    stabilityPath: "reports/proof.stability.json",
    gapsPath: "reports/proof.gaps.json",
    reproPath: "reports/proof.repro.json",
  } satisfies Omit<ManifestProof, "summary">;
  const proofArtifacts = buildProofArtifacts({
    runId: resolvedRunId,
    profile: profile.name,
    target: { type: target.type, name: target.name },
    timing,
    stateModel: stateModelSummary,
    states,
    summary,
    gateResults: { status, checks },
    blockedSteps: blockedStepReasons,
    failureLocations,
    criticalPath: executionCriticalPath,
    reportPath,
    diagnosticsIndexPath,
    runEnvironment,
    toolVersions,
  });
  writeFileSync(
    resolve(baseDir, proofReports.coveragePath),
    JSON.stringify(proofArtifacts.coverage, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(baseDir, proofReports.stabilityPath),
    JSON.stringify(proofArtifacts.stability, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(baseDir, proofReports.gapsPath),
    JSON.stringify(proofArtifacts.gaps, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(baseDir, proofReports.reproPath),
    JSON.stringify(proofArtifacts.repro, null, 2),
    "utf8",
  );
  const proofSummary: ManifestProof["summary"] = {
    configuredCoverageRatio: proofArtifacts.summary.configuredCoverageRatio,
    gatePassRatio: proofArtifacts.summary.gatePassRatio,
    stabilityStatus: proofArtifacts.summary.stabilityStatus,
  };
  const proof: ManifestProof = {
    ...proofReports,
    summary: proofSummary,
  };
  const manifestReports = {
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
    ...(desktopSoakPath ? { desktopSoak: desktopSoakPath } : {}),
    ...(loadReportPath ? { load: loadReportPath } : {}),
    proofCoverage: proof.coveragePath,
    proofStability: proof.stabilityPath,
    proofGaps: proof.gapsPath,
    proofRepro: proof.reproPath,
    diagnosticsIndex: diagnosticsIndexPath,
  };
  const evidenceIndex = buildEvidenceIndex(states, manifestReports, normalizedChecks);
  const evidenceIndexPath = writeEvidenceIndex(baseDir, {
    runId: resolvedRunId,
    profile: profile.name,
    target: { type: target.type, name: target.name },
    items: evidenceIndex,
  });
  manifestReports.evidenceIndex = evidenceIndexPath;

  const manifest: Manifest = {
    runId: resolvedRunId,
    target: {
      type: target.type,
      name: target.name,
      baseUrl: effectiveBaseUrl ?? "",
      app: effectiveApp ?? "",
      bundleId: effectiveBundleId ?? "",
    },
    profile: profile.name,
    git: getGitInfo(),
    timing,
    states,
    evidenceIndex,
    reports: manifestReports,
    stateModel: stateModelSummary,
    summary,
    diagnostics,
    runEnvironment,
    toolVersions,
    proof,
    gateResults: {
      status,
      checks: normalizedChecks,
    },
    toolchain: {
      toolchainVersion: TOOLCHAIN_VERSION,
      node: process.version,
      driver: target.driver,
      playwright: "installed",
      config: {
        explore: effectiveExploreConfig,
        chaos: effectiveChaosConfig,
        load: effectiveLoadConfig,
        security: effectiveSecurityConfig,
        diagnostics: effectiveDiagnosticsConfig,
        gemini: effectiveGeminiStrategy,
        baseUrlPolicy,
      },
    },
  };

  const manifestPath = writeManifest(baseDir, manifest);
  return { runId: resolvedRunId, manifestPath };
}
