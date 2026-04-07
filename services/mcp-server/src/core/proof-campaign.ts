// @ts-nocheck
// 
import { existsSync, mkdirSync } from "node:fs";
import {
  type JsonObject,
  latestProofCampaignId,
  listProofCampaignIds,
  proofCampaignsRoot,
  readJson,
  safeResolveUnder,
  writeJson,
} from "./io.js";
import { buildReportBundle, readRunOverview } from "./run-artifacts.js";

const PROOF_POLICY_MODE = "strict" as const;
const PROOF_REASON_INVALID_RUN = "INVALID_RUN_PRESENT";
const PROOF_REASON_CRITICAL_EVIDENCE_MISSING = "CRITICAL_EVIDENCE_MISSING";
const PROOF_CRITICAL_EVIDENCE_KEYS = ["gate", "a11y", "perf", "visual", "security"] as const;
const STRICT_GATE_SUCCESS_STATES = new Set(["success", "passed"]);

export function buildRunProofSnapshot(runId: string): JsonObject {
  try {
    const overview = readRunOverview(runId);
    const bundle = buildReportBundle(runId, { proof: getProofContextForRun(runId) }) as {
      summarySlices?: JsonObject;
      reportFiles?: JsonObject;
      failedChecks?: Array<{ id?: string }>;
      paths?: { manifest?: string | null; summary?: string | null };
    };
    const summarySlices = (bundle.summarySlices ?? {}) as JsonObject;
    const reportFiles = (bundle.reportFiles ?? {}) as JsonObject;
    const gateEvidencePresent =
      overview.gateStatus !== null ||
      (Array.isArray(bundle.failedChecks) && bundle.failedChecks.length > 0);
    const evidence = {
      gate: gateEvidencePresent,
      a11y: summarySlices.a11y !== null && summarySlices.a11y !== undefined,
      perf: summarySlices.perf !== null && summarySlices.perf !== undefined,
      visual: summarySlices.visual !== null && summarySlices.visual !== undefined,
      security: summarySlices.security !== null && summarySlices.security !== undefined,
      load: summarySlices.load !== null && summarySlices.load !== undefined,
      explore: reportFiles.explore !== null && reportFiles.explore !== undefined,
      chaos: reportFiles.chaos !== null && reportFiles.chaos !== undefined,
      desktopReadiness:
        reportFiles.desktopReadiness !== null && reportFiles.desktopReadiness !== undefined,
      desktopSmoke: reportFiles.desktopSmoke !== null && reportFiles.desktopSmoke !== undefined,
      desktopE2E: reportFiles.desktopE2E !== null && reportFiles.desktopE2E !== undefined,
      desktopSoak: reportFiles.desktopSoak !== null && reportFiles.desktopSoak !== undefined,
    };
    const evidenceEntries = Object.values(evidence);
    const evidencePresent = evidenceEntries.filter(Boolean).length;
    const failedChecks = (bundle.failedChecks ?? []) as Array<{ id?: string }>;
    return {
      runId,
      ok: true,
      gateStatus: overview.gateStatus,
      failedCheckCount: overview.failedChecks.length,
      failedChecks: failedChecks.map((it) => it.id ?? "unknown"),
      evidence,
      evidenceCoverage: {
        present: evidencePresent,
        total: evidenceEntries.length,
        ratio: Number((evidencePresent / evidenceEntries.length).toFixed(4)),
      },
    };
  } catch (error) {
    return {
      runId,
      ok: false,
      detail: (error as Error).message,
    };
  }
}

function proofCampaignStats(runReports: JsonObject[]): JsonObject {
  const valid = runReports.filter((it) => it.ok === true);
  const passed = valid.filter((it) => it.gateStatus === "passed");
  const ratios = valid
    .map((it) => (it.evidenceCoverage as JsonObject | undefined)?.ratio)
    .filter((v): v is number => typeof v === "number");
  return {
    runCount: runReports.length,
    validRunCount: valid.length,
    gatePassedCount: passed.length,
    gatePassRate: valid.length > 0 ? Number((passed.length / valid.length).toFixed(4)) : 0,
    avgEvidenceCoverage:
      ratios.length > 0
        ? Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4))
        : 0,
  };
}

function proofFailedCheckHistogram(runReports: JsonObject[]): JsonObject {
  const counts: Record<string, number> = {};
  for (const report of runReports) {
    const list = report.failedChecks;
    if (!Array.isArray(list)) {
      continue;
    }
    for (const check of list) {
      if (typeof check !== "string") {
        continue;
      }
      counts[check] = (counts[check] ?? 0) + 1;
    }
  }
  return counts;
}

function evaluateStrictProofCampaign(runReports: JsonObject[]): {
  ok: boolean;
  reasonCodes: string[];
  invalidRuns: string[];
  criticalEvidenceMissing: Array<{ runId: string; missing: string[] }>;
} {
  const invalidRuns = new Set(
    runReports
      .filter((report) => report.ok !== true)
      .map((report) => {
        const runId = report.runId;
        return typeof runId === "string" && runId.trim() ? runId : "unknown";
      }),
  );

  const criticalEvidenceByRun = runReports
    .map((report) => {
      const runId =
        typeof report.runId === "string" && report.runId.trim() ? report.runId : "unknown";
      const gateStatus =
        typeof report.gateStatus === "string" ? report.gateStatus.trim().toLowerCase() : "";
      if (report.ok !== true) {
        return {
          runId,
          gateStatus,
          missing: [...PROOF_CRITICAL_EVIDENCE_KEYS],
        };
      }
      const evidence = (report.evidence ?? {}) as Record<string, unknown>;
      const missing = PROOF_CRITICAL_EVIDENCE_KEYS.filter((key) => evidence[key] !== true);
      return { runId, gateStatus, missing };
    })
    .filter((entry) => entry.missing.length > 0);

  for (const entry of criticalEvidenceByRun) {
    if (STRICT_GATE_SUCCESS_STATES.has(entry.gateStatus)) {
      invalidRuns.add(entry.runId);
    }
  }

  const criticalEvidenceMissing = criticalEvidenceByRun.map((entry) => ({
    runId: entry.runId,
    missing: entry.missing,
  }));

  const reasonCodes = new Set<string>();
  if (invalidRuns.size > 0) {
    reasonCodes.add(PROOF_REASON_INVALID_RUN);
  }
  if (criticalEvidenceMissing.length > 0) {
    reasonCodes.add(PROOF_REASON_CRITICAL_EVIDENCE_MISSING);
  }

  return {
    ok: reasonCodes.size === 0,
    reasonCodes: Array.from(reasonCodes),
    invalidRuns: Array.from(invalidRuns),
    criticalEvidenceMissing,
  };
}

export function buildProofCampaignReport(input: {
  campaignId: string;
  model: string;
  runIds: string[];
  name?: string;
  description?: string;
}): JsonObject {
  const generatedAt = new Date().toISOString();
  const dedupedRunIds = Array.from(new Set(input.runIds.map((id) => id.trim()).filter(Boolean)));
  const runReports = dedupedRunIds.map((runId) => buildRunProofSnapshot(runId));
  const stats = proofCampaignStats(runReports);
  const failedCheckHistogram = proofFailedCheckHistogram(runReports);
  const policy = evaluateStrictProofCampaign(runReports);
  return {
    campaignId: input.campaignId,
    model: input.model,
    name: input.name ?? null,
    description: input.description ?? null,
    generatedAt,
    runIds: dedupedRunIds,
    ok: policy.ok,
    policyMode: PROOF_POLICY_MODE,
    reasonCodes: policy.reasonCodes,
    policy,
    stats,
    failedCheckHistogram,
    runReports,
  };
}

export function writeProofCampaignArtifacts(report: JsonObject): {
  campaignPath: string;
  reportPath: string;
  indexPath: string;
} {
  const campaignId = String(report.campaignId ?? "").trim();
  if (!campaignId) {
    throw new Error("campaignId missing");
  }
  const campaignPath = safeResolveUnder(proofCampaignsRoot(), campaignId);
  mkdirSync(campaignPath, { recursive: true });
  const reportPath = safeResolveUnder(campaignPath, "campaign.report.json");
  const indexPath = safeResolveUnder(campaignPath, "campaign.index.json");
  writeJson(reportPath, report);
  writeJson(indexPath, {
    campaignId,
    model: report.model ?? null,
    generatedAt: report.generatedAt ?? null,
    ok: report.ok ?? null,
    policyMode: report.policyMode ?? null,
    reasonCodes: report.reasonCodes ?? [],
    runIds: report.runIds ?? [],
    stats: report.stats ?? {},
  });
  return { campaignPath, reportPath, indexPath };
}

export function pickProofCampaignIdOrLatest(input?: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }
  const latest = latestProofCampaignId();
  if (!latest) {
    throw new Error("no proof campaigns found");
  }
  return latest;
}

export function readProofCampaignReport(campaignId: string): JsonObject {
  const reportPath = safeResolveUnder(proofCampaignsRoot(), campaignId, "campaign.report.json");
  return readJson(reportPath) as JsonObject;
}

export function readProofCampaignIndex(campaignId: string): JsonObject {
  const root = proofCampaignsRoot();
  const indexPath = safeResolveUnder(root, campaignId, "campaign.index.json");
  if (existsSync(indexPath)) {
    return readJson(indexPath) as JsonObject;
  }
  const report = readProofCampaignReport(campaignId);
  return {
    campaignId,
    model: report.model ?? null,
    generatedAt: report.generatedAt ?? null,
    runIds: report.runIds ?? [],
    stats: report.stats ?? {},
  };
}

export function proofCampaignSummaryDiff(a: JsonObject, b: JsonObject): JsonObject {
  const statsA = (a.stats ?? {}) as JsonObject;
  const statsB = (b.stats ?? {}) as JsonObject;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const failedA = (a.failedCheckHistogram ?? {}) as Record<string, number>;
  const failedB = (b.failedCheckHistogram ?? {}) as Record<string, number>;
  const keys = new Set([...Object.keys(failedA), ...Object.keys(failedB)]);
  const failedCheckDelta: Record<string, number> = {};
  for (const key of keys) {
    failedCheckDelta[key] = (failedB[key] ?? 0) - (failedA[key] ?? 0);
  }
  const runReportsA = new Map(
    (
      ((a.runReports as unknown[]) ?? []) as Array<{
        runId?: string;
        gateStatus?: string;
        failedCheckCount?: number;
      }>
    ).map((it) => [it.runId ?? "", it]),
  );
  const runReportsB = new Map(
    (
      ((b.runReports as unknown[]) ?? []) as Array<{
        runId?: string;
        gateStatus?: string;
        failedCheckCount?: number;
      }>
    ).map((it) => [it.runId ?? "", it]),
  );
  const commonRunIds = Array.from(new Set([...runReportsA.keys(), ...runReportsB.keys()])).filter(
    (it) => runReportsA.has(it) && runReportsB.has(it),
  );
  const runChanges = commonRunIds.map((runId) => {
    const ra = runReportsA.get(runId) ?? {};
    const rb = runReportsB.get(runId) ?? {};
    return {
      runId,
      gateStatus: { from: ra.gateStatus ?? null, to: rb.gateStatus ?? null },
      failedCheckCount: {
        from: ra.failedCheckCount ?? 0,
        to: rb.failedCheckCount ?? 0,
        delta: (rb.failedCheckCount ?? 0) - (ra.failedCheckCount ?? 0),
      },
    };
  });
  return {
    campaignA: a.campaignId ?? null,
    campaignB: b.campaignId ?? null,
    generatedAt: new Date().toISOString(),
    delta: {
      runCount: num(statsB.runCount) - num(statsA.runCount),
      validRunCount: num(statsB.validRunCount) - num(statsA.validRunCount),
      gatePassedCount: num(statsB.gatePassedCount) - num(statsA.gatePassedCount),
      gatePassRate: Number((num(statsB.gatePassRate) - num(statsA.gatePassRate)).toFixed(4)),
      avgEvidenceCoverage: Number(
        (num(statsB.avgEvidenceCoverage) - num(statsA.avgEvidenceCoverage)).toFixed(4),
      ),
    },
    failedCheckDelta,
    runChanges,
  };
}

export function writeProofCampaignDiff(diff: JsonObject): string {
  const a = String(diff.campaignA ?? "unknown-a");
  const b = String(diff.campaignB ?? "unknown-b");
  const path = safeResolveUnder(proofCampaignsRoot(), "_diffs", `${a}__vs__${b}.json`);
  writeJson(path, diff);
  return path;
}

export function findProofCampaignsForRun(runId: string, limit = 20): string[] {
  const matched: string[] = [];
  for (const campaignId of listProofCampaignIds(limit)) {
    try {
      const index = readProofCampaignIndex(campaignId);
      const runIds = Array.isArray(index.runIds) ? index.runIds : [];
      if (runIds.includes(runId)) {
        matched.push(campaignId);
      }
    } catch {
      // skip malformed campaign artifacts
    }
  }
  return matched;
}

export function getProofContextForRun(runId: string): {
  latestCampaignId: string | null;
  campaignsForRun: string[];
  latestRunProof: unknown | null;
} {
  const proofCampaigns = findProofCampaignsForRun(runId, 50);
  const latestCampaignId = latestProofCampaignId() ?? null;
  const latestRunProof =
    proofCampaigns.length > 0
      ? (() => {
          try {
            const report = readProofCampaignReport(proofCampaigns[0]);
            const runReports = Array.isArray(report.runReports)
              ? (report.runReports as Array<{ runId?: string }>)
              : [];
            return runReports.find((it) => it.runId === runId) ?? null;
          } catch {
            return null;
          }
        })()
      : null;

  return {
    latestCampaignId,
    campaignsForRun: proofCampaigns,
    latestRunProof,
  };
}

export { PROOF_POLICY_MODE };
