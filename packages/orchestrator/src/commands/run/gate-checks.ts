import type { ManifestGateCheck } from "../../../../core/src/manifest/types.js";
import type { A11yConfig, A11yResult } from "../a11y.js";
import type { runExplore } from "../explore.js";
import type { PerfResult } from "../perf.js";
import type { VisualResult } from "../visual.js";
import { MIN_DISCOVERED_STATES } from "./config.js";

export function gateReasonCode(
  checkId: string,
  status: "failed" | "blocked",
  reason: string,
): string {
  return `gate.${checkId.replaceAll(".", "_")}.${status}.${reason}`;
}

export function buildExploreUnderExploredCheck(
  exploreResult:
    | Pick<Awaited<ReturnType<typeof runExplore>>, "discoveredStates" | "reportPath">
    | undefined,
  totalPageErrors: number,
  options?: {
    required?: boolean;
    minDiscoveredStates?: number;
  },
): ManifestGateCheck | undefined {
  if (options?.required === false) {
    return undefined;
  }
  if (!exploreResult) {
    return undefined;
  }
  if (totalPageErrors > 0) {
    return undefined;
  }
  const minDiscoveredStates = Math.max(
    1,
    Math.floor(options?.minDiscoveredStates ?? MIN_DISCOVERED_STATES),
  );
  if (exploreResult.discoveredStates >= minDiscoveredStates) {
    return undefined;
  }
  return {
    id: "explore.under_explored",
    expected: `>=${minDiscoveredStates}`,
    actual: exploreResult.discoveredStates,
    severity: "MAJOR",
    status: "failed",
    reasonCode: gateReasonCode(
      "explore.under_explored",
      "failed",
      "insufficient_discovered_states",
    ),
    evidencePath: exploreResult.reportPath,
  };
}

export function buildPerfEngineReadyCheck(
  perfResult: Pick<PerfResult, "fallbackUsed" | "reportPath" | "metricsCompleteness"> | undefined,
  options?: {
    required?: boolean;
  },
): ManifestGateCheck | undefined {
  if (options?.required === false) {
    return undefined;
  }
  if (!perfResult?.fallbackUsed) {
    return undefined;
  }
  return {
    id: "perf.engine_ready",
    expected: "full_lhci",
    actual: perfResult.metricsCompleteness,
    severity: "BLOCKER",
    status: "failed",
    reasonCode: gateReasonCode("perf.engine_ready", "failed", "fallback_used"),
    evidencePath: perfResult.reportPath,
  };
}

export function buildA11yEngineReadyCheck(
  a11yResult: Pick<A11yResult, "fallbackUsed" | "reportPath"> | undefined,
  expectedEngine: A11yConfig["engine"] | undefined,
): ManifestGateCheck | undefined {
  if ((expectedEngine ?? "axe") !== "axe") {
    return undefined;
  }
  if (!a11yResult?.fallbackUsed) {
    return undefined;
  }
  return {
    id: "a11y.engine_ready",
    expected: "axe",
    actual: "fallback_used",
    severity: "BLOCKER",
    status: "failed",
    reasonCode: gateReasonCode("a11y.engine_ready", "failed", "fallback_used"),
    evidencePath: a11yResult.reportPath,
  };
}

export function buildVisualBaselineReadyCheck(
  visualResult: Pick<VisualResult, "baselineCreated" | "mode" | "reportPath"> | undefined,
  effectiveMode?: "diff" | "update",
  options?: {
    required?: boolean;
  },
): ManifestGateCheck | undefined {
  if (options?.required === false) {
    return undefined;
  }
  if (!visualResult) {
    return undefined;
  }
  const mode = effectiveMode ?? visualResult.mode;
  if (mode !== "diff" || !visualResult.baselineCreated) {
    return undefined;
  }
  return {
    id: "visual.baseline_ready",
    expected: "existing_baseline",
    actual: "baseline_created",
    severity: "BLOCKER",
    status: "failed",
    reasonCode: gateReasonCode("visual.baseline_ready", "failed", "baseline_created"),
    evidencePath: visualResult.reportPath,
  };
}
