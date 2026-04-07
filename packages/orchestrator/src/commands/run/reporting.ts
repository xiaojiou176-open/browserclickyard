import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest } from "../../../../core/src/manifest/types.js";

export type DiagnosticTruncation = {
  originalCount: number;
  uniqueCount: number;
  keptCount: number;
  truncated: boolean;
};

export type NormalizedList = {
  items: string[];
  truncation: DiagnosticTruncation;
};

export type NormalizedDiagnosticsSection = {
  consoleErrors: string[];
  pageErrors: string[];
  http5xxUrls: string[];
  truncation: {
    consoleErrors: DiagnosticTruncation;
    pageErrors: DiagnosticTruncation;
    http5xxUrls: DiagnosticTruncation;
  };
};

export type DiagnosticsIndex = {
  runId: string;
  status: "passed" | "failed" | "blocked";
  profile: string;
  target: { type: string; name: string };
  reports: Record<string, string>;
  diagnostics: {
    capture: { consoleErrors: number; pageErrors: number; http5xxUrls: number };
    explore: { consoleErrors: number; pageErrors: number; http5xxUrls: number };
    chaos: { consoleErrors: number; pageErrors: number; http5xxUrls: number };
    aggregateHttp5xx: number;
    blockedSteps: string[];
    blockedStepDetails: BlockedStepDetail[];
    failureLocations: FailureLocation[];
    execution: {
      maxParallelTasks: number;
      stagesMs: Record<string, number>;
      criticalPath: string[];
    };
  };
};

export type BlockedStepDetail = {
  stepId: string;
  reasonCode: string;
  detail: string;
  artifactPath: string;
};

export type FailureLocation = {
  acId: string;
  checkId: string;
  status: "failed" | "blocked";
  reasonCode?: string;
  stepId: string;
  artifactPath: string;
};
function inferStepIdForCheck(checkId: string): string {
  if (
    checkId.startsWith("console.") ||
    checkId.startsWith("page.") ||
    checkId.startsWith("http.")
  ) {
    return "capture";
  }
  if (checkId.startsWith("a11y.")) {
    return "a11y";
  }
  if (checkId.startsWith("explore.")) {
    return "explore";
  }
  if (checkId.startsWith("perf.")) {
    return "perf";
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
  if (checkId.startsWith("desktop.readiness")) {
    return "desktop_readiness";
  }
  if (checkId.startsWith("desktop.smoke")) {
    return "desktop_smoke";
  }
  if (checkId.startsWith("desktop.e2e")) {
    return "desktop_e2e";
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
  return "unknown";
}

export function resolveAcId(
  check: Pick<Manifest["gateResults"]["checks"][number], "id" | "acId">,
): string {
  if (typeof check.acId === "string" && check.acId.trim().length > 0) {
    return check.acId.trim();
  }
  return check.id;
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
      acId: resolveAcId(check),
      checkId: check.id,
      status: check.status,
      reasonCode: check.reasonCode,
      stepId: inferStepIdForCheck(check.id),
      artifactPath: check.evidencePath,
    }));
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

export function writeDiagnosticsIndex(baseDir: string, payload: DiagnosticsIndex): string {
  const outputPath = resolve(baseDir, "reports/diagnostics.index.json");
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  return "reports/diagnostics.index.json";
}
