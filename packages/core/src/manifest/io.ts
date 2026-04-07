import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Manifest, ManifestCacheStats, ManifestEvidenceItem } from "./types.js";

const schemaPath = resolve("packages/core/src/manifest/manifest.schema.json");
const DEFAULT_GEMINI_MODEL = "models/gemini-3.1-pro-preview";

type LegacyManifest = Omit<Manifest, "schemaVersion" | "execution" | "evidenceIndex"> &
  Partial<Pick<Manifest, "schemaVersion" | "execution" | "evidenceIndex" | "schemaCompatibility">>;

export type ReadManifestResult = {
  manifest: Manifest;
  schemaCompatibility: "v1.1" | "legacy_v1";
  missingEvidence: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNonNegativeNumber(value: unknown, fallback = 0): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, numericValue);
}

function assertRelativeArtifactPath(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`Manifest validation failed: ${label} must not be empty`);
  }
  if (isAbsolute(value)) {
    throw new Error(`Manifest validation failed: ${label} must be relative path`);
  }
  if (value.includes("..")) {
    throw new Error(`Manifest validation failed: ${label} must not contain '..'`);
  }
}

function normalizeReasonCode(
  checkId: string,
  status: "passed" | "failed" | "blocked",
  reasonCode?: string,
): string {
  if (reasonCode && reasonCode.trim().length > 0) {
    return reasonCode.trim();
  }
  const normalizedId = checkId.replaceAll(".", "_");
  if (status === "passed") {
    return `gate.${normalizedId}.passed.ok`;
  }
  return `gate.${normalizedId}.${status}.unspecified`;
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

function dedupeEvidence(items: ManifestEvidenceItem[]): ManifestEvidenceItem[] {
  const seen = new Set<string>();
  const result: ManifestEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildEvidenceIndexFromLegacy(manifest: LegacyManifest): ManifestEvidenceItem[] {
  const items: ManifestEvidenceItem[] = [];
  let seq = 1;

  for (const state of manifest.states ?? []) {
    const rec = isRecord(state) ? state : {};
    const stateId = typeof rec.id === "string" && rec.id ? rec.id : `state_${seq}`;
    const artifacts = isRecord(rec.artifacts) ? rec.artifacts : {};
    for (const [name, value] of Object.entries(artifacts)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      items.push({
        id: `state.${stateId}.${name}`,
        source: "state",
        kind: inferEvidenceKind(value),
        path: value,
      });
    }
    seq += 1;
  }

  for (const [name, value] of Object.entries(manifest.reports ?? {})) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    items.push({
      id: `report.${name}`,
      source: "report",
      kind: inferEvidenceKind(value),
      path: value,
    });
  }

  for (const check of manifest.gateResults?.checks ?? []) {
    if (!isRecord(check)) {
      continue;
    }
    const id = typeof check.id === "string" ? check.id : `check_${items.length + 1}`;
    const evidencePath = typeof check.evidencePath === "string" ? check.evidencePath : "";
    if (!evidencePath) {
      continue;
    }
    items.push({
      id: `gate.${id}`,
      source: "gate",
      kind: inferEvidenceKind(evidencePath),
      path: evidencePath,
    });
  }

  return dedupeEvidence(items);
}

function normalizeManifest(input: LegacyManifest): Manifest {
  const states = Array.isArray(input.states) ? input.states : [];
  const summary = isRecord(input.summary)
    ? input.summary
    : { consoleError: 0, pageError: 0, http5xx: 0 };
  const cacheStats: Partial<ManifestCacheStats> = isRecord(summary.cacheStats)
    ? (summary.cacheStats as Partial<ManifestCacheStats>)
    : {};
  const cacheHit = toFiniteNonNegativeNumber(cacheStats.hit ?? cacheStats.hits, 0);
  const cacheMiss = toFiniteNonNegativeNumber(cacheStats.miss ?? cacheStats.misses, 0);
  const cacheHitRate =
    typeof cacheStats.hitRate === "number"
      ? toFiniteNonNegativeNumber(cacheStats.hitRate, 0)
      : cacheHit + cacheMiss > 0
        ? Number((cacheHit / (cacheHit + cacheMiss)).toFixed(4))
        : 0;
  const aiModel =
    typeof summary.aiModel === "string" && summary.aiModel.trim().length > 0
      ? summary.aiModel
      : DEFAULT_GEMINI_MODEL;
  const promptVersion = typeof summary.promptVersion === "string" ? summary.promptVersion : "";
  const fixIterations =
    typeof summary.fixIterations === "number"
      ? toFiniteNonNegativeNumber(summary.fixIterations, 0)
      : undefined;
  const fixConverged = typeof summary.fixConverged === "boolean" ? summary.fixConverged : undefined;
  const computerUseSafetyConfirmations = toFiniteNonNegativeNumber(
    summary.computerUseSafetyConfirmations,
    0,
  );
  const timing = isRecord(input.timing)
    ? input.timing
    : {
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(0).toISOString(),
        durationMs: 0,
      };
  const diagnostics = isRecord(input.diagnostics) ? input.diagnostics : {};
  const executionFromDiagnostics = isRecord(diagnostics.execution)
    ? diagnostics.execution
    : undefined;
  const executionFromManifest = isRecord(input.execution) ? input.execution : undefined;

  const execution: NonNullable<Manifest["execution"]> = {
    maxParallelTasks:
      typeof executionFromManifest?.maxParallelTasks === "number"
        ? executionFromManifest.maxParallelTasks
        : typeof executionFromDiagnostics?.maxParallelTasks === "number"
          ? executionFromDiagnostics.maxParallelTasks
          : 1,
    stagesMs: isRecord(executionFromManifest?.stagesMs)
      ? (executionFromManifest.stagesMs as Record<string, number>)
      : isRecord(executionFromDiagnostics?.stagesMs)
        ? (executionFromDiagnostics.stagesMs as Record<string, number>)
        : {},
    criticalPath: Array.isArray(executionFromManifest?.criticalPath)
      ? executionFromManifest.criticalPath.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : Array.isArray(executionFromDiagnostics?.criticalPath)
        ? executionFromDiagnostics.criticalPath.filter(
            (item: unknown): item is string => typeof item === "string",
          )
        : [],
  };

  const normalizedChecks = (input.gateResults?.checks ?? []).map(
    (check): Manifest["gateResults"]["checks"][number] => {
      const rec: Record<string, unknown> = isRecord(check) ? check : {};
      const id = typeof rec.id === "string" ? rec.id : "unknown.check";
      const status =
        rec.status === "passed" || rec.status === "failed" || rec.status === "blocked"
          ? rec.status
          : "blocked";

      return {
        id,
        ...(typeof rec.acId === "string" && rec.acId.trim().length > 0
          ? { acId: rec.acId.trim() }
          : {}),
        expected:
          typeof rec.expected === "number" || typeof rec.expected === "string" ? rec.expected : "",
        actual: typeof rec.actual === "number" || typeof rec.actual === "string" ? rec.actual : "",
        severity:
          rec.severity === "BLOCKER" || rec.severity === "MAJOR" || rec.severity === "MINOR"
            ? rec.severity
            : "BLOCKER",
        status,
        reasonCode: normalizeReasonCode(
          id,
          status,
          typeof rec.reasonCode === "string" ? rec.reasonCode : undefined,
        ),
        evidencePath:
          typeof rec.evidencePath === "string" ? rec.evidencePath : "reports/summary.json",
      };
    },
  );

  const normalized: Manifest = {
    schemaVersion: "1.1",
    ...(input.schemaVersion === "1.1"
      ? { schemaCompatibility: "v1.1" as const }
      : { schemaCompatibility: "legacy_v1" as const }),
    runId: input.runId,
    target: input.target,
    profile: input.profile,
    git: input.git,
    timing: {
      startedAt: String(timing.startedAt ?? new Date(0).toISOString()),
      finishedAt: String(timing.finishedAt ?? new Date(0).toISOString()),
      durationMs: Number(timing.durationMs ?? 0),
    },
    execution,
    states,
    evidenceIndex:
      Array.isArray(input.evidenceIndex) && input.evidenceIndex.length > 0
        ? dedupeEvidence(input.evidenceIndex)
        : buildEvidenceIndexFromLegacy(input),
    reports: isRecord(input.reports) ? (input.reports as Record<string, string>) : {},
    stateModel: input.stateModel,
    summary: {
      consoleError: toFiniteNonNegativeNumber(summary.consoleError, 0),
      pageError: toFiniteNonNegativeNumber(summary.pageError, 0),
      http5xx: toFiniteNonNegativeNumber(summary.http5xx, 0),
      aiModel,
      promptVersion,
      cacheStats: {
        hit: cacheHit,
        miss: cacheMiss,
        hits: cacheHit,
        misses: cacheMiss,
        hitRate: cacheHitRate,
      },
      ...(typeof fixIterations === "number" ? { fixIterations } : {}),
      ...(typeof fixConverged === "boolean" ? { fixConverged } : {}),
      computerUseSafetyConfirmations,
      ...(typeof summary.highVuln === "number" ? { highVuln: summary.highVuln } : {}),
      ...(typeof summary.a11ySerious === "number" ? { a11ySerious: summary.a11ySerious } : {}),
      ...(typeof summary.perfLcpMs === "number" ? { perfLcpMs: summary.perfLcpMs } : {}),
      ...(typeof summary.perfFcpMs === "number" ? { perfFcpMs: summary.perfFcpMs } : {}),
      ...(typeof summary.visualDiffPixels === "number"
        ? { visualDiffPixels: summary.visualDiffPixels }
        : {}),
      ...(typeof summary.loadFailedRequests === "number"
        ? { loadFailedRequests: summary.loadFailedRequests }
        : {}),
      ...(typeof summary.loadP95Ms === "number" ? { loadP95Ms: summary.loadP95Ms } : {}),
      ...(typeof summary.loadRps === "number" ? { loadRps: summary.loadRps } : {}),
      ...(typeof summary.dangerousActionHits === "number"
        ? { dangerousActionHits: summary.dangerousActionHits }
        : {}),
      ...(typeof summary.aiReviewFindings === "number"
        ? { aiReviewFindings: summary.aiReviewFindings }
        : {}),
      ...(typeof summary.aiReviewHighOrAbove === "number"
        ? { aiReviewHighOrAbove: summary.aiReviewHighOrAbove }
        : {}),
      ...(typeof summary.blockedByMissingEngineCount === "number"
        ? { blockedByMissingEngineCount: summary.blockedByMissingEngineCount }
        : {}),
      ...(isRecord(summary.engineAvailability)
        ? { engineAvailability: summary.engineAvailability }
        : {}),
    },
    diagnostics: input.diagnostics,
    runEnvironment: input.runEnvironment,
    toolVersions: input.toolVersions,
    ...(input.proof ? { proof: input.proof } : {}),
    gateResults: {
      status:
        input.gateResults?.status === "passed" ||
        input.gateResults?.status === "failed" ||
        input.gateResults?.status === "blocked"
          ? input.gateResults.status
          : "blocked",
      checks: normalizedChecks,
    },
    toolchain: input.toolchain,
  };

  return normalized;
}

function assertManifest(manifest: Manifest): void {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { required?: string[] };
  const requiredKeys = schema.required ?? [];

  for (const key of requiredKeys) {
    if (!(key in manifest)) {
      throw new Error(`Manifest validation failed: missing required key '${key}'`);
    }
  }

  if (manifest.schemaVersion !== "1.1") {
    throw new Error("Manifest validation failed: schemaVersion must be 1.1");
  }

  if (typeof manifest.runId !== "string" || manifest.runId.trim().length === 0) {
    throw new Error("Manifest validation failed: runId must be a non-empty string");
  }

  if (!Array.isArray(manifest.states)) {
    throw new Error("Manifest validation failed: states must be an array");
  }

  if (!Array.isArray(manifest.evidenceIndex)) {
    throw new Error("Manifest validation failed: evidenceIndex must be an array");
  }
  for (const [index, evidence] of manifest.evidenceIndex.entries()) {
    if (!isRecord(evidence)) {
      throw new Error(`Manifest validation failed: evidenceIndex[${index}] must be an object`);
    }
    for (const field of ["id", "source", "kind", "path"] as const) {
      if (typeof evidence[field] !== "string") {
        throw new Error(
          `Manifest validation failed: evidenceIndex[${index}].${field} must be a string`,
        );
      }
    }
    assertRelativeArtifactPath(String(evidence.path), `evidenceIndex[${index}].path`);
  }

  if (!isRecord(manifest.execution)) {
    throw new Error("Manifest validation failed: execution must be an object");
  }
  if (
    typeof manifest.execution.maxParallelTasks !== "number" ||
    manifest.execution.maxParallelTasks < 1
  ) {
    throw new Error("Manifest validation failed: execution.maxParallelTasks must be >= 1");
  }
  if (!isRecord(manifest.execution.stagesMs)) {
    throw new Error("Manifest validation failed: execution.stagesMs must be an object");
  }
  if (!Array.isArray(manifest.execution.criticalPath)) {
    throw new Error("Manifest validation failed: execution.criticalPath must be an array");
  }

  if (!isRecord(manifest.gateResults)) {
    throw new Error("Manifest validation failed: gateResults must be an object");
  }
  if (!Array.isArray(manifest.gateResults.checks)) {
    throw new Error("Manifest validation failed: gateResults.checks must be an array");
  }
  if (!["passed", "failed", "blocked"].includes(manifest.gateResults.status)) {
    throw new Error("Manifest validation failed: gateResults.status must be passed|failed|blocked");
  }

  if (!isRecord(manifest.timing)) {
    throw new Error("Manifest validation failed: timing must be an object");
  }
  if (
    typeof manifest.timing.startedAt !== "string" ||
    typeof manifest.timing.finishedAt !== "string"
  ) {
    throw new Error("Manifest validation failed: timing.startedAt/finishedAt must be strings");
  }
  if (typeof manifest.timing.durationMs !== "number" || Number.isNaN(manifest.timing.durationMs)) {
    throw new Error("Manifest validation failed: timing.durationMs must be a number");
  }

  if (!isRecord(manifest.summary)) {
    throw new Error("Manifest validation failed: summary must be an object");
  }
  for (const field of ["consoleError", "pageError", "http5xx"] as const) {
    if (typeof manifest.summary[field] !== "number") {
      throw new Error(`Manifest validation failed: summary.${field} must be a number`);
    }
  }
  if (
    typeof manifest.summary.aiModel !== "string" ||
    manifest.summary.aiModel.trim().length === 0
  ) {
    throw new Error("Manifest validation failed: summary.aiModel must be a non-empty string");
  }
  if (typeof manifest.summary.promptVersion !== "string") {
    throw new Error("Manifest validation failed: summary.promptVersion must be a string");
  }
  if (!isRecord(manifest.summary.cacheStats)) {
    throw new Error("Manifest validation failed: summary.cacheStats must be an object");
  }
  const cacheStats = manifest.summary.cacheStats;
  const cacheHit = cacheStats.hit ?? cacheStats.hits;
  const cacheMiss = cacheStats.miss ?? cacheStats.misses;
  for (const [field, value] of [
    ["hit", cacheHit],
    ["miss", cacheMiss],
    ["hitRate", cacheStats.hitRate],
  ] as const) {
    if (typeof value !== "number") {
      throw new Error(`Manifest validation failed: summary.cacheStats.${field} must be a number`);
    }
  }
  if (typeof cacheStats.hit !== "undefined" && typeof cacheStats.hit !== "number") {
    throw new Error("Manifest validation failed: summary.cacheStats.hit must be a number");
  }
  if (typeof cacheStats.miss !== "undefined" && typeof cacheStats.miss !== "number") {
    throw new Error("Manifest validation failed: summary.cacheStats.miss must be a number");
  }
  if (typeof cacheStats.hits !== "undefined" && typeof cacheStats.hits !== "number") {
    throw new Error("Manifest validation failed: summary.cacheStats.hits must be a number");
  }
  if (typeof cacheStats.misses !== "undefined" && typeof cacheStats.misses !== "number") {
    throw new Error("Manifest validation failed: summary.cacheStats.misses must be a number");
  }
  if (typeof manifest.summary.computerUseSafetyConfirmations !== "number") {
    throw new Error(
      "Manifest validation failed: summary.computerUseSafetyConfirmations must be a number",
    );
  }
  if (
    typeof manifest.summary.fixIterations !== "undefined" &&
    typeof manifest.summary.fixIterations !== "number"
  ) {
    throw new Error("Manifest validation failed: summary.fixIterations must be a number");
  }
  if (
    typeof manifest.summary.fixConverged !== "undefined" &&
    typeof manifest.summary.fixConverged !== "boolean"
  ) {
    throw new Error("Manifest validation failed: summary.fixConverged must be a boolean");
  }
  if (
    typeof manifest.reports.fixPlan !== "undefined" &&
    typeof manifest.reports.fixPlan !== "string"
  ) {
    throw new Error("Manifest validation failed: reports.fixPlan must be a string");
  }
  if (
    typeof manifest.reports.fixResult !== "undefined" &&
    typeof manifest.reports.fixResult !== "string"
  ) {
    throw new Error("Manifest validation failed: reports.fixResult must be a string");
  }
  if (
    typeof manifest.reports.postFixRegression !== "undefined" &&
    typeof manifest.reports.postFixRegression !== "string"
  ) {
    throw new Error("Manifest validation failed: reports.postFixRegression must be a string");
  }

  for (const [index, check] of manifest.gateResults.checks.entries()) {
    if (!isRecord(check)) {
      throw new Error(`Manifest validation failed: gateResults.checks[${index}] must be an object`);
    }
    for (const requiredField of [
      "id",
      "severity",
      "status",
      "reasonCode",
      "evidencePath",
    ] as const) {
      if (typeof check[requiredField] !== "string") {
        throw new Error(
          `Manifest validation failed: gateResults.checks[${index}].${requiredField} must be a string`,
        );
      }
    }
    if (!["BLOCKER", "MAJOR", "MINOR"].includes(String(check.severity))) {
      throw new Error(`Manifest validation failed: gateResults.checks[${index}].severity invalid`);
    }
    if (!["passed", "failed", "blocked"].includes(String(check.status))) {
      throw new Error(`Manifest validation failed: gateResults.checks[${index}].status invalid`);
    }
    assertRelativeArtifactPath(
      String(check.evidencePath),
      `gateResults.checks[${index}].evidencePath`,
    );
  }
}

export function writeManifest(baseDir: string, manifest: Manifest): string {
  const normalizedManifest = normalizeManifest(manifest as LegacyManifest);
  assertManifest(normalizedManifest);
  const outputPath = resolve(baseDir, "manifest.json");
  writeFileSync(outputPath, JSON.stringify(normalizedManifest, null, 2), "utf8");
  return outputPath;
}

export function readManifest(manifestPathOrRunDir: string): ReadManifestResult {
  const path = manifestPathOrRunDir.endsWith(".json")
    ? resolve(manifestPathOrRunDir)
    : resolve(manifestPathOrRunDir, "manifest.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as LegacyManifest;
  const normalized = normalizeManifest(raw);
  assertManifest(normalized);
  const baseDir = dirname(path);
  const missingEvidence = (normalized.evidenceIndex ?? [])
    .filter((evidence) => !existsSync(resolve(baseDir, evidence.path)))
    .map((evidence) => evidence.path);
  return {
    manifest: normalized,
    schemaCompatibility: normalized.schemaCompatibility === "legacy_v1" ? "legacy_v1" : "v1.1",
    missingEvidence,
  };
}
