import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ManifestGateCheck } from "../../../core/src/manifest/types.js";

export type GateThresholds = {
  consoleErrorMax: number;
  pageErrorMax: number;
  http5xxMax: number;
  flakeRateMax?: number;
  contractStatus?: "passed";
  dangerousActionHitsMax?: number;
  securityHighVulnMax?: number;
  a11ySeriousMax?: number;
  perfLcpMsMax?: number;
  perfFcpMsMax?: number;
  visualDiffPixelsMax?: number;
  loadFailedRequestsMax?: number;
  loadP95MsMax?: number;
  loadP99MsMax?: number;
  loadRpsMin?: number;
  loadErrorBudgetMax?: number;
  loadStageFailureMax?: number;
  loadEngineReadyRequired?: boolean;
  perfEngineReadyRequired?: boolean;
  visualBaselineReadyRequired?: boolean;
  exploreUnderExploredRequired?: boolean;
  exploreMinDiscoveredStates?: number;
  uxScoreMin?: number;
  uxCriticalIssuesMax?: number;
  autofixRegressionPassedRequired?: boolean;
  coverageInteractiveControlsMin?: number;
};

export type GateEvidencePaths = {
  consoleError: string;
  pageError: string;
  http5xx: string;
  highVuln: string;
  a11y: string;
  perf: string;
  visual: string;
  load: string;
};

function thresholdReasonCode(id: string, passed: boolean): string {
  return passed
    ? `gate.${id.replaceAll(".", "_")}.passed.threshold_met`
    : `gate.${id.replaceAll(".", "_")}.failed.threshold_exceeded`;
}

function blockedReasonCode(id: string, reason: string): string {
  return `gate.${id.replaceAll(".", "_")}.blocked.${reason}`;
}

function failedReasonCode(id: string, reason: string): string {
  return `gate.${id.replaceAll(".", "_")}.failed.${reason}`;
}

type SummaryMetrics = {
  consoleError: number;
  pageError: number;
  http5xx: number;
  dangerousActionHits?: number;
  highVuln?: number;
  a11ySerious?: number;
  perfLcpMs?: number;
  perfFcpMs?: number;
  visualDiffPixels?: number;
  loadFailedRequests?: number;
  loadP95Ms?: number;
  loadP99Ms?: number;
  loadRps?: number;
  uxScore?: number;
  uxCriticalIssues?: number;
  interactiveControlsCoverage?: number;
  autofixRegressionPassed?: number;
};

type LoadAttributionSummary = {
  topFailingEndpoints?: Array<{
    endpoint?: string;
    failedRequests?: number;
    timeoutErrors?: number;
    networkErrors?: number;
  }>;
  statusDistribution?: Array<{
    status?: string;
    count?: number;
  }>;
  timeoutErrors?: number;
  networkErrors?: number;
  otherErrors?: number;
  resourcePressure?: {
    stageGateFailures?: number;
    lowRpsStages?: number;
    highLatencyStages?: number;
    maxObservedP99Ms?: number;
    minObservedRps?: number;
  };
};

function normalizeReasonSuffix(reason: string | undefined, fallback: string): string {
  if (!reason) {
    return fallback;
  }
  const normalized = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function extractPreviousSummary(raw: unknown): SummaryMetrics | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const container = raw as { summary?: unknown };
  if (!container.summary || typeof container.summary !== "object") {
    return undefined;
  }
  const summary = container.summary as { current?: SummaryMetrics; compare?: unknown };
  if (summary.current && typeof summary.current === "object") {
    return summary.current;
  }
  const { compare: _ignored, ...metricsOnly } = summary as SummaryMetrics & { compare?: unknown };
  return metricsOnly;
}

function computeSummaryDelta(
  prev: SummaryMetrics | undefined,
  current: SummaryMetrics,
): Record<string, number | null> {
  const delta: Record<string, number | null> = {};
  const keys = new Set<string>([...Object.keys(prev ?? {}), ...Object.keys(current)]);
  for (const key of keys) {
    const prevValue = prev?.[key as keyof SummaryMetrics];
    const currValue = current[key as keyof SummaryMetrics];
    if (typeof prevValue === "number" && typeof currValue === "number") {
      delta[key] = Number((currValue - prevValue).toFixed(2));
    } else {
      delta[key] = null;
    }
  }
  return delta;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function toLoadAttribution(raw: unknown): LoadAttributionSummary | undefined {
  const candidate = asRecord(raw);
  if (!candidate) {
    return undefined;
  }

  const topFailingEndpoints = Array.isArray(candidate.topFailingEndpoints)
    ? candidate.topFailingEndpoints
        .map((item) => {
          const entry = asRecord(item);
          if (!entry) {
            return undefined;
          }
          return {
            endpoint: typeof entry.endpoint === "string" ? entry.endpoint : undefined,
            failedRequests: asNumber(entry.failedRequests),
            timeoutErrors: asNumber(entry.timeoutErrors),
            networkErrors: asNumber(entry.networkErrors),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
    : undefined;

  const statusDistribution = Array.isArray(candidate.statusDistribution)
    ? candidate.statusDistribution
        .map((item) => {
          const entry = asRecord(item);
          if (!entry) {
            return undefined;
          }
          return {
            status: typeof entry.status === "string" ? entry.status : undefined,
            count: asNumber(entry.count),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
    : undefined;

  const resourcePressureRaw = asRecord(candidate.resourcePressure);
  const resourcePressure = resourcePressureRaw
    ? {
        stageGateFailures: asNumber(resourcePressureRaw.stageGateFailures),
        lowRpsStages: asNumber(resourcePressureRaw.lowRpsStages),
        highLatencyStages: asNumber(resourcePressureRaw.highLatencyStages),
        maxObservedP99Ms: asNumber(resourcePressureRaw.maxObservedP99Ms),
        minObservedRps: asNumber(resourcePressureRaw.minObservedRps),
      }
    : undefined;

  const normalized: LoadAttributionSummary = {
    topFailingEndpoints: topFailingEndpoints?.slice(0, 3),
    statusDistribution: statusDistribution?.slice(0, 5),
    timeoutErrors: asNumber(candidate.timeoutErrors),
    networkErrors: asNumber(candidate.networkErrors),
    otherErrors: asNumber(candidate.otherErrors),
    resourcePressure,
  };

  const hasData =
    (normalized.topFailingEndpoints?.length ?? 0) > 0 ||
    (normalized.statusDistribution?.length ?? 0) > 0 ||
    normalized.timeoutErrors !== undefined ||
    normalized.networkErrors !== undefined ||
    normalized.otherErrors !== undefined ||
    normalized.resourcePressure !== undefined;

  return hasData ? normalized : undefined;
}

function extractLoadAttributionFromDiagnostics(raw: unknown): LoadAttributionSummary | undefined {
  const diagnostics = asRecord(raw);
  if (!diagnostics) {
    return undefined;
  }
  const direct = toLoadAttribution(diagnostics.loadAttribution);
  if (direct) {
    return direct;
  }

  const load = asRecord(diagnostics.load);
  if (load) {
    const fromLoad = toLoadAttribution(load.attribution);
    if (fromLoad) {
      return fromLoad;
    }
  }

  return undefined;
}

function buildInformationalFailures(
  summary: SummaryMetrics | undefined,
  diagnostics: unknown,
):
  | {
      load?: {
        failedRequests: number;
        timeoutErrors?: number;
        networkErrors?: number;
        otherErrors?: number;
        topFailingEndpoints?: Array<{
          endpoint?: string;
          failedRequests?: number;
          timeoutErrors?: number;
          networkErrors?: number;
        }>;
        statusDistribution?: Array<{
          status?: string;
          count?: number;
        }>;
        resourcePressure?: LoadAttributionSummary["resourcePressure"];
      };
    }
  | undefined {
  const attribution = extractLoadAttributionFromDiagnostics(diagnostics);
  const failedRequests = summary?.loadFailedRequests ?? 0;
  const hasLoadFailureSignals =
    failedRequests > 0 ||
    (attribution?.timeoutErrors ?? 0) > 0 ||
    (attribution?.networkErrors ?? 0) > 0 ||
    (attribution?.otherErrors ?? 0) > 0 ||
    (attribution?.statusDistribution?.length ?? 0) > 0;

  if (!hasLoadFailureSignals) {
    return undefined;
  }

  return {
    load: {
      failedRequests,
      timeoutErrors: attribution?.timeoutErrors,
      networkErrors: attribution?.networkErrors,
      otherErrors: attribution?.otherErrors,
      topFailingEndpoints: attribution?.topFailingEndpoints,
      statusDistribution: attribution?.statusDistribution,
      resourcePressure: attribution?.resourcePressure,
    },
  };
}

export function buildGateChecks(
  summary: {
    consoleError: number;
    pageError: number;
    http5xx: number;
    dangerousActionHits?: number;
    highVuln?: number;
    a11ySerious?: number;
    perfLcpMs?: number;
    perfFcpMs?: number;
    visualDiffPixels?: number;
    loadFailedRequests?: number;
    loadP95Ms?: number;
    loadP99Ms?: number;
    loadRps?: number;
    uxScore?: number;
    uxCriticalIssues?: number;
    interactiveControlsCoverage?: number;
    autofixRegressionPassed?: number;
  },
  thresholds: GateThresholds,
  evidencePaths?: Partial<GateEvidencePaths>,
  runtime?: {
    securityBlocked?: boolean;
    securityBlockedReason?: string;
    securityFailed?: boolean;
    securityFailedReason?: string;
  },
): ManifestGateCheck[] {
  const resolvedEvidence: GateEvidencePaths = {
    consoleError: evidencePaths?.consoleError ?? "logs/home_default.log",
    pageError: evidencePaths?.pageError ?? "logs/home_default.log",
    http5xx: evidencePaths?.http5xx ?? "network/home_default.har",
    highVuln: evidencePaths?.highVuln ?? "security/report.json",
    a11y: evidencePaths?.a11y ?? "a11y/axe.json",
    perf: evidencePaths?.perf ?? "perf/lighthouse.json",
    visual: evidencePaths?.visual ?? "visual/report.json",
    load: evidencePaths?.load ?? "metrics/load-summary.json",
  };

  const checks: ManifestGateCheck[] = [
    {
      id: "console.error",
      expected: thresholds.consoleErrorMax,
      actual: summary.consoleError,
      severity: "BLOCKER",
      status: summary.consoleError <= thresholds.consoleErrorMax ? "passed" : "failed",
      reasonCode: thresholdReasonCode(
        "console.error",
        summary.consoleError <= thresholds.consoleErrorMax,
      ),
      evidencePath: resolvedEvidence.consoleError,
    },
    {
      id: "page.error",
      expected: thresholds.pageErrorMax,
      actual: summary.pageError,
      severity: "BLOCKER",
      status: summary.pageError <= thresholds.pageErrorMax ? "passed" : "failed",
      reasonCode: thresholdReasonCode("page.error", summary.pageError <= thresholds.pageErrorMax),
      evidencePath: resolvedEvidence.pageError,
    },
    {
      id: "http.5xx",
      expected: thresholds.http5xxMax,
      actual: summary.http5xx,
      severity: "MAJOR",
      status: summary.http5xx <= thresholds.http5xxMax ? "passed" : "failed",
      reasonCode: thresholdReasonCode("http.5xx", summary.http5xx <= thresholds.http5xxMax),
      evidencePath: resolvedEvidence.http5xx,
    },
  ];

  if (
    thresholds.dangerousActionHitsMax !== undefined ||
    summary.dangerousActionHits !== undefined
  ) {
    const expected = thresholds.dangerousActionHitsMax ?? 0;
    const actual = summary.dangerousActionHits ?? 0;
    checks.push({
      id: "safety.dangerous_actions",
      expected,
      actual,
      severity: "BLOCKER",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("safety.dangerous_actions", actual <= expected),
      evidencePath: "reports/diagnostics.index.json",
    });
  }

  if (thresholds.securityHighVulnMax !== undefined || summary.highVuln !== undefined) {
    const expected = thresholds.securityHighVulnMax ?? 0;
    const actual = summary.highVuln ?? 0;
    checks.push({
      id: "security.high_vuln",
      expected,
      actual: runtime?.securityBlocked
        ? (runtime.securityBlockedReason ?? "blocked")
        : runtime?.securityFailed
          ? (runtime.securityFailedReason ?? "security scan failed")
          : actual,
      severity: "BLOCKER",
      status: runtime?.securityBlocked
        ? "blocked"
        : runtime?.securityFailed
          ? "failed"
          : actual <= expected
            ? "passed"
            : "failed",
      reasonCode: runtime?.securityBlocked
        ? blockedReasonCode(
            "security.high_vuln",
            normalizeReasonSuffix(runtime.securityBlockedReason, "security_scan_blocked"),
          )
        : runtime?.securityFailed
          ? failedReasonCode(
              "security.high_vuln",
              normalizeReasonSuffix(runtime.securityFailedReason, "security_scan_failed"),
            )
          : thresholdReasonCode("security.high_vuln", actual <= expected),
      evidencePath: resolvedEvidence.highVuln,
    });
  }

  if (thresholds.a11ySeriousMax !== undefined || summary.a11ySerious !== undefined) {
    const expected = thresholds.a11ySeriousMax ?? 0;
    const actual = summary.a11ySerious ?? 0;
    checks.push({
      id: "a11y.serious_max",
      expected,
      actual,
      severity: "BLOCKER",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("a11y.serious_max", actual <= expected),
      evidencePath: resolvedEvidence.a11y,
    });
  }

  if (thresholds.perfLcpMsMax !== undefined || summary.perfLcpMs !== undefined) {
    const expected = thresholds.perfLcpMsMax ?? 0;
    const actual = summary.perfLcpMs ?? 0;
    checks.push({
      id: "perf.lcp_ms_max",
      expected,
      actual,
      severity: "MAJOR",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("perf.lcp_ms_max", actual <= expected),
      evidencePath: resolvedEvidence.perf,
    });
  }

  if (thresholds.perfFcpMsMax !== undefined || summary.perfFcpMs !== undefined) {
    const expected = thresholds.perfFcpMsMax ?? 0;
    const actual = summary.perfFcpMs ?? 0;
    checks.push({
      id: "perf.fcp_ms_max",
      expected,
      actual,
      severity: "MAJOR",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("perf.fcp_ms_max", actual <= expected),
      evidencePath: resolvedEvidence.perf,
    });
  }

  if (thresholds.visualDiffPixelsMax !== undefined || summary.visualDiffPixels !== undefined) {
    const expected = thresholds.visualDiffPixelsMax ?? 0;
    const actual = summary.visualDiffPixels ?? 0;
    checks.push({
      id: "visual.diff_pixels_max",
      expected,
      actual,
      severity: "MAJOR",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("visual.diff_pixels_max", actual <= expected),
      evidencePath: resolvedEvidence.visual,
    });
  }

  if (thresholds.loadFailedRequestsMax !== undefined || summary.loadFailedRequests !== undefined) {
    const expected = thresholds.loadFailedRequestsMax ?? 0;
    const actual = summary.loadFailedRequests ?? 0;
    checks.push({
      id: "load.failed_requests",
      expected,
      actual,
      severity: "MAJOR",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.failed_requests", actual <= expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  const hasLoadSummary =
    summary.loadFailedRequests !== undefined ||
    summary.loadP95Ms !== undefined ||
    summary.loadP99Ms !== undefined ||
    summary.loadRps !== undefined;
  const loadEngineReadyRequired = thresholds.loadEngineReadyRequired ?? hasLoadSummary;
  const loadEngineReady = (summary.loadRps ?? 0) > 0;

  if (loadEngineReadyRequired) {
    checks.push({
      id: "load.engine_ready",
      expected: "one_of(k6,artillery)=ok",
      actual: loadEngineReady ? "one_of(k6,artillery)=ok" : "not_ready",
      severity: "BLOCKER",
      status: loadEngineReady ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.engine_ready", loadEngineReady),
      evidencePath: resolvedEvidence.load,
    });
  }

  if (
    thresholds.loadErrorBudgetMax !== undefined ||
    thresholds.loadFailedRequestsMax !== undefined ||
    summary.loadFailedRequests !== undefined
  ) {
    const expected = thresholds.loadErrorBudgetMax ?? thresholds.loadFailedRequestsMax ?? 0;
    const actual = summary.loadFailedRequests ?? 0;
    checks.push({
      id: "load.error_budget",
      expected,
      actual,
      severity: "BLOCKER",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.error_budget", actual <= expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  if (thresholds.loadStageFailureMax !== undefined || summary.loadFailedRequests !== undefined) {
    const expected = thresholds.loadStageFailureMax ?? 0;
    const actual = summary.loadFailedRequests ?? 0;
    checks.push({
      id: "load.stage_thresholds",
      expected,
      actual,
      severity: "BLOCKER",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.stage_thresholds", actual <= expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  const loadP99Expected = thresholds.loadP99MsMax ?? thresholds.loadP95MsMax;
  const loadP99Actual = summary.loadP99Ms ?? summary.loadP95Ms ?? 0;
  if (loadP99Expected !== undefined) {
    checks.push({
      id: "load.p99_ms",
      expected: loadP99Expected,
      actual: loadP99Actual,
      severity: "BLOCKER",
      status: loadP99Actual <= loadP99Expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.p99_ms", loadP99Actual <= loadP99Expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  if (thresholds.loadP95MsMax !== undefined) {
    const expected = thresholds.loadP95MsMax;
    const actual = summary.loadP95Ms ?? 0;
    checks.push({
      id: "load.p95_ms",
      expected,
      actual,
      severity: "MAJOR",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.p95_ms", actual <= expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  if (thresholds.loadRpsMin !== undefined) {
    const expected = thresholds.loadRpsMin;
    const actual = summary.loadRps ?? 0;
    checks.push({
      id: "load.rps_min",
      expected,
      actual,
      severity: "MAJOR",
      status: actual >= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("load.rps_min", actual >= expected),
      evidencePath: resolvedEvidence.load,
    });
  }

  if (thresholds.uxScoreMin !== undefined || summary.uxScore !== undefined) {
    const expected = thresholds.uxScoreMin ?? 80;
    const actual = summary.uxScore ?? 0;
    checks.push({
      id: "ux.score_min",
      expected,
      actual,
      severity: "MAJOR",
      status: actual >= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("ux.score_min", actual >= expected),
      evidencePath: "reports/ux-audit.json",
    });
  }

  if (thresholds.uxCriticalIssuesMax !== undefined || summary.uxCriticalIssues !== undefined) {
    const expected = thresholds.uxCriticalIssuesMax ?? 0;
    const actual = summary.uxCriticalIssues ?? 0;
    checks.push({
      id: "ux.critical_issues_max",
      expected,
      actual,
      severity: "BLOCKER",
      status: actual <= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("ux.critical_issues_max", actual <= expected),
      evidencePath: "reports/ux-audit.json",
    });
  }

  if (thresholds.autofixRegressionPassedRequired || summary.autofixRegressionPassed !== undefined) {
    const expected = "passed";
    const actual = (summary.autofixRegressionPassed ?? 0) > 0 ? "passed" : "failed";
    const passed = actual === expected;
    checks.push({
      id: "autofix.regression_passed",
      expected,
      actual,
      severity: "BLOCKER",
      status: passed ? "passed" : "failed",
      reasonCode: thresholdReasonCode("autofix.regression_passed", passed),
      evidencePath: "reports/autofix-regression.json",
    });
  }

  if (
    thresholds.coverageInteractiveControlsMin !== undefined ||
    summary.interactiveControlsCoverage !== undefined
  ) {
    const expected = thresholds.coverageInteractiveControlsMin ?? 0.85;
    const actual = summary.interactiveControlsCoverage ?? 0;
    checks.push({
      id: "coverage.interactive_controls_min",
      expected,
      actual,
      severity: "MAJOR",
      status: actual >= expected ? "passed" : "failed",
      reasonCode: thresholdReasonCode("coverage.interactive_controls_min", actual >= expected),
      evidencePath: "reports/ui-coverage-matrix.json",
    });
  }

  return checks;
}

export function writeSummaryReport(
  baseDir: string,
  status: "passed" | "failed",
  checks: ManifestGateCheck[],
): string {
  return writeSummaryReportWithContext(baseDir, {
    status,
    checks,
  });
}

export function writeSummaryReportWithContext(
  baseDir: string,
  payload: {
    status: "passed" | "failed" | "blocked";
    checks: ManifestGateCheck[];
    summary?: {
      consoleError: number;
      pageError: number;
      http5xx: number;
      dangerousActionHits?: number;
      highVuln?: number;
      a11ySerious?: number;
      perfLcpMs?: number;
      perfFcpMs?: number;
      visualDiffPixels?: number;
      loadFailedRequests?: number;
      loadP95Ms?: number;
      loadP99Ms?: number;
      loadRps?: number;
      uxScore?: number;
      uxCriticalIssues?: number;
      interactiveControlsCoverage?: number;
      autofixRegressionPassed?: number;
    };
    thresholds?: GateThresholds;
    diagnostics?: unknown;
    effectiveConfig?: {
      explore?: unknown;
      chaos?: unknown;
      a11y?: unknown;
      perf?: unknown;
      visual?: unknown;
      load?: unknown;
      security?: unknown;
      diagnostics?: unknown;
      gemini?: unknown;
      baseUrlPolicy?: unknown;
      runtimeStart?: unknown;
    };
    qualitySignals?: {
      a11yTrust?: "trusted" | "fallback_untrusted";
      perfTrust?: "release_trusted" | "release_untrusted";
      visualTrust?: "historical_baseline_available" | "no_historical_baseline";
    };
  },
): string {
  const outputPath = resolve(baseDir, "reports/summary.json");
  let previousSummary: SummaryMetrics | undefined;
  try {
    const previousRaw = JSON.parse(readFileSync(outputPath, "utf8")) as unknown;
    previousSummary = extractPreviousSummary(previousRaw);
  } catch {
    previousSummary = undefined;
  }

  const currentSummary = payload.summary;
  const summaryWithCompare =
    currentSummary !== undefined
      ? {
          ...currentSummary,
          compare: {
            prev: previousSummary ?? null,
            current: currentSummary,
            delta: computeSummaryDelta(previousSummary, currentSummary),
          },
        }
      : undefined;

  const failedChecks = payload.checks
    .filter((check) => check.status === "failed")
    .map((check) => ({
      id: check.id,
      acId: check.acId,
      reasonCode: check.reasonCode,
      evidencePath: check.evidencePath,
      actual: check.actual,
      expected: check.expected,
      severity: check.severity,
    }));
  const blockedChecks = payload.checks
    .filter((check) => check.status === "blocked")
    .map((check) => ({
      id: check.id,
      acId: check.acId,
      reasonCode: check.reasonCode,
      evidencePath: check.evidencePath,
      actual: check.actual,
      expected: check.expected,
      severity: check.severity,
    }));
  const checksTotal = {
    total: payload.checks.length,
    passed: payload.checks.filter((check) => check.status === "passed").length,
    failed: failedChecks.length,
    blocked: blockedChecks.length,
  };

  const outputPayload = {
    ...payload,
    gateStatus: payload.status,
    failedChecks,
    blockedChecks,
    checksTotal,
    informationalFailures: buildInformationalFailures(payload.summary, payload.diagnostics),
    summary: summaryWithCompare,
  };

  writeFileSync(outputPath, JSON.stringify(outputPayload, null, 2), "utf8");
  return "reports/summary.json";
}
