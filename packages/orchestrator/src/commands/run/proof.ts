import type { Manifest, ManifestProof } from "../../../../core/src/manifest/types.js";
import type { FailureLocation } from "./reporting.js";

export type ProofRatioSummary = {
  configuredCoverageRatio: number;
  gatePassRatio: number;
  stabilityStatus: ManifestProof["summary"]["stabilityStatus"];
  notApplicable: {
    configuredCoverageRatio: boolean;
    gatePassRatio: boolean;
  };
};
export type ProofBuildInput = {
  runId: string;
  profile: string;
  target: { type: string; name: string };
  timing: { startedAt: string; finishedAt: string; durationMs: number };
  stateModel: NonNullable<Manifest["stateModel"]>;
  states: Manifest["states"];
  summary: Manifest["summary"];
  gateResults: Manifest["gateResults"];
  blockedSteps: string[];
  failureLocations: FailureLocation[];
  criticalPath: string[];
  reportPath: string;
  diagnosticsIndexPath: string;
  runEnvironment: NonNullable<Manifest["runEnvironment"]>;
  toolVersions: NonNullable<Manifest["toolVersions"]>;
};

export type ProofBuildOutput = {
  coverage: Record<string, unknown>;
  stability: Record<string, unknown>;
  gaps: Record<string, unknown>;
  repro: Record<string, unknown>;
  summary: ProofRatioSummary;
};
const WEB_COVERAGE_MODEL_VERSION = "web.routes-stories.v1";
const DESKTOP_COVERAGE_MODEL_VERSION = "desktop.scenarios.v1";
function resolveAcId(
  check: Pick<Manifest["gateResults"]["checks"][number], "id" | "acId">,
): string {
  if (typeof check.acId === "string" && check.acId.trim().length > 0) {
    return check.acId.trim();
  }
  return check.id;
}
function safeRatio(
  numerator: number,
  denominator: number,
): { value: number; notApplicable: boolean } {
  if (denominator <= 0) {
    return { value: 0, notApplicable: true };
  }
  return { value: Number((numerator / denominator).toFixed(4)), notApplicable: false };
}
export function buildProofArtifacts(input: ProofBuildInput): ProofBuildOutput {
  const generatedAt = new Date().toISOString();
  const coverageModelType =
    input.stateModel.modelType ?? (input.target.type === "web" ? "web" : "desktop");
  const coverageModelVersion =
    coverageModelType === "web" ? WEB_COVERAGE_MODEL_VERSION : DESKTOP_COVERAGE_MODEL_VERSION;
  const bySource = {
    routes: input.states.filter((state) => state.source === "routes").length,
    discovery: input.states.filter((state) => state.source === "discovery").length,
    stories: input.states.filter((state) => state.source === "stories").length,
    manual: input.states.filter((state) => state.source === "manual").length,
  };
  const configuredCaptured =
    coverageModelType === "desktop"
      ? (input.stateModel.capturedDesktopScenarios ?? 0)
      : input.stateModel.capturedRoutes + input.stateModel.capturedStories;
  const configuredTotal =
    coverageModelType === "desktop"
      ? (input.stateModel.configuredDesktopScenarios ?? input.stateModel.configuredTotal)
      : input.stateModel.configuredTotal;
  const configuredCoverageRatio = safeRatio(configuredCaptured, configuredTotal);
  const gateTotals = {
    total: input.gateResults.checks.length,
    passed: input.gateResults.checks.filter((check) => check.status === "passed").length,
    failed: input.gateResults.checks.filter((check) => check.status === "failed").length,
    blocked: input.gateResults.checks.filter((check) => check.status === "blocked").length,
  };
  const gatePassRatio = safeRatio(gateTotals.passed, gateTotals.total);
  const errorSignals = {
    consoleError: input.summary.consoleError,
    pageError: input.summary.pageError,
    http5xx: input.summary.http5xx,
    loadFailedRequests: input.summary.loadFailedRequests ?? 0,
    highVuln: input.summary.highVuln ?? 0,
  };
  const hasHardFailure =
    input.gateResults.status !== "passed" || gateTotals.failed > 0 || gateTotals.blocked > 0;
  const hasSoftFailure =
    errorSignals.consoleError > 0 ||
    errorSignals.pageError > 0 ||
    errorSignals.http5xx > 0 ||
    errorSignals.loadFailedRequests > 0 ||
    errorSignals.highVuln > 0;
  const stabilityStatus: ManifestProof["summary"]["stabilityStatus"] = hasHardFailure
    ? "failed"
    : hasSoftFailure
      ? "degraded"
      : "stable";
  const failedChecks = input.gateResults.checks.filter((check) => check.status === "failed");
  const blockedChecks = input.gateResults.checks.filter((check) => check.status === "blocked");
  const configuredStateGap = Math.max(0, configuredTotal - configuredCaptured);
  const coverageStateModel =
    coverageModelType === "desktop"
      ? {
          modelType: "desktop",
          configuredDesktopScenarios: configuredTotal,
          capturedDesktopScenarios: configuredCaptured,
          configuredDesktopScenarioIds: input.stateModel.configuredDesktopScenarioIds ?? [],
          capturedDesktopScenarioIds: input.stateModel.capturedDesktopScenarioIds ?? [],
          capturedDiscovery: input.stateModel.capturedDiscovery,
        }
      : {
          modelType: "web",
          configuredTotal: input.stateModel.configuredTotal,
          configuredCaptured,
          configuredCoverageRatio: configuredCoverageRatio.value,
          notApplicable: {
            configuredCoverageRatio: configuredCoverageRatio.notApplicable,
          },
          capturedDiscovery: input.stateModel.capturedDiscovery,
        };

  return {
    coverage: {
      campaign: {
        runId: input.runId,
        profile: input.profile,
        target: input.target,
        generatedAt,
      },
      coverageModelVersion,
      coverage: {
        stateModel: coverageStateModel,
        states: {
          total: input.states.length,
          bySource,
        },
        gates: {
          ...gateTotals,
          passRatio: gatePassRatio.value,
          notApplicable: {
            passRatio: gatePassRatio.notApplicable,
          },
        },
      },
    },
    stability: {
      campaign: {
        runId: input.runId,
        profile: input.profile,
        target: input.target,
        generatedAt,
      },
      stability: {
        status: stabilityStatus,
        gateStatus: input.gateResults.status,
        errorSignals,
        disruption: {
          blockedSteps: input.blockedSteps.length,
          failedChecks: failedChecks.length,
          blockedChecks: blockedChecks.length,
          failureLocations: input.failureLocations.length,
        },
        criticalPath: input.criticalPath,
      },
    },
    gaps: {
      campaign: {
        runId: input.runId,
        profile: input.profile,
        target: input.target,
        generatedAt,
      },
      gaps: {
        configuredStateGap: {
          configured: configuredTotal,
          captured: configuredCaptured,
          missing: configuredStateGap,
        },
        failedChecks: failedChecks.map((check) => ({
          id: check.id,
          acId: resolveAcId(check),
          severity: check.severity,
          reasonCode: check.reasonCode,
          evidencePath: check.evidencePath,
        })),
        blockedChecks: blockedChecks.map((check) => ({
          id: check.id,
          acId: resolveAcId(check),
          severity: check.severity,
          reasonCode: check.reasonCode,
          evidencePath: check.evidencePath,
        })),
        blockedSteps: input.blockedSteps,
        failureLocations: input.failureLocations,
      },
    },
    repro: {
      campaign: {
        runId: input.runId,
        profile: input.profile,
        target: input.target,
        generatedAt,
      },
      reproducibility: {
        timing: input.timing,
        artifacts: {
          manifest: "manifest.json",
          summary: input.reportPath,
          diagnosticsIndex: input.diagnosticsIndexPath,
        },
        runEnvironment: input.runEnvironment,
        toolVersions: input.toolVersions,
      },
    },
    summary: {
      configuredCoverageRatio: configuredCoverageRatio.value,
      gatePassRatio: gatePassRatio.value,
      stabilityStatus,
      notApplicable: {
        configuredCoverageRatio: configuredCoverageRatio.notApplicable,
        gatePassRatio: gatePassRatio.notApplicable,
      },
    },
  };
}
