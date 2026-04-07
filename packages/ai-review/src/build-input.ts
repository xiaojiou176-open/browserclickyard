import type { Manifest } from "../../core/src/manifest/types.js";

export type AiReviewSeverity = "critical" | "high" | "medium" | "low";

export type AiReviewCandidate = {
  id: string;
  source: "gate" | "report" | "state";
  kind: string;
  path: string;
  priority: number;
};

export type AiReviewInput = {
  runId: string;
  profile: string;
  target: {
    type: string;
    name: string;
  };
  gateStatus: "passed" | "failed" | "blocked";
  summary: Manifest["summary"];
  reports: Record<string, string>;
  failedChecks: Manifest["gateResults"]["checks"];
  candidates: AiReviewCandidate[];
};

export type BuildAiReviewInputOptions = {
  maxArtifacts: number;
};

function priorityForCandidate(source: AiReviewCandidate["source"], kind: string): number {
  if (source === "gate") {
    return 100;
  }
  if (source === "report" && kind === "report") {
    return 90;
  }
  if (source === "state" && kind === "video") {
    return 80;
  }
  if (source === "state" && kind === "screenshot") {
    return 70;
  }
  if (source === "state" && kind === "dom") {
    return 65;
  }
  if (source === "state") {
    return 60;
  }
  return 50;
}

function isPriorityVideoEvidencePath(path: string): boolean {
  return /(^|\/)(critical|key|primary|failure|gate)(\/|$)/i.test(path);
}

function pickReportEntries(manifest: Manifest): Array<[string, string]> {
  const preferred = ["aiReview", "visual", "a11y", "perf", "security", "load", "report"];
  const entries: Array<[string, string]> = [];
  for (const key of preferred) {
    const value = manifest.reports?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      entries.push([key, value]);
    }
  }
  return entries;
}

export function buildAiReviewInput(
  manifest: Manifest,
  options: BuildAiReviewInputOptions,
): AiReviewInput {
  const maxArtifacts = Math.max(1, Math.min(500, Math.floor(options.maxArtifacts)));
  const failedChecks = (manifest.gateResults?.checks ?? []).filter(
    (check) => check.status === "failed" || check.status === "blocked",
  );

  const candidates: AiReviewCandidate[] = [];
  const seen = new Set<string>();

  for (const check of failedChecks) {
    const path = String(check.evidencePath ?? "").trim();
    if (!path) {
      continue;
    }
    const id = `gate.${check.id}`;
    const dedupeKey = `gate:${path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    candidates.push({
      id,
      source: "gate",
      kind: "evidence",
      path,
      priority: priorityForCandidate("gate", "evidence"),
    });
  }

  for (const [name, path] of pickReportEntries(manifest)) {
    const dedupeKey = `report:${path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    candidates.push({
      id: `report.${name}`,
      source: "report",
      kind: "report",
      path,
      priority: priorityForCandidate("report", "report"),
    });
  }

  for (const item of manifest.evidenceIndex ?? []) {
    if (item.source !== "state") {
      continue;
    }
    if (item.kind !== "screenshot" && item.kind !== "dom" && item.kind !== "video") {
      continue;
    }
    const path = String(item.path ?? "").trim();
    if (!path) {
      continue;
    }
    const dedupeKey = `${item.source}:${path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const basePriority = priorityForCandidate("state", item.kind);
    const boostedPriority =
      item.kind === "video" && isPriorityVideoEvidencePath(path) ? basePriority + 5 : basePriority;
    candidates.push({
      id: item.id,
      source: "state",
      kind: item.kind,
      path,
      priority: boostedPriority,
    });
  }

  candidates.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.id.localeCompare(right.id);
  });

  return {
    runId: manifest.runId,
    profile: manifest.profile,
    target: {
      type: String(manifest.target?.type ?? "unknown"),
      name: String(manifest.target?.name ?? "unknown"),
    },
    gateStatus: manifest.gateResults?.status ?? "blocked",
    summary: manifest.summary,
    reports: manifest.reports,
    failedChecks,
    candidates: candidates.slice(0, maxArtifacts),
  };
}
