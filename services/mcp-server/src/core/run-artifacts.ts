// @ts-nocheck
// 
import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
  type JsonObject,
  latestRunId,
  readJson,
  readJsonMaybe,
  readUtf8,
  repoRoot,
  runsRoot,
  safeResolveUnder,
} from "./io.js";

export type GateCheck = {
  id?: string;
  status?: string;
  actual?: unknown;
  expected?: unknown;
  reasonCode?: string;
  evidencePath?: string;
};

export type FailedCheck = {
  id: string;
  status: string;
  actual: unknown;
  expected: unknown;
  reasonCode?: string;
  evidencePath: string | null;
  source: "manifest" | "summary";
};

export const DEFAULT_EVIDENCE_PATH_BY_CHECK_ID: Record<string, string> = {
  gate: "reports/summary.json",
  a11y: "a11y/axe.json",
  perf: "perf/lighthouse.json",
  visual: "visual/report.json",
  security: "security/report.json",
  load: "metrics/load-summary.json",
  explore: "explore/report.json",
  chaos: "chaos/report.json",
  desktopReadiness: "metrics/desktop-readiness.json",
  desktopSmoke: "metrics/desktop-smoke.json",
  desktopE2E: "metrics/desktop-e2e.json",
  desktopSoak: "metrics/desktop-soak.json",
  "console.error": "reports/summary.json",
  "page.error": "reports/summary.json",
  "http.5xx": "reports/summary.json",
  "runtime.healthcheck": "reports/summary.json",
  "driver.capability": "reports/summary.json",
  "test.unit": "reports/summary.json",
  "test.contract": "reports/summary.json",
  "test.ct": "reports/summary.json",
  "test.e2e": "reports/summary.json",
  "security.high_vuln": "security/report.json",
  "a11y.serious_max": "a11y/axe.json",
  "a11y.engine_ready": "a11y/axe.json",
  "perf.lcp_ms_max": "perf/lighthouse.json",
  "perf.fcp_ms_max": "perf/lighthouse.json",
  "perf.engine_ready": "perf/lighthouse.json",
  "visual.diff_pixels_max": "visual/report.json",
  "visual.baseline_ready": "visual/report.json",
  "load.failed_requests": "metrics/load-summary.json",
  "load.p95_ms": "metrics/load-summary.json",
  "load.rps_min": "metrics/load-summary.json",
  "explore.under_explored": "explore/report.json",
  "desktop.readiness": "metrics/desktop-readiness.json",
  "desktop.smoke": "metrics/desktop-smoke.json",
  "desktop.e2e": "metrics/desktop-e2e.json",
  "desktop.soak": "metrics/desktop-soak.json",
};

function fallbackEvidencePathForCheck(id: string, explicitPath?: string): string | null {
  const explicit = explicitPath?.trim();
  if (explicit) {
    return explicit;
  }
  return DEFAULT_EVIDENCE_PATH_BY_CHECK_ID[id] ?? null;
}

export function extractFailedChecks(
  manifestChecks?: GateCheck[],
  summaryChecks?: GateCheck[],
): FailedCheck[] {
  const source: FailedCheck["source"] = Array.isArray(manifestChecks) ? "manifest" : "summary";
  const checks = source === "manifest" ? (manifestChecks ?? []) : (summaryChecks ?? []);
  return checks
    .filter((c) => c.status === "failed" || c.status === "blocked")
    .map((c) => {
      const id = c.id?.trim() || "unknown";
      return {
        id,
        status: c.status ?? "unknown",
        actual: c.actual,
        expected: c.expected,
        ...(c.reasonCode ? { reasonCode: c.reasonCode } : {}),
        evidencePath: fallbackEvidencePathForCheck(id, c.evidencePath),
        source,
      };
    });
}

export function readRunArtifacts(runId: string): {
  manifestPath: string;
  summaryPath: string;
  manifest?: {
    gateResults?: { status?: string; checks?: GateCheck[] };
    reports?: Record<string, string>;
  };
  summary?: { status?: string; checks?: GateCheck[] };
} {
  const root = runsRoot();
  const manifestPath = safeResolveUnder(root, runId, "manifest.json");
  const summaryPath = safeResolveUnder(root, runId, "reports/summary.json");
  const manifest = readJsonMaybe<{
    gateResults?: { status?: string; checks?: GateCheck[] };
    reports?: Record<string, string>;
  }>(manifestPath);
  const summary = readJsonMaybe<{ status?: string; checks?: GateCheck[] }>(summaryPath);
  if (!manifest && !summary) {
    throw new Error(`run artifacts missing for ${runId}: manifest.json and reports/summary.json`);
  }
  return { manifestPath, summaryPath, manifest, summary };
}

export function readRunOverview(runId: string): {
  runId: string;
  gateStatus: string | null;
  failedChecks: FailedCheck[];
  summaryPath: string;
  manifestPath: string;
} {
  const { manifestPath, summaryPath, manifest, summary } = readRunArtifacts(runId);
  const failedChecks = extractFailedChecks(manifest?.gateResults?.checks, summary?.checks);

  return {
    runId,
    gateStatus: manifest?.gateResults?.status ?? summary?.status ?? null,
    failedChecks,
    summaryPath,
    manifestPath,
  };
}

function readRunJson(runId: string, rel: string): unknown {
  return readJson(safeResolveUnder(runsRoot(), runId, rel));
}

export function pickRunIdOrLatest(input?: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }
  const latest = latestRunId();
  if (!latest) {
    throw new Error("no runs found");
  }
  return latest;
}

export function analyzeA11y(runId: string, topN: number): JsonObject {
  const data = readRunJson(runId, "a11y/axe.json") as {
    counts?: JsonObject;
    issues?: Array<{ id?: string; severity?: string; message?: string; selector?: string }>;
    scannedAt?: string;
  };
  const issues = (data.issues ?? []).slice(0, Math.max(1, topN)).map((it, i) => ({
    rank: i + 1,
    id: it.id ?? "unknown",
    severity: it.severity ?? "unknown",
    message: it.message ?? "",
    selector: it.selector ?? "",
  }));
  return {
    runId,
    counts: data.counts ?? {},
    scannedAt: data.scannedAt ?? null,
    topIssues: issues,
  };
}

export function analyzePerf(runId: string): JsonObject {
  const data = readRunJson(runId, "perf/lighthouse.json") as {
    engine?: string;
    preset?: string;
    metrics?: JsonObject;
    measuredAt?: string;
    fallbackUsed?: boolean;
    deterministic?: JsonObject;
  };
  return {
    runId,
    engine: data.engine ?? null,
    preset: data.preset ?? null,
    measuredAt: data.measuredAt ?? null,
    fallbackUsed: data.fallbackUsed ?? null,
    metrics: data.metrics ?? {},
    deterministic: data.deterministic ?? {},
  };
}

export function analyzeVisual(runId: string): JsonObject {
  const data = readRunJson(runId, "visual/report.json") as {
    mode?: string;
    diffPixels?: number;
    totalPixels?: number;
    diffRatio?: number;
    baselineCreated?: boolean;
    baselinePath?: string;
    currentPath?: string;
    diffPath?: string;
  };
  return {
    runId,
    mode: data.mode ?? null,
    diffPixels: data.diffPixels ?? null,
    totalPixels: data.totalPixels ?? null,
    diffRatio: data.diffRatio ?? null,
    baselineCreated: data.baselineCreated ?? null,
    baselinePath: data.baselinePath ?? null,
    currentPath: data.currentPath ?? null,
    diffPath: data.diffPath ?? null,
  };
}

export function analyzeSecurity(runId: string): JsonObject {
  const root = runsRoot();
  const reportPath = safeResolveUnder(root, runId, "security/report.json");
  const ticketsPath = safeResolveUnder(root, runId, "metrics/security-tickets.json");
  const report = existsSync(reportPath) ? (readJson(reportPath) as JsonObject) : {};
  const tickets = existsSync(ticketsPath) ? (readJson(ticketsPath) as unknown[]) : [];
  return {
    runId,
    hasReport: existsSync(reportPath),
    hasTickets: existsSync(ticketsPath),
    report,
    ticketCount: tickets.length,
    ticketsSample: tickets.slice(0, 20),
  };
}

function readJsonIfExists(runId: string, rel: string): unknown | null {
  const abs = safeResolveUnder(runsRoot(), runId, rel);
  if (!existsSync(abs)) {
    return null;
  }
  return readJson(abs);
}

export function buildReportBundle(
  runId: string,
  options?: {
    proof?: {
      latestCampaignId: string | null;
      campaignsForRun: string[];
      latestRunProof: unknown | null;
    };
  },
): JsonObject {
  const root = runsRoot();
  const { manifestPath, summaryPath, manifest, summary } = readRunArtifacts(runId);
  const diagnosticsIndexPath = safeResolveUnder(root, runId, "reports/diagnostics.index.json");
  const diagnosticsIndex = existsSync(diagnosticsIndexPath)
    ? (readJson(diagnosticsIndexPath) as JsonObject)
    : null;
  const failingChecks = extractFailedChecks(manifest?.gateResults?.checks, summary?.checks);

  const screenshotCandidates = [
    "screenshots/home_default.png",
    "screenshots/driver-web-home.png",
    "screenshots/desktop-tauri-smoke.png",
    "screenshots/desktop-swift-smoke.png",
    "screenshots/desktop-tauri-e2e.png",
    "screenshots/desktop-swift-e2e.png",
  ];
  const screenshots = screenshotCandidates.filter((relativePath) => {
    return existsSync(safeResolveUnder(root, runId, relativePath));
  });

  return {
    runId,
    gateStatus: manifest?.gateResults?.status ?? summary?.status ?? null,
    failedChecks: failingChecks,
    paths: {
      manifest: existsSync(manifestPath) ? "manifest.json" : null,
      summary: existsSync(summaryPath) ? "reports/summary.json" : null,
      diagnosticsIndex: existsSync(diagnosticsIndexPath) ? "reports/diagnostics.index.json" : null,
    },
    reports: manifest?.reports ?? {},
    reportFiles: {
      explore: readJsonIfExists(runId, "explore/report.json"),
      chaos: readJsonIfExists(runId, "chaos/report.json"),
      desktopReadiness: readJsonIfExists(runId, "metrics/desktop-readiness.json"),
      desktopSmoke: readJsonIfExists(runId, "metrics/desktop-smoke.json"),
      desktopE2E: readJsonIfExists(runId, "metrics/desktop-e2e.json"),
      desktopSoak: readJsonIfExists(runId, "metrics/desktop-soak.json"),
    },
    summarySlices: {
      a11y: readJsonIfExists(runId, "a11y/axe.json"),
      perf: readJsonIfExists(runId, "perf/lighthouse.json"),
      visual: readJsonIfExists(runId, "visual/report.json"),
      security: readJsonIfExists(runId, "security/report.json"),
      load: readJsonIfExists(runId, "metrics/load-summary.json"),
    },
    proof: options?.proof ?? {
      latestCampaignId: null,
      campaignsForRun: [],
      latestRunProof: null,
    },
    screenshots,
    diagnosticsIndex,
  };
}

export function comparePerf(runA: string, runB: string): JsonObject {
  const a = analyzePerf(runA) as { metrics?: JsonObject };
  const b = analyzePerf(runB) as { metrics?: JsonObject };
  const metricsA = a.metrics ?? {};
  const metricsB = b.metrics ?? {};
  const keys = new Set([...Object.keys(metricsA), ...Object.keys(metricsB)]);
  const deltas: JsonObject = {};
  for (const key of keys) {
    const va = metricsA[key];
    const vb = metricsB[key];
    if (typeof va === "number" && typeof vb === "number") {
      deltas[key] = { from: va, to: vb, delta: Number((vb - va).toFixed(3)) };
    }
  }
  return { runA, runB, deltas };
}

export function readRepoTextFile(relativePath: string): string {
  const root = repoRoot();
  const normalized = relativePath.trim();
  if (!normalized) {
    throw new Error("relativePath is required");
  }
  const allowedPrefixes = [
    "README.md",
    "docs/",
    "configs/profiles/",
    "configs/targets/",
    "contracts/openapi/",
    "configs/",
  ];
  const isAllowed = allowedPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
  if (!isAllowed) {
    throw new Error(
      "path not allowed; use docs/, configs/profiles/, configs/targets/, contracts/openapi/, configs/, README.md",
    );
  }
  const abs = safeResolveUnder(root, normalized);
  const ext = extname(abs).toLowerCase();
  if (![".md", ".yaml", ".yml", ".json", ".txt"].includes(ext)) {
    throw new Error("file extension not allowed");
  }
  return readUtf8(abs);
}
