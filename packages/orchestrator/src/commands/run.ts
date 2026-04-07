import {
  assertBaseUrlAllowed as assertBaseUrlAllowedImpl,
  buildStateModelSummary,
} from "./run/config.js";
import {
  loadProfileConfig as loadProfileConfigImpl,
  loadTargetConfig as loadTargetConfigImpl,
} from "./run/run-config.js";
import type {
  BaseUrlPolicyResult as LegacyBaseUrlPolicyResult,
  ProfileConfig as LegacyProfileConfig,
  TargetConfig as LegacyTargetConfig,
} from "./run/run-types.js";

export function loadProfileConfig(profileName: string): LegacyProfileConfig {
  return loadProfileConfigImpl(profileName) as unknown as LegacyProfileConfig;
}

export function loadTargetConfig(targetName: string): LegacyTargetConfig {
  return loadTargetConfigImpl(targetName) as unknown as LegacyTargetConfig;
}

export function assertBaseUrlAllowed(
  target: LegacyTargetConfig,
  baseUrl: string,
  allowAllUrls = false,
): LegacyBaseUrlPolicyResult {
  return assertBaseUrlAllowedImpl(
    target as unknown as Parameters<typeof assertBaseUrlAllowedImpl>[0],
    baseUrl,
    allowAllUrls,
  ) as unknown as LegacyBaseUrlPolicyResult;
}

export { runWithConcurrencyLimit } from "./run/concurrency.js";
export {
  buildA11yEngineReadyCheck,
  buildPerfEngineReadyCheck,
  buildVisualBaselineReadyCheck,
} from "./run/gate-checks.js";
export { buildProofArtifacts } from "./run/proof.js";
export {
  resolveA11yConfig,
  resolveAiReviewConfig,
  resolveChaosConfig,
  resolveDesktopSoakConfig,
  resolveDiagnosticsConfig,
  resolveExploreConfig,
  resolveLoadConfig,
  resolvePerfConfig,
  resolveSecurityConfig,
  resolveVisualConfig,
} from "./run/run-resolve.js";
export { buildStateModelSummary };
export { runProfile } from "./run/run-pipeline.js";
