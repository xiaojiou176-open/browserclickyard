import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROFILE_A11Y_ALLOWED_KEYS,
  PROFILE_AI_REVIEW_ALLOWED_KEYS,
  PROFILE_ALLOWED_KEYS,
  PROFILE_CHAOS_ALLOWED_KEYS,
  PROFILE_CHAOS_RATIO_ALLOWED_KEYS,
  PROFILE_COMPUTER_USE_ALLOWED_KEYS,
  PROFILE_DESKTOP_E2E_ALLOWED_KEYS,
  PROFILE_DESKTOP_SOAK_ALLOWED_KEYS,
  PROFILE_DESKTOP_SOAK_GATES_ALLOWED_KEYS,
  PROFILE_DETERMINISM_ALLOWED_KEYS,
  PROFILE_DIAGNOSTICS_ALLOWED_KEYS,
  PROFILE_ENGINE_POLICY_ALLOWED_KEYS,
  PROFILE_EXPLORE_ALLOWED_KEYS,
  PROFILE_GATES_ALLOWED_KEYS,
  PROFILE_LOAD_ALLOWED_KEYS,
  PROFILE_PERF_ALLOWED_KEYS,
  PROFILE_SECURITY_ALLOWED_KEYS,
  PROFILE_TESTS_ALLOWED_KEYS,
  PROFILE_VISUAL_ALLOWED_KEYS,
  TARGET_A11Y_ALLOWED_KEYS,
  TARGET_AI_REVIEW_ALLOWED_KEYS,
  TARGET_ALLOWED_KEYS,
  TARGET_CHAOS_ALLOWED_KEYS,
  TARGET_CHAOS_RATIO_ALLOWED_KEYS,
  TARGET_COMPUTER_USE_ALLOWED_KEYS,
  TARGET_DESKTOP_SOAK_ALLOWED_KEYS,
  TARGET_DESKTOP_SOAK_GATES_ALLOWED_KEYS,
  TARGET_DIAGNOSTICS_ALLOWED_KEYS,
  TARGET_EXPLORE_ALLOWED_KEYS,
  TARGET_HEALTHCHECK_ALLOWED_KEYS,
  TARGET_LOAD_ALLOWED_KEYS,
  TARGET_PERF_ALLOWED_KEYS,
  TARGET_SCOPE_ALLOWED_KEYS,
  TARGET_SECURITY_ALLOWED_KEYS,
  TARGET_START_ALLOWED_KEYS,
  TARGET_VISUAL_ALLOWED_KEYS,
} from "./run-schema.js";
import type { ProfileConfig, TargetConfig } from "./run-types.js";

const FALLBACK_PROFILE_NAMES = [
  "pr",
  "nightly",
  "tauri.smoke",
  "swift.smoke",
  "tauri.soak",
  "swift.soak",
  "tauri.regression",
  "swift.regression",
];

function loadRegisteredProfileNames(): Set<string> {
  const registryDir = "profiles";
  const absoluteRegistryDir = resolve(process.cwd(), registryDir);
  if (!existsSync(absoluteRegistryDir)) {
    return new Set(FALLBACK_PROFILE_NAMES);
  }
  try {
    const discovered = readdirSync(absoluteRegistryDir)
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .map((name) => name.replace(/\.(yaml|yml)$/u, ""))
      .filter((name) => name.length > 0);
    if (discovered.length === 0) {
      return new Set(FALLBACK_PROFILE_NAMES);
    }
    return new Set([...discovered, ...FALLBACK_PROFILE_NAMES]);
  } catch {
    return new Set(FALLBACK_PROFILE_NAMES);
  }
}

const ALLOWED_PROFILE_NAMES = loadRegisteredProfileNames();

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid ${label}: unknown key '${key}'`);
    }
  }
}

function assertNumberInRange(value: unknown, label: string, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}: expected number in [${min}, ${max}]`);
  }
}

function assertIntegerInRange(value: unknown, label: string, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}: expected integer in [${min}, ${max}]`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${label}: expected string[]`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}: expected boolean`);
  }
}

function isAllowedProfileName(value: string): boolean {
  return ALLOWED_PROFILE_NAMES.has(value);
}

export function validateProfileConfig(raw: ProfileConfig, name: string): ProfileConfig {
  const profile = assertObject(raw, `profile '${name}'`);
  assertNoUnknownKeys(profile, PROFILE_ALLOWED_KEYS, `profile '${name}'`);
  if (typeof profile.name !== "string" || profile.name.trim().length === 0) {
    throw new Error(`Invalid profile '${name}': 'name' must be non-empty string`);
  }
  if (!Array.isArray(profile.steps) || profile.steps.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid profile '${name}': 'steps' must be string[]`);
  }
  if (!isAllowedProfileName(profile.name)) {
    throw new Error(`Invalid profile '${name}': unsupported name '${profile.name}'`);
  }
  assertNumberInRange(profile.geminiAccuracyMin, "geminiAccuracyMin", 0, 1);
  assertNumberInRange(profile.geminiParallelConsistencyMin, "geminiParallelConsistencyMin", 0, 1);
  assertIntegerInRange(profile.geminiSampleSizeMin, "geminiSampleSizeMin", 1, 1_000_000);
  if (
    (profile.geminiAccuracyMin !== undefined ||
      profile.geminiParallelConsistencyMin !== undefined) &&
    profile.geminiSampleSizeMin === undefined
  ) {
    throw new Error(
      `Invalid profile '${name}': geminiSampleSizeMin is required when geminiAccuracyMin or geminiParallelConsistencyMin is configured`,
    );
  }
  if (profile.gates !== undefined) {
    const gates = assertObject(profile.gates, `profile '${name}'.gates`);
    assertNoUnknownKeys(gates, PROFILE_GATES_ALLOWED_KEYS, `profile '${name}'.gates`);
    assertIntegerInRange(gates.consoleErrorMax, "gates.consoleErrorMax", 0, 1_000_000);
    assertIntegerInRange(gates.pageErrorMax, "gates.pageErrorMax", 0, 1_000_000);
    assertIntegerInRange(gates.http5xxMax, "gates.http5xxMax", 0, 1_000_000);
    assertIntegerInRange(
      gates.dangerousActionHitsMax,
      "gates.dangerousActionHitsMax",
      0,
      1_000_000,
    );
    assertIntegerInRange(gates.securityHighVulnMax, "gates.securityHighVulnMax", 0, 1_000_000);
    assertIntegerInRange(gates.a11ySeriousMax, "gates.a11ySeriousMax", 0, 1_000_000);
    assertNumberInRange(gates.perfLcpMsMax, "gates.perfLcpMsMax", 0, 1_000_000);
    assertNumberInRange(gates.perfFcpMsMax, "gates.perfFcpMsMax", 0, 1_000_000);
    assertNumberInRange(gates.visualDiffPixelsMax, "gates.visualDiffPixelsMax", 0, 1_000_000_000);
    assertNumberInRange(
      gates.loadFailedRequestsMax,
      "gates.loadFailedRequestsMax",
      0,
      1_000_000_000,
    );
    assertNumberInRange(gates.loadP95MsMax, "gates.loadP95MsMax", 0, 1_000_000);
    assertNumberInRange(gates.loadRpsMin, "gates.loadRpsMin", 0, 1_000_000);
    assertNumberInRange(gates.flakeRateMax, "gates.flakeRateMax", 0, 1);
    if (gates.contractStatus !== undefined && gates.contractStatus !== "passed") {
      throw new Error(`Invalid profile '${name}': gates.contractStatus must be 'passed'`);
    }
  }
  if (profile.tests !== undefined) {
    const tests = assertObject(profile.tests, `profile '${name}'.tests`);
    assertNoUnknownKeys(tests, PROFILE_TESTS_ALLOWED_KEYS, `profile '${name}'.tests`);
    if (
      tests.e2eSuite !== undefined &&
      !["smoke", "regression", "full"].includes(String(tests.e2eSuite))
    ) {
      throw new Error(`Invalid profile '${name}': tests.e2eSuite must be smoke|regression|full`);
    }
  }
  if (profile.computerUse !== undefined) {
    const computerUse = assertObject(profile.computerUse, `profile '${name}'.computerUse`);
    assertNoUnknownKeys(
      computerUse,
      PROFILE_COMPUTER_USE_ALLOWED_KEYS,
      `profile '${name}'.computerUse`,
    );
    assertBoolean(computerUse.enabled, "computerUse.enabled");
    if (computerUse.task !== undefined && typeof computerUse.task !== "string") {
      throw new Error(`Invalid profile '${name}': computerUse.task must be string`);
    }
    assertIntegerInRange(computerUse.maxSteps, "computerUse.maxSteps", 1, 10_000);
    assertBoolean(computerUse.speedMode, "computerUse.speedMode");
  }
  if (profile.explore !== undefined) {
    const explore = assertObject(profile.explore, `profile '${name}'.explore`);
    assertNoUnknownKeys(explore, PROFILE_EXPLORE_ALLOWED_KEYS, `profile '${name}'.explore`);
    assertIntegerInRange(explore.budgetSeconds, "explore.budgetSeconds", 1, 86_400);
    assertIntegerInRange(explore.maxDepth, "explore.maxDepth", 1, 32);
    assertIntegerInRange(explore.maxStates, "explore.maxStates", 1, 10_000);
    assertIntegerInRange(explore.seed, "explore.seed", 0, Number.MAX_SAFE_INTEGER);
    assertStringArray(explore.denylist, "explore.denylist");
    if (explore.engine !== undefined && !["builtin", "crawlee"].includes(String(explore.engine))) {
      throw new Error(`Invalid profile '${name}': explore.engine must be builtin|crawlee`);
    }
  }
  if (profile.chaos !== undefined) {
    const chaos = assertObject(profile.chaos, `profile '${name}'.chaos`);
    assertNoUnknownKeys(chaos, PROFILE_CHAOS_ALLOWED_KEYS, `profile '${name}'.chaos`);
    assertIntegerInRange(chaos.seed, "chaos.seed", 0, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange(chaos.budgetSeconds, "chaos.budgetSeconds", 1, 86_400);
    if (chaos.eventRatio !== undefined) {
      const ratio = assertObject(chaos.eventRatio, `profile '${name}'.chaos.eventRatio`);
      assertNoUnknownKeys(
        ratio,
        PROFILE_CHAOS_RATIO_ALLOWED_KEYS,
        `profile '${name}'.chaos.eventRatio`,
      );
      assertNumberInRange(ratio.click, "chaos.eventRatio.click", 0, 100);
      assertNumberInRange(ratio.input, "chaos.eventRatio.input", 0, 100);
      assertNumberInRange(ratio.scroll, "chaos.eventRatio.scroll", 0, 100);
      assertNumberInRange(ratio.keyboard, "chaos.eventRatio.keyboard", 0, 100);
    }
  }
  if (profile.determinism !== undefined) {
    const determinism = assertObject(profile.determinism, `profile '${name}'.determinism`);
    assertNoUnknownKeys(
      determinism,
      PROFILE_DETERMINISM_ALLOWED_KEYS,
      `profile '${name}'.determinism`,
    );
    if (determinism.timezone !== undefined && typeof determinism.timezone !== "string") {
      throw new Error(`Invalid profile '${name}': determinism.timezone must be string`);
    }
    if (determinism.locale !== undefined && typeof determinism.locale !== "string") {
      throw new Error(`Invalid profile '${name}': determinism.locale must be string`);
    }
    assertIntegerInRange(determinism.seed, "determinism.seed", 0, Number.MAX_SAFE_INTEGER);
    assertBoolean(determinism.disableAnimations, "determinism.disableAnimations");
    if (
      determinism.reducedMotion !== undefined &&
      determinism.reducedMotion !== "reduce" &&
      determinism.reducedMotion !== "no-preference"
    ) {
      throw new Error(
        `Invalid profile '${name}': determinism.reducedMotion must be reduce|no-preference`,
      );
    }
  }
  if (profile.a11y !== undefined) {
    const a11y = assertObject(profile.a11y, `profile '${name}'.a11y`);
    assertNoUnknownKeys(a11y, PROFILE_A11Y_ALLOWED_KEYS, `profile '${name}'.a11y`);
    if (
      a11y.standard !== undefined &&
      !["wcag2a", "wcag2aa", "wcag2aaa"].includes(String(a11y.standard))
    ) {
      throw new Error(`Invalid profile '${name}': a11y.standard must be wcag2a|wcag2aa|wcag2aaa`);
    }
    assertIntegerInRange(a11y.maxIssues, "a11y.maxIssues", 0, 1_000_000);
    if (a11y.engine !== undefined && !["axe", "builtin"].includes(String(a11y.engine))) {
      throw new Error(`Invalid profile '${name}': a11y.engine must be axe|builtin`);
    }
  }
  if (profile.perf !== undefined) {
    const perf = assertObject(profile.perf, `profile '${name}'.perf`);
    assertNoUnknownKeys(perf, PROFILE_PERF_ALLOWED_KEYS, `profile '${name}'.perf`);
    if (perf.preset !== undefined && !["mobile", "desktop"].includes(String(perf.preset))) {
      throw new Error(`Invalid profile '${name}': perf.preset must be mobile|desktop`);
    }
    if (perf.engine !== undefined && !["lhci", "builtin"].includes(String(perf.engine))) {
      throw new Error(`Invalid profile '${name}': perf.engine must be lhci|builtin`);
    }
  }
  if (profile.visual !== undefined) {
    const visual = assertObject(profile.visual, `profile '${name}'.visual`);
    assertNoUnknownKeys(visual, PROFILE_VISUAL_ALLOWED_KEYS, `profile '${name}'.visual`);
    if (
      visual.engine !== undefined &&
      !["builtin", "lostpixel", "backstop"].includes(String(visual.engine))
    ) {
      throw new Error(
        `Invalid profile '${name}': visual.engine must be builtin|lostpixel|backstop`,
      );
    }
    if (visual.mode !== undefined && !["diff", "update"].includes(String(visual.mode))) {
      throw new Error(`Invalid profile '${name}': visual.mode must be diff|update`);
    }
    if (visual.baselineDir !== undefined && typeof visual.baselineDir !== "string") {
      throw new Error(`Invalid profile '${name}': visual.baselineDir must be string`);
    }
    assertNumberInRange(visual.maxDiffPixels, "visual.maxDiffPixels", 0, 1_000_000_000);
  }
  if (profile.load !== undefined) {
    const load = assertObject(profile.load, `profile '${name}'.load`);
    assertNoUnknownKeys(load, PROFILE_LOAD_ALLOWED_KEYS, `profile '${name}'.load`);
    assertIntegerInRange(load.vus, "load.vus", 1, 100_000);
    assertIntegerInRange(load.durationSeconds, "load.durationSeconds", 1, 86_400);
    assertIntegerInRange(load.requestTimeoutMs, "load.requestTimeoutMs", 100, 300_000);
    if (
      load.engines !== undefined &&
      (!Array.isArray(load.engines) ||
        load.engines.some((engine) => !["builtin", "artillery", "k6"].includes(String(engine))))
    ) {
      throw new Error(`Invalid profile '${name}': load.engines must contain builtin|artillery|k6`);
    }
  }
  if (profile.security !== undefined) {
    const security = assertObject(profile.security, `profile '${name}'.security`);
    assertNoUnknownKeys(security, PROFILE_SECURITY_ALLOWED_KEYS, `profile '${name}'.security`);
    if (
      security.engine !== undefined &&
      !["builtin", "semgrep"].includes(String(security.engine))
    ) {
      throw new Error(`Invalid profile '${name}': security.engine must be builtin|semgrep`);
    }
    assertIntegerInRange(security.maxFileSizeKb, "security.maxFileSizeKb", 1, 10_000_000);
    assertStringArray(security.includeExtensions, "security.includeExtensions");
    assertStringArray(security.excludeDirs, "security.excludeDirs");
    if (security.rulesFile !== undefined && typeof security.rulesFile !== "string") {
      throw new Error(`Invalid profile '${name}': security.rulesFile must be string`);
    }
  }
  if (profile.aiReview !== undefined) {
    const aiReview = assertObject(profile.aiReview, `profile '${name}'.aiReview`);
    assertNoUnknownKeys(aiReview, PROFILE_AI_REVIEW_ALLOWED_KEYS, `profile '${name}'.aiReview`);
    assertBoolean(aiReview.enabled, "aiReview.enabled");
    assertIntegerInRange(aiReview.maxArtifacts, "aiReview.maxArtifacts", 1, 500);
    assertBoolean(aiReview.emitIssue, "aiReview.emitIssue");
    assertBoolean(aiReview.emitPrComment, "aiReview.emitPrComment");
    if (
      aiReview.severityThreshold !== undefined &&
      !["critical", "high", "medium", "low"].includes(String(aiReview.severityThreshold))
    ) {
      throw new Error(
        `Invalid profile '${name}': aiReview.severityThreshold must be critical|high|medium|low`,
      );
    }
  }
  if (profile.desktopSoak !== undefined) {
    const desktopSoak = assertObject(profile.desktopSoak, `profile '${name}'.desktopSoak`);
    assertNoUnknownKeys(
      desktopSoak,
      PROFILE_DESKTOP_SOAK_ALLOWED_KEYS,
      `profile '${name}'.desktopSoak`,
    );
    assertIntegerInRange(desktopSoak.durationSeconds, "desktopSoak.durationSeconds", 5, 86_400);
    assertIntegerInRange(desktopSoak.intervalSeconds, "desktopSoak.intervalSeconds", 1, 3_600);
    if (desktopSoak.gates !== undefined) {
      const gates = assertObject(desktopSoak.gates, `profile '${name}'.desktopSoak.gates`);
      assertNoUnknownKeys(
        gates,
        PROFILE_DESKTOP_SOAK_GATES_ALLOWED_KEYS,
        `profile '${name}'.desktopSoak.gates`,
      );
      assertNumberInRange(gates.rssGrowthMbMax, "desktopSoak.gates.rssGrowthMbMax", 0, 1_000_000);
      assertNumberInRange(gates.cpuAvgPercentMax, "desktopSoak.gates.cpuAvgPercentMax", 0, 100);
      assertIntegerInRange(gates.crashCountMax, "desktopSoak.gates.crashCountMax", 0, 1_000_000);
    }
  }
  if (profile.desktopE2E !== undefined) {
    const desktopE2E = assertObject(profile.desktopE2E, `profile '${name}'.desktopE2E`);
    assertNoUnknownKeys(
      desktopE2E,
      PROFILE_DESKTOP_E2E_ALLOWED_KEYS,
      `profile '${name}'.desktopE2E`,
    );
    assertBoolean(desktopE2E.keyboardInteractionRequired, "desktopE2E.keyboardInteractionRequired");
  }
  if (profile.enginePolicy !== undefined) {
    const enginePolicy = assertObject(profile.enginePolicy, `profile '${name}'.enginePolicy`);
    assertNoUnknownKeys(
      enginePolicy,
      PROFILE_ENGINE_POLICY_ALLOWED_KEYS,
      `profile '${name}'.enginePolicy`,
    );
    if (enginePolicy.required !== undefined) {
      if (
        !Array.isArray(enginePolicy.required) ||
        enginePolicy.required.some(
          (engine) =>
            !["crawlee", "lostpixel", "backstop", "semgrep", "k6"].includes(String(engine)),
        )
      ) {
        throw new Error(
          `Invalid profile '${name}': enginePolicy.required must contain crawlee|lostpixel|backstop|semgrep|k6`,
        );
      }
    }
    assertBoolean(enginePolicy.failOnBlocked, "enginePolicy.failOnBlocked");
  }
  if (profile.diagnostics !== undefined) {
    const diagnostics = assertObject(profile.diagnostics, `profile '${name}'.diagnostics`);
    assertNoUnknownKeys(
      diagnostics,
      PROFILE_DIAGNOSTICS_ALLOWED_KEYS,
      `profile '${name}'.diagnostics`,
    );
    assertIntegerInRange(diagnostics.maxItems, "diagnostics.maxItems", 1, 10_000);
  }
  return raw;
}

export function validateTargetConfig(raw: TargetConfig, name: string): TargetConfig {
  const target = assertObject(raw, `target '${name}'`);
  assertNoUnknownKeys(target, TARGET_ALLOWED_KEYS, `target '${name}'`);
  if (typeof target.name !== "string" || target.name.trim().length === 0) {
    throw new Error(`Invalid target '${name}': 'name' must be non-empty string`);
  }
  if (!["web", "tauri", "swift"].includes(String(target.type))) {
    throw new Error(`Invalid target '${name}': 'type' must be one of web|tauri|swift`);
  }
  if (typeof target.driver !== "string" || target.driver.trim().length === 0) {
    throw new Error(`Invalid target '${name}': 'driver' must be non-empty string`);
  }
  if (target.baseUrl !== undefined && typeof target.baseUrl !== "string") {
    throw new Error(`Invalid target '${name}': 'baseUrl' must be string`);
  }
  assertNumberInRange(target.geminiAccuracyMin, "target.geminiAccuracyMin", 0, 1);
  assertNumberInRange(
    target.geminiParallelConsistencyMin,
    "target.geminiParallelConsistencyMin",
    0,
    1,
  );
  assertIntegerInRange(target.geminiSampleSizeMin, "target.geminiSampleSizeMin", 1, 1_000_000);
  if (
    (target.geminiAccuracyMin !== undefined || target.geminiParallelConsistencyMin !== undefined) &&
    target.geminiSampleSizeMin === undefined
  ) {
    throw new Error(
      `Invalid target '${name}': geminiSampleSizeMin is required when geminiAccuracyMin or geminiParallelConsistencyMin is configured`,
    );
  }
  if (target.computerUse !== undefined) {
    const computerUse = assertObject(target.computerUse, `target '${name}'.computerUse`);
    assertNoUnknownKeys(
      computerUse,
      TARGET_COMPUTER_USE_ALLOWED_KEYS,
      `target '${name}'.computerUse`,
    );
    assertBoolean(computerUse.enabled, "target.computerUse.enabled");
    if (computerUse.task !== undefined && typeof computerUse.task !== "string") {
      throw new Error(`Invalid target '${name}': computerUse.task must be string`);
    }
    assertIntegerInRange(computerUse.maxSteps, "target.computerUse.maxSteps", 1, 10_000);
    assertBoolean(computerUse.speedMode, "target.computerUse.speedMode");
  }
  if (target.start !== undefined) {
    const start = assertObject(target.start, `target '${name}'.start`);
    assertNoUnknownKeys(start, TARGET_START_ALLOWED_KEYS, `target '${name}'.start`);
    if (start.web !== undefined && typeof start.web !== "string") {
      throw new Error(`Invalid target '${name}': start.web must be string`);
    }
    if (start.api !== undefined && typeof start.api !== "string") {
      throw new Error(`Invalid target '${name}': start.api must be string`);
    }
  }
  if (target.healthcheck !== undefined) {
    const healthcheck = assertObject(target.healthcheck, `target '${name}'.healthcheck`);
    assertNoUnknownKeys(
      healthcheck,
      TARGET_HEALTHCHECK_ALLOWED_KEYS,
      `target '${name}'.healthcheck`,
    );
    if (healthcheck.url !== undefined && typeof healthcheck.url !== "string") {
      throw new Error(`Invalid target '${name}': healthcheck.url must be string`);
    }
  }
  if (target.scope !== undefined) {
    const scope = assertObject(target.scope, `target '${name}'.scope`);
    assertNoUnknownKeys(scope, TARGET_SCOPE_ALLOWED_KEYS, `target '${name}'.scope`);
    assertStringArray(scope.domains, `target '${name}'.scope.domains`);
    assertBoolean(scope.allowLocalhostAnyPort, `target '${name}'.scope.allowLocalhostAnyPort`);
  }
  if (target.type === "web") {
    if (!target.baseUrl) {
      throw new Error(`Invalid target '${name}': web target must define baseUrl`);
    }
    const domains = raw.scope?.domains;
    const allowLocalhostAnyPort = raw.scope?.allowLocalhostAnyPort === true;
    if ((!Array.isArray(domains) || domains.length === 0) && !allowLocalhostAnyPort) {
      throw new Error(
        `Invalid target '${name}': web target must define scope.domains with at least one allowed origin or set scope.allowLocalhostAnyPort=true`,
      );
    }
    if (Array.isArray(domains)) {
      for (const domain of domains) {
        try {
          new URL(domain);
        } catch {
          throw new Error(
            `Invalid target '${name}': scope.domains contains invalid URL '${domain}'`,
          );
        }
      }
    }
  }
  if (target.explore !== undefined) {
    const explore = assertObject(target.explore, `target '${name}'.explore`);
    assertNoUnknownKeys(explore, TARGET_EXPLORE_ALLOWED_KEYS, `target '${name}'.explore`);
    assertIntegerInRange(explore.budgetSeconds, "target.explore.budgetSeconds", 1, 86_400);
    assertIntegerInRange(explore.maxDepth, "target.explore.maxDepth", 1, 32);
    assertIntegerInRange(explore.maxStates, "target.explore.maxStates", 1, 10_000);
    assertIntegerInRange(explore.seed, "target.explore.seed", 0, Number.MAX_SAFE_INTEGER);
    assertStringArray(explore.denylist, "target.explore.denylist");
    if (explore.engine !== undefined && !["builtin", "crawlee"].includes(String(explore.engine))) {
      throw new Error(`Invalid target '${name}': explore.engine must be builtin|crawlee`);
    }
  }
  if (target.chaos !== undefined) {
    const chaos = assertObject(target.chaos, `target '${name}'.chaos`);
    assertNoUnknownKeys(chaos, TARGET_CHAOS_ALLOWED_KEYS, `target '${name}'.chaos`);
    assertIntegerInRange(chaos.seed, "target.chaos.seed", 0, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange(chaos.budgetSeconds, "target.chaos.budgetSeconds", 1, 86_400);
    if (chaos.eventRatio !== undefined) {
      const ratio = assertObject(chaos.eventRatio, `target '${name}'.chaos.eventRatio`);
      assertNoUnknownKeys(
        ratio,
        TARGET_CHAOS_RATIO_ALLOWED_KEYS,
        `target '${name}'.chaos.eventRatio`,
      );
      assertNumberInRange(ratio.click, "target.chaos.eventRatio.click", 0, 100);
      assertNumberInRange(ratio.input, "target.chaos.eventRatio.input", 0, 100);
      assertNumberInRange(ratio.scroll, "target.chaos.eventRatio.scroll", 0, 100);
      assertNumberInRange(ratio.keyboard, "target.chaos.eventRatio.keyboard", 0, 100);
    }
  }
  if (target.diagnostics !== undefined) {
    const diagnostics = assertObject(target.diagnostics, `target '${name}'.diagnostics`);
    assertNoUnknownKeys(
      diagnostics,
      TARGET_DIAGNOSTICS_ALLOWED_KEYS,
      `target '${name}'.diagnostics`,
    );
    assertIntegerInRange(diagnostics.maxItems, "target.diagnostics.maxItems", 1, 10_000);
  }
  if (target.a11y !== undefined) {
    const a11y = assertObject(target.a11y, `target '${name}'.a11y`);
    assertNoUnknownKeys(a11y, TARGET_A11Y_ALLOWED_KEYS, `target '${name}'.a11y`);
    if (
      a11y.standard !== undefined &&
      !["wcag2a", "wcag2aa", "wcag2aaa"].includes(String(a11y.standard))
    ) {
      throw new Error(`Invalid target '${name}': a11y.standard must be wcag2a|wcag2aa|wcag2aaa`);
    }
    assertIntegerInRange(a11y.maxIssues, "target.a11y.maxIssues", 0, 1_000_000);
    if (a11y.engine !== undefined && !["axe", "builtin"].includes(String(a11y.engine))) {
      throw new Error(`Invalid target '${name}': a11y.engine must be axe|builtin`);
    }
  }
  if (target.perf !== undefined) {
    const perf = assertObject(target.perf, `target '${name}'.perf`);
    assertNoUnknownKeys(perf, TARGET_PERF_ALLOWED_KEYS, `target '${name}'.perf`);
    if (perf.preset !== undefined && !["mobile", "desktop"].includes(String(perf.preset))) {
      throw new Error(`Invalid target '${name}': perf.preset must be mobile|desktop`);
    }
    if (perf.engine !== undefined && !["lhci", "builtin"].includes(String(perf.engine))) {
      throw new Error(`Invalid target '${name}': perf.engine must be lhci|builtin`);
    }
  }
  if (target.visual !== undefined) {
    const visual = assertObject(target.visual, `target '${name}'.visual`);
    assertNoUnknownKeys(visual, TARGET_VISUAL_ALLOWED_KEYS, `target '${name}'.visual`);
    if (
      visual.engine !== undefined &&
      !["builtin", "lostpixel", "backstop"].includes(String(visual.engine))
    ) {
      throw new Error(`Invalid target '${name}': visual.engine must be builtin|lostpixel|backstop`);
    }
    if (visual.mode !== undefined && !["diff", "update"].includes(String(visual.mode))) {
      throw new Error(`Invalid target '${name}': visual.mode must be diff|update`);
    }
    if (visual.baselineDir !== undefined && typeof visual.baselineDir !== "string") {
      throw new Error(`Invalid target '${name}': visual.baselineDir must be string`);
    }
    assertNumberInRange(visual.maxDiffPixels, "target.visual.maxDiffPixels", 0, 1_000_000_000);
  }
  if (target.load !== undefined) {
    const load = assertObject(target.load, `target '${name}'.load`);
    assertNoUnknownKeys(load, TARGET_LOAD_ALLOWED_KEYS, `target '${name}'.load`);
    assertIntegerInRange(load.vus, "target.load.vus", 1, 100_000);
    assertIntegerInRange(load.durationSeconds, "target.load.durationSeconds", 1, 86_400);
    assertIntegerInRange(load.requestTimeoutMs, "target.load.requestTimeoutMs", 100, 300_000);
    if (
      load.engines !== undefined &&
      (!Array.isArray(load.engines) ||
        load.engines.some((engine) => !["builtin", "artillery", "k6"].includes(String(engine))))
    ) {
      throw new Error(`Invalid target '${name}': load.engines must contain builtin|artillery|k6`);
    }
  }
  if (target.security !== undefined) {
    const security = assertObject(target.security, `target '${name}'.security`);
    assertNoUnknownKeys(security, TARGET_SECURITY_ALLOWED_KEYS, `target '${name}'.security`);
    if (
      security.engine !== undefined &&
      !["builtin", "semgrep"].includes(String(security.engine))
    ) {
      throw new Error(`Invalid target '${name}': security.engine must be builtin|semgrep`);
    }
    assertIntegerInRange(security.maxFileSizeKb, "target.security.maxFileSizeKb", 1, 10_000_000);
    assertStringArray(security.includeExtensions, "target.security.includeExtensions");
    assertStringArray(security.excludeDirs, "target.security.excludeDirs");
    if (security.rulesFile !== undefined && typeof security.rulesFile !== "string") {
      throw new Error(`Invalid target '${name}': security.rulesFile must be string`);
    }
  }
  if (target.aiReview !== undefined) {
    const aiReview = assertObject(target.aiReview, `target '${name}'.aiReview`);
    assertNoUnknownKeys(aiReview, TARGET_AI_REVIEW_ALLOWED_KEYS, `target '${name}'.aiReview`);
    assertBoolean(aiReview.enabled, "target.aiReview.enabled");
    assertIntegerInRange(aiReview.maxArtifacts, "target.aiReview.maxArtifacts", 1, 500);
    assertBoolean(aiReview.emitIssue, "target.aiReview.emitIssue");
    assertBoolean(aiReview.emitPrComment, "target.aiReview.emitPrComment");
    if (
      aiReview.severityThreshold !== undefined &&
      !["critical", "high", "medium", "low"].includes(String(aiReview.severityThreshold))
    ) {
      throw new Error(
        `Invalid target '${name}': aiReview.severityThreshold must be critical|high|medium|low`,
      );
    }
  }
  if (target.desktopSoak !== undefined) {
    const desktopSoak = assertObject(target.desktopSoak, `target '${name}'.desktopSoak`);
    assertNoUnknownKeys(
      desktopSoak,
      TARGET_DESKTOP_SOAK_ALLOWED_KEYS,
      `target '${name}'.desktopSoak`,
    );
    assertIntegerInRange(
      desktopSoak.durationSeconds,
      "target.desktopSoak.durationSeconds",
      5,
      86_400,
    );
    assertIntegerInRange(
      desktopSoak.intervalSeconds,
      "target.desktopSoak.intervalSeconds",
      1,
      3_600,
    );
    if (desktopSoak.gates !== undefined) {
      const gates = assertObject(desktopSoak.gates, `target '${name}'.desktopSoak.gates`);
      assertNoUnknownKeys(
        gates,
        TARGET_DESKTOP_SOAK_GATES_ALLOWED_KEYS,
        `target '${name}'.desktopSoak.gates`,
      );
      assertNumberInRange(
        gates.rssGrowthMbMax,
        "target.desktopSoak.gates.rssGrowthMbMax",
        0,
        1_000_000,
      );
      assertNumberInRange(
        gates.cpuAvgPercentMax,
        "target.desktopSoak.gates.cpuAvgPercentMax",
        0,
        100,
      );
      assertIntegerInRange(
        gates.crashCountMax,
        "target.desktopSoak.gates.crashCountMax",
        0,
        1_000_000,
      );
    }
  }
  if (target.type === "tauri" && !Object.hasOwn(target, "app")) {
    throw new Error(
      `Invalid target '${name}': tauri target must declare 'app' key (can be empty string)`,
    );
  }
  if (target.type === "swift" && !Object.hasOwn(target, "bundleId")) {
    throw new Error(
      `Invalid target '${name}': swift target must declare 'bundleId' key (can be empty string)`,
    );
  }
  return raw;
}
