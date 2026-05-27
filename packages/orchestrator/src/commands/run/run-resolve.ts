import { loadYamlFile } from "../../../../core/src/config/loadYaml.js";
import type { A11yConfig } from "../a11y.js";
import type { ChaosConfig, ChaosEventRatio } from "../chaos.js";
import type { DesktopSoakConfig } from "../desktop-soak.js";
import type { DangerActionPolicy } from "../explore.js";
import type { LoadConfig } from "../load.js";
import type { PerfConfig } from "../perf.js";
import type { SecurityConfig } from "../security.js";
import type { VisualConfig } from "../visual.js";
import {
  CHAOS_EVENTS_PER_SECOND,
  DEFAULT_ACTION_DENYLIST,
  DEFAULT_CHAOS_RATIO,
  DEFAULT_DANGER_POLICY_FILE,
  DEFAULT_DIAGNOSTIC_MAX_ITEMS,
  NIGHTLY_CHAOS_BUDGET_REDUCTION_FACTOR,
  NIGHTLY_CHAOS_CLICK_RATIO_CAP,
  NIGHTLY_CHAOS_INPUT_RATIO_CAP,
  NIGHTLY_CHAOS_MIN_BUDGET_SECONDS,
  NIGHTLY_CHAOS_MIN_EVENTS,
  NIGHTLY_CHAOS_MIN_EVENTS_PER_EXPLORE_STATE,
} from "./run-schema.js";
import type {
  AiReviewConfig,
  ComputerUseRuntimeConfig,
  DiagnosticsConfig,
  ExploreConfig,
  ProfileConfig,
  RunOverrides,
  TargetConfig,
} from "./run-types.js";

function loadDangerActionPolicy(pathFromRepoRoot: string): DangerActionPolicy {
  try {
    const loaded = loadYamlFile<DangerActionPolicy>(pathFromRepoRoot);
    return {
      lexical: Array.isArray(loaded.lexical)
        ? loaded.lexical.filter((item): item is string => typeof item === "string")
        : [],
      roles: Array.isArray(loaded.roles)
        ? loaded.roles.filter((item): item is string => typeof item === "string")
        : [],
      selectors: Array.isArray(loaded.selectors)
        ? loaded.selectors.filter((item): item is string => typeof item === "string")
        : [],
      urlPatterns: Array.isArray(loaded.urlPatterns)
        ? loaded.urlPatterns.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return { lexical: [], roles: [], selectors: [], urlPatterns: [] };
  }
}

export function resolveExploreConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): ExploreConfig {
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for explore`);
  }
  const targetExplore = target.explore ?? {};
  const profileExplore = profile.explore ?? {};
  const policyFile =
    profileExplore.policyFile ?? targetExplore.policyFile ?? DEFAULT_DANGER_POLICY_FILE;
  const denyStrategy = loadDangerActionPolicy(policyFile);
  const denylist = Array.from(
    new Set([
      ...DEFAULT_ACTION_DENYLIST,
      ...denyStrategy.lexical,
      ...(targetExplore.denylist ?? []),
      ...(profileExplore.denylist ?? []),
    ]),
  );

  return {
    engine: overrides?.exploreEngine ?? profileExplore.engine ?? targetExplore.engine ?? "builtin",
    baseUrl: effectiveBaseUrl,
    budgetSeconds:
      overrides?.exploreBudgetSeconds ??
      profileExplore.budgetSeconds ??
      targetExplore.budgetSeconds ??
      600,
    maxDepth: overrides?.exploreMaxDepth ?? profileExplore.maxDepth ?? targetExplore.maxDepth ?? 3,
    maxStates:
      overrides?.exploreMaxStates ?? profileExplore.maxStates ?? targetExplore.maxStates ?? 30,
    seed: profileExplore.seed ?? targetExplore.seed ?? 20260218,
    denylist,
    denyStrategy,
  };
}

export function resolveChaosConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): ChaosConfig {
  const targetChaos = target.chaos ?? {};
  const profileChaos = profile.chaos ?? {};
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for chaos`);
  }
  const explorePolicyFile =
    profile.explore?.policyFile ?? target.explore?.policyFile ?? DEFAULT_DANGER_POLICY_FILE;
  const denyStrategy = loadDangerActionPolicy(explorePolicyFile);
  const mergedDenylist = Array.from(
    new Set([
      ...DEFAULT_ACTION_DENYLIST,
      ...denyStrategy.lexical,
      ...(target.explore?.denylist ?? []),
      ...(profile.explore?.denylist ?? []),
    ]),
  );
  const eventRatio: ChaosEventRatio = {
    click:
      overrides?.chaosClickRatio ??
      profileChaos.eventRatio?.click ??
      targetChaos.eventRatio?.click ??
      DEFAULT_CHAOS_RATIO.click,
    input:
      overrides?.chaosInputRatio ??
      profileChaos.eventRatio?.input ??
      targetChaos.eventRatio?.input ??
      DEFAULT_CHAOS_RATIO.input,
    scroll:
      overrides?.chaosScrollRatio ??
      profileChaos.eventRatio?.scroll ??
      targetChaos.eventRatio?.scroll ??
      DEFAULT_CHAOS_RATIO.scroll,
    keyboard:
      overrides?.chaosKeyboardRatio ??
      profileChaos.eventRatio?.keyboard ??
      targetChaos.eventRatio?.keyboard ??
      DEFAULT_CHAOS_RATIO.keyboard,
  };

  return {
    baseUrl: effectiveBaseUrl,
    seed: overrides?.chaosSeed ?? profileChaos.seed ?? targetChaos.seed ?? 20260218,
    budgetSeconds:
      overrides?.chaosBudgetSeconds ??
      profileChaos.budgetSeconds ??
      targetChaos.budgetSeconds ??
      180,
    eventRatio,
    denylist: mergedDenylist,
    denyStrategy,
  };
}

export function optimizeNightlyChaosConfig(
  config: ChaosConfig,
  profile: ProfileConfig,
  exploreConfig: ExploreConfig | undefined,
  overrides?: RunOverrides,
): ChaosConfig {
  if (profile.name !== "nightly") {
    return config;
  }

  const hasExplicitBudgetOverride = typeof overrides?.chaosBudgetSeconds === "number";
  const hasExplicitRatioOverride =
    typeof overrides?.chaosClickRatio === "number" ||
    typeof overrides?.chaosInputRatio === "number" ||
    typeof overrides?.chaosScrollRatio === "number" ||
    typeof overrides?.chaosKeyboardRatio === "number";

  let optimizedBudgetSeconds = config.budgetSeconds;
  if (!hasExplicitBudgetOverride) {
    const maxStatesHint = Math.max(0, exploreConfig?.maxStates ?? profile.explore?.maxStates ?? 0);
    const minEventsByCoverage = Math.max(
      NIGHTLY_CHAOS_MIN_EVENTS,
      maxStatesHint * NIGHTLY_CHAOS_MIN_EVENTS_PER_EXPLORE_STATE,
    );
    const baselineEvents = Math.floor(config.budgetSeconds * CHAOS_EVENTS_PER_SECOND);
    const reducedEvents = Math.floor(baselineEvents * NIGHTLY_CHAOS_BUDGET_REDUCTION_FACTOR);
    const optimizedEvents = Math.max(minEventsByCoverage, reducedEvents);
    const optimizedBudgetByEvents = Math.max(
      1,
      Math.ceil(optimizedEvents / CHAOS_EVENTS_PER_SECOND),
    );
    optimizedBudgetSeconds = Math.min(
      config.budgetSeconds,
      Math.max(NIGHTLY_CHAOS_MIN_BUDGET_SECONDS, optimizedBudgetByEvents),
    );
  }

  let optimizedRatio = config.eventRatio;
  if (!hasExplicitRatioOverride && optimizedRatio.click > NIGHTLY_CHAOS_CLICK_RATIO_CAP) {
    const clickOverflow = optimizedRatio.click - NIGHTLY_CHAOS_CLICK_RATIO_CAP;
    const redistributeBase = optimizedRatio.input + optimizedRatio.scroll + optimizedRatio.keyboard;
    if (redistributeBase > 0) {
      optimizedRatio = {
        click: NIGHTLY_CHAOS_CLICK_RATIO_CAP,
        input: optimizedRatio.input + (clickOverflow * optimizedRatio.input) / redistributeBase,
        scroll: optimizedRatio.scroll + (clickOverflow * optimizedRatio.scroll) / redistributeBase,
        keyboard:
          optimizedRatio.keyboard + (clickOverflow * optimizedRatio.keyboard) / redistributeBase,
      };
    }
  }
  if (!hasExplicitRatioOverride && optimizedRatio.input > NIGHTLY_CHAOS_INPUT_RATIO_CAP) {
    const inputOverflow = optimizedRatio.input - NIGHTLY_CHAOS_INPUT_RATIO_CAP;
    const redistributeBase = optimizedRatio.scroll + optimizedRatio.keyboard;
    if (redistributeBase > 0) {
      optimizedRatio = {
        click: optimizedRatio.click,
        input: NIGHTLY_CHAOS_INPUT_RATIO_CAP,
        scroll: optimizedRatio.scroll + (inputOverflow * optimizedRatio.scroll) / redistributeBase,
        keyboard:
          optimizedRatio.keyboard + (inputOverflow * optimizedRatio.keyboard) / redistributeBase,
      };
    }
  }

  return {
    ...config,
    budgetSeconds: optimizedBudgetSeconds,
    eventRatio: optimizedRatio,
  };
}

export function resolveDiagnosticsConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  override?: number,
): DiagnosticsConfig {
  const fromProfile = profile.diagnostics?.maxItems;
  const fromTarget = target.diagnostics?.maxItems;
  const maxItems = override ?? fromProfile ?? fromTarget ?? DEFAULT_DIAGNOSTIC_MAX_ITEMS;
  return {
    maxItems: Math.max(1, Math.floor(maxItems)),
  };
}

export function resolveLoadConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): LoadConfig {
  const targetLoad = target.load ?? {};
  const profileLoad = profile.load ?? {};
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for load`);
  }
  const mergedEngines = profileLoad.engines ?? targetLoad.engines ?? ["builtin", "artillery", "k6"];
  const normalizedEngines = (
    overrides?.loadEngine === "both"
      ? ["builtin", "artillery", "k6"]
      : overrides?.loadEngine
        ? ["builtin", overrides.loadEngine].filter(
            (value, index, arr) => arr.indexOf(value) === index,
          )
        : mergedEngines
  ) as Array<"builtin" | "artillery" | "k6">;
  return {
    baseUrl: effectiveBaseUrl,
    vus: overrides?.loadVus ?? profileLoad.vus ?? targetLoad.vus ?? 10,
    durationSeconds:
      overrides?.loadDurationSeconds ??
      profileLoad.durationSeconds ??
      targetLoad.durationSeconds ??
      30,
    requestTimeoutMs:
      overrides?.loadRequestTimeoutMs ??
      profileLoad.requestTimeoutMs ??
      targetLoad.requestTimeoutMs ??
      8000,
    engines: normalizedEngines,
  };
}

export function resolveA11yConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): A11yConfig {
  const targetA11y = target.a11y ?? {};
  const profileA11y = profile.a11y ?? {};
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for a11y`);
  }
  return {
    baseUrl: effectiveBaseUrl,
    standard: profileA11y.standard ?? targetA11y.standard ?? "wcag2aa",
    maxIssues: overrides?.a11yMaxIssues ?? profileA11y.maxIssues ?? targetA11y.maxIssues ?? 200,
    engine: overrides?.a11yEngine ?? profileA11y.engine ?? targetA11y.engine ?? "axe",
  };
}

export function resolvePerfConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): PerfConfig {
  const targetPerf = target.perf ?? {};
  const profilePerf = profile.perf ?? {};
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for perf`);
  }
  return {
    baseUrl: effectiveBaseUrl,
    preset: overrides?.perfPreset ?? profilePerf.preset ?? targetPerf.preset ?? "desktop",
    engine: overrides?.perfEngine ?? profilePerf.engine ?? targetPerf.engine ?? "lhci",
  };
}

export function resolveVisualConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): VisualConfig {
  const targetVisual = target.visual ?? {};
  const profileVisual = profile.visual ?? {};
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrl) {
    throw new Error(`Target '${target.name}' missing baseUrl for visual`);
  }
  return {
    baseUrl: effectiveBaseUrl,
    targetName: target.name,
    engine: overrides?.visualEngine ?? profileVisual.engine ?? targetVisual.engine ?? "builtin",
    mode: overrides?.visualMode ?? profileVisual.mode ?? targetVisual.mode ?? "diff",
    baselineDir: profileVisual.baselineDir ?? targetVisual.baselineDir,
    maxDiffPixels: profileVisual.maxDiffPixels ?? targetVisual.maxDiffPixels,
  };
}

export function resolveAiReviewConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): AiReviewConfig {
  const profileAiReview = profile.aiReview ?? {};
  const targetAiReview = target.aiReview ?? {};
  const maxArtifacts =
    overrides?.aiReviewMaxArtifacts ??
    profileAiReview.maxArtifacts ??
    targetAiReview.maxArtifacts ??
    40;
  return {
    enabled: overrides?.aiReview ?? profileAiReview.enabled ?? targetAiReview.enabled ?? false,
    maxArtifacts: Math.max(1, Math.min(500, Math.floor(maxArtifacts))),
    emitIssue: profileAiReview.emitIssue ?? targetAiReview.emitIssue ?? false,
    emitPrComment: profileAiReview.emitPrComment ?? targetAiReview.emitPrComment ?? false,
    severityThreshold:
      profileAiReview.severityThreshold ?? targetAiReview.severityThreshold ?? "high",
  };
}

export function resolveComputerUseConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): ComputerUseRuntimeConfig {
  const targetConfig = target.computerUse ?? {};
  const profileConfig = profile.computerUse ?? {};
  const profileTask = profileConfig.task?.trim();
  const targetTask = targetConfig.task?.trim();
  const envTask = process.env.UIQ_COMPUTER_USE_TASK?.trim();
  return {
    enabled: profileConfig.enabled ?? targetConfig.enabled ?? true,
    task: profileTask || targetTask || envTask,
    maxSteps: overrides?.computerUseMaxSteps ?? profileConfig.maxSteps ?? targetConfig.maxSteps,
    speedMode: overrides?.computerUseSpeedMode ?? profileConfig.speedMode ?? targetConfig.speedMode,
    taskSource: profileTask ? "profile" : targetTask ? "target" : envTask ? "env" : undefined,
  };
}

export function resolveSecurityConfig(
  target: TargetConfig,
  profile: ProfileConfig,
): SecurityConfig {
  const targetSecurity = target.security ?? {};
  const profileSecurity = profile.security ?? {};
  const includeExtensions = Array.from(
    new Set([
      ...(targetSecurity.includeExtensions ?? []),
      ...(profileSecurity.includeExtensions ?? []),
    ]),
  );
  const excludeDirs = Array.from(
    new Set([
      ".git",
      "node_modules",
      ".runtime-cache",
      ".codex",
      "dist",
      "build",
      ".turbo",
      ...(targetSecurity.excludeDirs ?? []),
      ...(profileSecurity.excludeDirs ?? []),
    ]),
  );
  return {
    rootDir: process.cwd(),
    engine:
      profileSecurity.engine ?? targetSecurity.engine ?? (process.env.CI ? "semgrep" : "builtin"),
    maxFileSizeKb: profileSecurity.maxFileSizeKb ?? targetSecurity.maxFileSizeKb ?? 512,
    includeExtensions,
    excludeDirs,
    rulesFile:
      profileSecurity.rulesFile ?? targetSecurity.rulesFile ?? "configs/security-rules.yaml",
  };
}

export function resolveDesktopSoakConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): DesktopSoakConfig {
  const targetSoak = target.desktopSoak ?? {};
  const profileSoak = profile.desktopSoak ?? {};
  return {
    targetType: target.type,
    app: overrides?.app ?? target.app,
    bundleId: overrides?.bundleId ?? target.bundleId,
    durationSeconds:
      overrides?.soakDurationSeconds ??
      profileSoak.durationSeconds ??
      targetSoak.durationSeconds ??
      120,
    intervalSeconds:
      overrides?.soakIntervalSeconds ??
      profileSoak.intervalSeconds ??
      targetSoak.intervalSeconds ??
      10,
    gates: profileSoak.gates ?? targetSoak.gates,
  };
}
