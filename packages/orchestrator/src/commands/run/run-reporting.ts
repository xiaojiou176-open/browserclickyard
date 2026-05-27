import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Manifest,
  ManifestEvidenceItem,
  ManifestGateCheck,
} from "../../../../core/src/manifest/types.js";
import type {
  DiagnosticsIndex,
  FailureLocation,
  NormalizedDiagnosticsSection,
  NormalizedList,
} from "./run-types.js";

export function gateReasonCode(
  checkId: string,
  status: "passed" | "failed" | "blocked",
  reason: string,
): string {
  return `gate.${checkId.replaceAll(".", "_")}.${status}.${reason}`;
}

export function normalizeCheckReasonCode(check: ManifestGateCheck): ManifestGateCheck {
  const reason = check.reasonCode?.trim();
  if (reason) {
    return check;
  }
  return {
    ...check,
    reasonCode: gateReasonCode(
      check.id,
      check.status,
      check.status === "passed" ? "ok" : "unspecified",
    ),
  };
}

function inferStepIdForCheck(checkId: string): string {
  if (
    checkId.startsWith("console.") ||
    checkId.startsWith("page.") ||
    checkId.startsWith("http.")
  ) {
    return "capture";
  }
  if (checkId.startsWith("safety.")) {
    return "explore";
  }
  if (checkId.startsWith("a11y.")) {
    return "a11y";
  }
  if (checkId.startsWith("perf.")) {
    return "perf";
  }
  if (checkId.startsWith("explore.")) {
    return "explore";
  }
  if (checkId.startsWith("scenario.computer_use") || checkId.startsWith("computer_use.execution")) {
    return "computer_use";
  }
  if (checkId.startsWith("ai_review.")) {
    return "ai_review";
  }
  if (checkId.startsWith("visual.")) {
    return "visual";
  }
  if (checkId.startsWith("load.")) {
    return "load";
  }
  if (checkId.startsWith("security.")) {
    return "security";
  }
  if (checkId.startsWith("test.unit")) {
    return "unit";
  }
  if (checkId.startsWith("test.contract")) {
    return "contract";
  }
  if (checkId.startsWith("test.ct")) {
    return "ct";
  }
  if (checkId.startsWith("test.e2e")) {
    return "e2e";
  }
  if (checkId.startsWith("computer_use.")) {
    return "computer_use";
  }
  if (checkId.startsWith("desktop.readiness")) {
    return "desktop_readiness";
  }
  if (checkId.startsWith("desktop.smoke")) {
    return "desktop_smoke";
  }
  if (checkId.startsWith("desktop.e2e")) {
    return "desktop_e2e";
  }
  if (checkId.startsWith("desktop.business_regression")) {
    return "desktop_business_regression";
  }
  if (checkId.startsWith("desktop.soak")) {
    return "desktop_soak";
  }
  if (checkId.startsWith("runtime.healthcheck")) {
    return "runtime";
  }
  if (checkId.startsWith("driver.capability")) {
    return "driver";
  }
  if (checkId.startsWith("engine.policy")) {
    return "runtime";
  }
  if (checkId.startsWith("execution.")) {
    return "runtime";
  }
  return "unknown";
}

export function collectFailureLocations(
  checks: Manifest["gateResults"]["checks"],
): FailureLocation[] {
  return checks
    .filter(
      (
        check,
      ): check is Manifest["gateResults"]["checks"][number] & { status: "failed" | "blocked" } =>
        check.status === "failed" || check.status === "blocked",
    )
    .map((check) => ({
      checkId: check.id,
      status: check.status,
      reasonCode: check.reasonCode ?? gateReasonCode(check.id, check.status, "unspecified"),
      stepId: inferStepIdForCheck(check.id),
      artifactPath: check.evidencePath,
    }));
}

function inferEvidenceKind(path: string): ManifestEvidenceItem["kind"] {
  if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "screenshot";
  }
  if (path.endsWith(".html")) {
    return "dom";
  }
  if (path.endsWith(".zip")) {
    return "trace";
  }
  if (path.endsWith(".har")) {
    return "network";
  }
  if (path.endsWith(".log")) {
    return "log";
  }
  if (path.includes("/videos/")) {
    return "video";
  }
  if (path.includes("/reports/")) {
    return "report";
  }
  if (path.includes("/metrics/")) {
    return "metric";
  }
  return "other";
}

export function buildEvidenceIndex(
  states: Manifest["states"],
  reports: Record<string, string>,
  checks: ManifestGateCheck[],
): ManifestEvidenceItem[] {
  const items: ManifestEvidenceItem[] = [];
  let stateSeq = 1;
  for (const state of states) {
    const stateRecord =
      typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
    const stateId = typeof stateRecord.id === "string" ? stateRecord.id : `state_${stateSeq}`;
    const artifacts =
      typeof stateRecord.artifacts === "object" && stateRecord.artifacts !== null
        ? (stateRecord.artifacts as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(artifacts)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      items.push({
        id: `state.${stateId}.${key}`,
        source: "state",
        kind: inferEvidenceKind(value),
        path: value,
      });
    }
    stateSeq += 1;
  }
  for (const [key, value] of Object.entries(reports)) {
    if (!value || typeof value !== "string") {
      continue;
    }
    items.push({
      id: `report.${key}`,
      source: "report",
      kind: inferEvidenceKind(value),
      path: value,
    });
  }
  for (const check of checks) {
    items.push({
      id: `gate.${check.id}`,
      source: "gate",
      kind: inferEvidenceKind(check.evidencePath),
      path: check.evidencePath,
    });
  }

  const deduped = new Map<string, ManifestEvidenceItem>();
  for (const item of items) {
    const dedupeKey = `${item.source}:${item.path}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, item);
    }
  }
  return Array.from(deduped.values());
}

export function writeEvidenceIndex(
  baseDir: string,
  payload: {
    runId: string;
    profile: string;
    target: { type: string; name: string };
    items: ManifestEvidenceItem[];
  },
): string {
  const outputPath = resolve(baseDir, "reports/evidence.index.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        runId: payload.runId,
        profile: payload.profile,
        target: payload.target,
        generatedAt: new Date().toISOString(),
        items: payload.items.map((item) => ({
          id: item.id,
          source: item.source,
          evidenceClass: item.kind,
          path: item.path,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  return "reports/evidence.index.json";
}

export function normalizeList(values: string[], maxItems: number): NormalizedList {
  const originalCount = values.length;
  const unique = Array.from(new Set(values));
  const kept = unique.slice(0, maxItems);
  return {
    items: kept,
    truncation: {
      originalCount,
      uniqueCount: unique.length,
      keptCount: kept.length,
      truncated: unique.length > maxItems,
    },
  };
}

export function normalizeDiagnosticsSection(
  section: { consoleErrors: string[]; pageErrors: string[]; http5xxUrls: string[] },
  maxItems: number,
): NormalizedDiagnosticsSection {
  const consoleErrors = normalizeList(section.consoleErrors, maxItems);
  const pageErrors = normalizeList(section.pageErrors, maxItems);
  const http5xxUrls = normalizeList(section.http5xxUrls, maxItems);

  return {
    consoleErrors: consoleErrors.items,
    pageErrors: pageErrors.items,
    http5xxUrls: http5xxUrls.items,
    truncation: {
      consoleErrors: consoleErrors.truncation,
      pageErrors: pageErrors.truncation,
      http5xxUrls: http5xxUrls.truncation,
    },
  };
}

type CacheStatRecord = {
  hits: number;
  misses: number;
};

export type ResolvedCacheStats = CacheStatRecord & {
  hitRate: number;
  reason:
    | "derived_from_report_cache_fields"
    | "cache_stats_unavailable_no_report_fields"
    | "cache_stats_unavailable_parse_error";
  sourcePaths: string[];
  sourceCount: number;
  parseErrors: number;
  missingReports: number;
};

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function extractCacheStatRecord(value: unknown): CacheStatRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const hits = toNonNegativeNumber(record.hits ?? record.hit);
  const misses = toNonNegativeNumber(record.misses ?? record.miss);
  if (typeof hits !== "number" || typeof misses !== "number") {
    return undefined;
  }
  return { hits, misses };
}

function collectCacheStatRecords(payload: unknown): CacheStatRecord[] {
  const records: CacheStatRecord[] = [];
  const stack: unknown[] = [payload];
  let guard = 0;
  while (stack.length > 0 && guard < 2000) {
    const current = stack.pop();
    guard += 1;
    const stats = extractCacheStatRecord(current);
    if (stats) {
      records.push(stats);
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    for (const value of Object.values(current as Record<string, unknown>)) {
      stack.push(value);
    }
  }
  return records;
}

export function deriveCacheStatsFromReports(
  baseDir: string,
  reportPaths: string[],
): ResolvedCacheStats {
  const uniquePaths = Array.from(
    new Set(reportPaths.map((path) => path.trim()).filter((path) => path.length > 0)),
  );
  let hits = 0;
  let misses = 0;
  let parseErrors = 0;
  let missingReports = 0;
  const sourcePaths = new Set<string>();
  for (const relativePath of uniquePaths) {
    const absolutePath = resolve(baseDir, relativePath);
    if (!existsSync(absolutePath)) {
      missingReports += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch {
      parseErrors += 1;
      continue;
    }
    const records = collectCacheStatRecords(parsed);
    if (records.length === 0) {
      continue;
    }
    sourcePaths.add(relativePath);
    for (const record of records) {
      hits += record.hits;
      misses += record.misses;
    }
  }
  const hitRate = hits + misses > 0 ? Number((hits / (hits + misses)).toFixed(4)) : 0;
  const reason: ResolvedCacheStats["reason"] =
    sourcePaths.size > 0
      ? "derived_from_report_cache_fields"
      : parseErrors > 0
        ? "cache_stats_unavailable_parse_error"
        : "cache_stats_unavailable_no_report_fields";
  return {
    hits,
    misses,
    hitRate,
    reason,
    sourcePaths: Array.from(sourcePaths),
    sourceCount: sourcePaths.size,
    parseErrors,
    missingReports,
  };
}

export function writeDiagnosticsIndex(baseDir: string, payload: DiagnosticsIndex): string {
  const outputPath = resolve(baseDir, "reports/diagnostics.index.json");
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  return "reports/diagnostics.index.json";
}

export function getGitInfo(): { branch: string; commit: string; dirty: boolean } {
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
