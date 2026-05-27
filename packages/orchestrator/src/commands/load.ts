import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type LoadEngine = "builtin" | "artillery" | "k6";
export type LoadStageName = "ramp-up" | "steady" | "spike" | "soak";

export type LoadConfig = {
  baseUrl: string;
  vus: number;
  durationSeconds: number;
  requestTimeoutMs: number;
  engines?: LoadEngine[];
};

export type LoadEngineResult = {
  engine: LoadEngine;
  status: "ok" | "failed" | "blocked";
  detail: string;
  reasonCode?: string;
  requestsPerSecond?: number;
  p95Ms?: number;
  failedRequests?: number;
};

export type LoadStageResult = {
  stage: LoadStageName;
  vus: number;
  durationSeconds: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  requestsPerSecond: number;
  errorBudgetRate: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    avg: number;
  };
  thresholds: {
    p99MsMax: number;
    errorBudgetRateMax: number;
    rpsMin: number;
  };
  gate: {
    status: "passed" | "failed";
    reasons: string[];
  };
};

export type LoadResult = {
  engine: "multi";
  baseUrl: string;
  vus: number;
  durationSeconds: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  http5xx: number;
  requestsPerSecond: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    avg: number;
    p95Observed: number;
  };
  attribution: {
    topFailingEndpoints: Array<{
      endpoint: string;
      failedRequests: number;
      timeoutErrors: number;
      networkErrors: number;
    }>;
    statusDistribution: Array<{
      status: string;
      count: number;
    }>;
    timeoutErrors: number;
    networkErrors: number;
    otherErrors: number;
    resourcePressure?: {
      stageGateFailures: number;
      lowRpsStages: number;
      highLatencyStages: number;
      maxObservedP99Ms: number;
      minObservedRps: number;
    };
  };
  errorSamples: string[];
  stages: LoadStageResult[];
  gateMetrics: {
    sourceEngine: "builtin";
    failedRequests: number;
    p95Ms: number;
    p99Ms: number;
    requestsPerSecond: number;
    errorBudgetRate: number;
    errorBudgetRateMax: number;
    stageFailedCount: number;
    engineReady: boolean;
    engineReadyReason: string;
    externalEnginesRequested: Array<"artillery" | "k6">;
    externalEnginesOk: Array<"artillery" | "k6">;
  };
  engines: LoadEngineResult[];
  reportPath: string;
};

type StagePlan = {
  stage: LoadStageName;
  vus: number;
  durationSeconds: number;
};

type FetchErrorKind = "timeout" | "network" | "other";

type AttributionAccumulator = {
  endpointFailures: Map<
    string,
    {
      failedRequests: number;
      timeoutErrors: number;
      networkErrors: number;
    }
  >;
  statusCounts: Map<string, number>;
  timeoutErrors: number;
  networkErrors: number;
  otherErrors: number;
};

function normalizeReasonCodeToken(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown_reason";
}

function loadEngineReasonCode(
  engine: LoadEngine,
  status: "blocked" | "failed",
  reason: string,
): string {
  return `load.${engine}.${status}.${normalizeReasonCodeToken(reason)}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function minMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) {
    return { min: 0, max: 0 };
  }
  let min = values[0] as number;
  let max = values[0] as number;
  for (let i = 1; i < values.length; i += 1) {
    const current = values[i] as number;
    if (current < min) {
      min = current;
    }
    if (current > max) {
      max = current;
    }
  }
  return { min, max };
}

function computeLatencySummary(latencies: number[]): {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
} {
  const bounds = minMax(latencies);
  const total = latencies.reduce((acc, value) => acc + value, 0);
  return {
    min: bounds.min,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: bounds.max,
    avg: latencies.length > 0 ? Number((total / latencies.length).toFixed(2)) : 0,
  };
}

function allocateStageDurations(totalSeconds: number): [number, number, number, number] {
  const total = Math.max(4, Math.floor(totalSeconds));
  const parts = [0.2, 0.4, 0.2, 0.2].map((ratio) => Math.max(1, Math.floor(total * ratio)));
  let assigned = parts.reduce((acc, value) => acc + value, 0);

  if (assigned > total) {
    let overflow = assigned - total;
    const reduceOrder = [1, 3, 0, 2];
    for (const idx of reduceOrder) {
      while (overflow > 0 && parts[idx] > 1) {
        parts[idx] -= 1;
        overflow -= 1;
      }
      if (overflow <= 0) {
        break;
      }
    }
  } else if (assigned < total) {
    parts[3] += total - assigned;
  }

  assigned = parts.reduce((acc, value) => acc + value, 0);
  if (assigned !== total) {
    parts[3] += total - assigned;
  }

  return parts as [number, number, number, number];
}

function buildDefaultStagePlan(config: LoadConfig): StagePlan[] {
  const [rampDuration, steadyDuration, spikeDuration, soakDuration] = allocateStageDurations(
    config.durationSeconds,
  );
  const vus = Math.max(1, Math.floor(config.vus));

  return [
    {
      stage: "ramp-up",
      vus: Math.max(1, Math.ceil(vus * 0.6)),
      durationSeconds: rampDuration,
    },
    {
      stage: "steady",
      vus,
      durationSeconds: steadyDuration,
    },
    {
      stage: "spike",
      vus: Math.max(vus + 1, Math.ceil(vus * 1.5)),
      durationSeconds: spikeDuration,
    },
    {
      stage: "soak",
      vus: Math.max(1, Math.ceil(vus * 0.8)),
      durationSeconds: soakDuration,
    },
  ];
}

function stageThresholds(
  stage: StagePlan,
  config: LoadConfig,
): {
  p99MsMax: number;
  errorBudgetRateMax: number;
  rpsMin: number;
} {
  const timeoutUpperBound = Math.max(500, config.requestTimeoutMs);
  const p99BaseFactor = stage.stage === "spike" ? 0.95 : stage.stage === "ramp-up" ? 0.9 : 0.8;
  const p99MsMax = Math.max(300, Math.floor(timeoutUpperBound * p99BaseFactor));
  const errorBudgetRateMax = stage.stage === "spike" ? 0.1 : 0.05;
  const rpsMin = Number(Math.max(0.1, stage.vus * 0.03).toFixed(2));
  return {
    p99MsMax,
    errorBudgetRateMax,
    rpsMin,
  };
}

async function timedFetch(
  url: string,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  errorKind?: FetchErrorKind;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    return { ok: response.ok, status: response.status, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const typedError = error as Error;
    const isAbortError = typedError.name === "AbortError";
    const message = typedError.message.toLowerCase();
    const errorKind: FetchErrorKind = isAbortError
      ? "timeout"
      : /network|fetch failed|econn|enotfound|ehost|socket/i.test(message)
        ? "network"
        : "other";
    return { ok: false, status: 0, latencyMs, error: typedError.message, errorKind };
  } finally {
    clearTimeout(timer);
  }
}

function toEndpointPath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname || "/";
  } catch {
    return rawUrl;
  }
}

function updateAttributionFromFailure(
  attribution: AttributionAccumulator,
  endpoint: string,
  response: { status: number; errorKind?: FetchErrorKind },
): void {
  const endpointStats = attribution.endpointFailures.get(endpoint) ?? {
    failedRequests: 0,
    timeoutErrors: 0,
    networkErrors: 0,
  };
  endpointStats.failedRequests += 1;

  if (response.status > 0) {
    const statusToken = String(response.status);
    attribution.statusCounts.set(statusToken, (attribution.statusCounts.get(statusToken) ?? 0) + 1);
  } else if (response.errorKind === "timeout") {
    attribution.timeoutErrors += 1;
    endpointStats.timeoutErrors += 1;
    attribution.statusCounts.set("timeout", (attribution.statusCounts.get("timeout") ?? 0) + 1);
  } else if (response.errorKind === "network") {
    attribution.networkErrors += 1;
    endpointStats.networkErrors += 1;
    attribution.statusCounts.set(
      "network_error",
      (attribution.statusCounts.get("network_error") ?? 0) + 1,
    );
  } else {
    attribution.otherErrors += 1;
    attribution.statusCounts.set(
      "request_error",
      (attribution.statusCounts.get("request_error") ?? 0) + 1,
    );
  }

  attribution.endpointFailures.set(endpoint, endpointStats);
}

function buildAttributionSummary(
  attribution: AttributionAccumulator,
  stages: LoadStageResult[],
): LoadResult["attribution"] {
  const topFailingEndpoints = Array.from(attribution.endpointFailures.entries())
    .sort((a, b) => b[1].failedRequests - a[1].failedRequests)
    .slice(0, 5)
    .map(([endpoint, stats]) => ({
      endpoint,
      failedRequests: stats.failedRequests,
      timeoutErrors: stats.timeoutErrors,
      networkErrors: stats.networkErrors,
    }));

  const statusDistribution = Array.from(attribution.statusCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({ status, count }));

  const lowRpsStages = stages.filter((stage) =>
    stage.gate.reasons.includes("rps_below_min"),
  ).length;
  const highLatencyStages = stages.filter((stage) =>
    stage.gate.reasons.includes("p99_exceeded"),
  ).length;
  const stageGateFailures = stages.filter((stage) => stage.gate.status === "failed").length;
  const maxObservedP99Ms = stages.reduce((acc, stage) => Math.max(acc, stage.latencyMs.p99), 0);
  const minObservedRps =
    stages.length > 0
      ? stages.reduce(
          (acc, stage) => Math.min(acc, stage.requestsPerSecond),
          Number.POSITIVE_INFINITY,
        )
      : 0;

  const hasResourcePressureSignal = lowRpsStages > 0 || highLatencyStages > 0;

  return {
    topFailingEndpoints,
    statusDistribution,
    timeoutErrors: attribution.timeoutErrors,
    networkErrors: attribution.networkErrors,
    otherErrors: attribution.otherErrors,
    resourcePressure: hasResourcePressureSignal
      ? {
          stageGateFailures,
          lowRpsStages,
          highLatencyStages,
          maxObservedP99Ms,
          minObservedRps: Number.isFinite(minObservedRps) ? minObservedRps : 0,
        }
      : undefined,
  };
}

function commandExists(command: string, args: string[]): boolean {
  const probe = spawnSync(command, args, { encoding: "utf8" });
  return probe.status === 0;
}

function runArtilleryProbe(baseDir: string, config: LoadConfig): LoadEngineResult {
  if (!commandExists("pnpm", ["exec", "artillery", "--version"])) {
    return {
      engine: "artillery",
      status: "blocked",
      detail: "artillery_not_available",
      reasonCode: loadEngineReasonCode("artillery", "blocked", "artillery_not_available"),
    };
  }
  const scriptPath = resolve(baseDir, "metrics/artillery-config.yml");
  writeFileSync(
    scriptPath,
    [
      "config:",
      `  target: "${config.baseUrl}"`,
      "  phases:",
      `    - duration: ${Math.max(1, config.durationSeconds)}`,
      `      arrivalRate: ${Math.max(1, Math.floor(config.vus / 2))}`,
      "scenarios:",
      "  - flow:",
      "      - get:",
      '          url: "/"',
    ].join("\n"),
    "utf8",
  );

  const proc = spawnSync("pnpm", ["exec", "artillery", "run", scriptPath], {
    encoding: "utf8",
    timeout: Math.max(15_000, config.durationSeconds * 2_000),
  });

  if (proc.status !== 0) {
    return {
      engine: "artillery",
      status: "failed",
      detail: (proc.stderr ?? proc.stdout ?? "artillery_failed").toString().slice(-280),
      reasonCode: loadEngineReasonCode("artillery", "failed", "artillery_process_failed"),
    };
  }

  return {
    engine: "artillery",
    status: "ok",
    detail: "artillery_run_completed",
  };
}

function runK6Probe(baseDir: string, config: LoadConfig): LoadEngineResult {
  if (!commandExists("k6", ["version"])) {
    return {
      engine: "k6",
      status: "blocked",
      detail: "k6_not_available",
      reasonCode: loadEngineReasonCode("k6", "blocked", "k6_not_available"),
    };
  }

  const scriptPath = resolve(baseDir, "metrics/k6-script.js");
  const summaryPath = resolve(baseDir, "metrics/k6-summary.json");
  writeFileSync(
    scriptPath,
    [
      "import http from 'k6/http';",
      "import { sleep } from 'k6';",
      "export const options = {",
      `  vus: ${Math.max(1, config.vus)},`,
      `  duration: '${Math.max(1, config.durationSeconds)}s'`,
      "};",
      "export default function () {",
      `  http.get('${config.baseUrl}');`,
      "  sleep(0.2);",
      "}",
    ].join("\n"),
    "utf8",
  );

  const proc = spawnSync("k6", ["run", scriptPath, "--summary-export", summaryPath], {
    encoding: "utf8",
    timeout: Math.max(20_000, config.durationSeconds * 2_000),
  });

  if (proc.status !== 0) {
    return {
      engine: "k6",
      status: "failed",
      detail: (proc.stderr ?? proc.stdout ?? "k6_failed").toString().slice(-280),
      reasonCode: loadEngineReasonCode("k6", "failed", "k6_process_failed"),
    };
  }

  try {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      metrics?: {
        http_req_failed?: { values?: { rate?: number } };
        http_req_duration?: { values?: { p95?: number } };
      };
    };
    return {
      engine: "k6",
      status: "ok",
      detail: "k6_run_completed",
      failedRequests: summary.metrics?.http_req_failed?.values?.rate,
      p95Ms: summary.metrics?.http_req_duration?.values?.p95,
    };
  } catch {
    return {
      engine: "k6",
      status: "ok",
      detail: "k6_run_completed",
    };
  }
}

async function executeStage(
  config: LoadConfig,
  stagePlan: StagePlan,
  errorSamples: string[],
  attribution: AttributionAccumulator,
): Promise<{ stage: LoadStageResult; http5xx: number; latencies: number[] }> {
  const deadline = Date.now() + stagePlan.durationSeconds * 1000;
  const latencies: number[] = [];
  let totalRequests = 0;
  let successRequests = 0;
  let failedRequests = 0;
  let http5xx = 0;
  const endpoint = toEndpointPath(config.baseUrl);

  async function workerLoop(workerId: number): Promise<void> {
    while (Date.now() < deadline) {
      const response = await timedFetch(config.baseUrl, config.requestTimeoutMs);
      totalRequests += 1;
      latencies.push(response.latencyMs);

      if (response.ok) {
        successRequests += 1;
      } else {
        failedRequests += 1;
        updateAttributionFromFailure(attribution, endpoint, {
          status: response.status,
          errorKind: response.errorKind,
        });
        if (response.status >= 500) {
          http5xx += 1;
        }
        if (errorSamples.length < 20) {
          errorSamples.push(
            response.error
              ? `stage=${stagePlan.stage} worker=${workerId} error=${response.error}`
              : `stage=${stagePlan.stage} worker=${workerId} status=${response.status}`,
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: stagePlan.vus }, (_, i) => workerLoop(i + 1)));

  const duration = Math.max(1, stagePlan.durationSeconds);
  const latency = computeLatencySummary(latencies);
  const requestsPerSecond = Number((totalRequests / duration).toFixed(2));
  const errorBudgetRate =
    totalRequests > 0 ? Number((failedRequests / totalRequests).toFixed(4)) : 1;
  const thresholds = stageThresholds(stagePlan, config);
  const reasons: string[] = [];
  if (latency.p99 > thresholds.p99MsMax) {
    reasons.push("p99_exceeded");
  }
  if (errorBudgetRate > thresholds.errorBudgetRateMax) {
    reasons.push("error_budget_exceeded");
  }
  if (requestsPerSecond < thresholds.rpsMin) {
    reasons.push("rps_below_min");
  }

  return {
    stage: {
      stage: stagePlan.stage,
      vus: stagePlan.vus,
      durationSeconds: stagePlan.durationSeconds,
      totalRequests,
      successRequests,
      failedRequests,
      requestsPerSecond,
      errorBudgetRate,
      latencyMs: latency,
      thresholds,
      gate: {
        status: reasons.length === 0 ? "passed" : "failed",
        reasons,
      },
    },
    http5xx,
    latencies,
  };
}

function evaluateExternalEngineReadiness(
  requestedEngines: LoadEngine[],
  engines: LoadEngineResult[],
): {
  externalEnginesRequested: Array<"artillery" | "k6">;
  externalEnginesOk: Array<"artillery" | "k6">;
  engineReady: boolean;
  reason: string;
} {
  const externalEnginesRequested = requestedEngines.filter(
    (engine): engine is "artillery" | "k6" => engine !== "builtin",
  );
  const externalEnginesOk = engines
    .filter(
      (engine): engine is LoadEngineResult & { engine: "artillery" | "k6" } =>
        engine.engine !== "builtin",
    )
    .filter((engine) => engine.status === "ok")
    .map((engine) => engine.engine);

  if (externalEnginesRequested.length === 0) {
    return {
      externalEnginesRequested,
      externalEnginesOk,
      engineReady: false,
      reason: "external_engine_not_requested",
    };
  }

  if (externalEnginesOk.length === 0) {
    return {
      externalEnginesRequested,
      externalEnginesOk,
      engineReady: false,
      reason: "no_external_engine_ready",
    };
  }

  return {
    externalEnginesRequested,
    externalEnginesOk,
    engineReady: true,
    reason: "one_of_external_engine_ready",
  };
}

export async function runLoad(baseDir: string, config: LoadConfig): Promise<LoadResult> {
  const stagePlan = buildDefaultStagePlan(config);
  const errorSamples: string[] = [];
  const stageResults: LoadStageResult[] = [];
  const allLatencies: number[] = [];
  const attribution: AttributionAccumulator = {
    endpointFailures: new Map(),
    statusCounts: new Map(),
    timeoutErrors: 0,
    networkErrors: 0,
    otherErrors: 0,
  };

  let totalRequests = 0;
  let successRequests = 0;
  let rawFailedRequests = 0;
  let http5xx = 0;

  for (const stage of stagePlan) {
    const stageExecution = await executeStage(config, stage, errorSamples, attribution);
    stageResults.push(stageExecution.stage);
    allLatencies.push(...stageExecution.latencies);
    totalRequests += stageExecution.stage.totalRequests;
    successRequests += stageExecution.stage.successRequests;
    rawFailedRequests += stageExecution.stage.failedRequests;
    http5xx += stageExecution.http5xx;
  }

  const totalDuration = stagePlan.reduce((acc, stage) => acc + stage.durationSeconds, 0);
  const latency = computeLatencySummary(allLatencies);
  const rawRps = Number((totalRequests / Math.max(1, totalDuration)).toFixed(2));
  const errorBudgetRate =
    totalRequests > 0 ? Number((rawFailedRequests / totalRequests).toFixed(4)) : 1;
  const globalErrorBudgetRateMax = 0.05;
  const globalP99MsMax = Math.max(300, Math.floor(Math.max(500, config.requestTimeoutMs) * 0.85));

  const engineSet = new Set<LoadEngine>(config.engines ?? ["builtin", "artillery", "k6"]);
  const requestedEngines = Array.from(engineSet.values());
  const engines: LoadEngineResult[] = [
    {
      engine: "builtin",
      status: "ok",
      detail: "builtin_http_probe_completed",
      requestsPerSecond: rawRps,
      p95Ms: latency.p95,
      failedRequests: rawFailedRequests,
    },
  ];

  if (engineSet.has("artillery")) {
    engines.push(runArtilleryProbe(baseDir, config));
  }
  if (engineSet.has("k6")) {
    engines.push(runK6Probe(baseDir, config));
  }

  const stageFailedCount = stageResults.filter((item) => item.gate.status === "failed").length;
  const globalSlaFailed =
    latency.p99 > globalP99MsMax || errorBudgetRate > globalErrorBudgetRateMax;

  const externalGate = evaluateExternalEngineReadiness(requestedEngines, engines);
  const engineReady = externalGate.engineReady;
  const attributionSummary = buildAttributionSummary(attribution, stageResults);

  let failedRequests = rawFailedRequests;
  if (globalSlaFailed) {
    failedRequests += 1;
  }
  if (stageFailedCount > 0) {
    failedRequests += stageFailedCount;
  }
  if (!engineReady) {
    failedRequests += 1;
  }

  const result: LoadResult = {
    engine: "multi",
    baseUrl: config.baseUrl,
    vus: config.vus,
    durationSeconds: totalDuration,
    totalRequests,
    successRequests,
    failedRequests,
    http5xx,
    requestsPerSecond: engineReady ? rawRps : 0,
    latencyMs: {
      min: latency.min,
      p50: latency.p50,
      p95: latency.p99,
      p99: latency.p99,
      max: latency.max,
      avg: latency.avg,
      p95Observed: latency.p95,
    },
    attribution: attributionSummary,
    errorSamples,
    stages: stageResults,
    gateMetrics: {
      sourceEngine: "builtin",
      failedRequests,
      p95Ms: latency.p95,
      p99Ms: latency.p99,
      requestsPerSecond: engineReady ? rawRps : 0,
      errorBudgetRate,
      errorBudgetRateMax: globalErrorBudgetRateMax,
      stageFailedCount,
      engineReady,
      engineReadyReason: externalGate.reason,
      externalEnginesRequested: externalGate.externalEnginesRequested,
      externalEnginesOk: externalGate.externalEnginesOk,
    },
    engines,
    reportPath: "metrics/load-summary.json",
  };

  writeFileSync(resolve(baseDir, result.reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}
