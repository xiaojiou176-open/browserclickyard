import { resolve } from "node:path";
import { loadYamlFile, loadYamlFileUnderRoot } from "../../../../core/src/config/loadYaml.js";
import type { Manifest } from "../../../../core/src/manifest/types.js";
import type { A11yConfig } from "../a11y.js";
import type { ChaosConfig, ChaosEventRatio } from "../chaos.js";
import type { DesktopReadinessResult } from "../desktop.js";
import type { DesktopE2EResult } from "../desktop-e2e.js";
import type { DesktopSmokeResult } from "../desktop-smoke.js";
import type { DesktopSoakConfig, DesktopSoakResult } from "../desktop-soak.js";
import { ORCHESTRATOR_ENV } from "../env.js";
import type { DangerActionPolicy } from "../explore.js";
import type { LoadConfig } from "../load.js";
import type { PerfConfig } from "../perf.js";
import type { GateThresholds } from "../report.js";
import type { SecurityConfig } from "../security.js";
import type { loadStateModel } from "../state-model.js";
import type { VisualConfig } from "../visual.js";

export type ProfileConfig = {
  name: string;
  steps: string[];
  gates?: GateThresholds;
  tests?: {
    e2eSuite?: "smoke" | "regression" | "generic" | "full";
  };
  explore?: {
    budgetSeconds?: number;
    maxDepth?: number;
    maxStates?: number;
    seed?: number;
    denylist?: string[];
    policyFile?: string;
  };
  chaos?: {
    seed?: number;
    budgetSeconds?: number;
    eventRatio?: Partial<ChaosEventRatio>;
  };
  diagnostics?: {
    maxItems?: number;
  };
  load?: {
    vus?: number;
    durationSeconds?: number;
    requestTimeoutMs?: number;
    engines?: Array<"builtin" | "artillery" | "k6">;
  };
  a11y?: {
    standard?: "wcag2a" | "wcag2aa" | "wcag2aaa";
    maxIssues?: number;
    engine?: "axe" | "builtin";
  };
  perf?: {
    preset?: "mobile" | "desktop";
    engine?: "lhci" | "builtin";
  };
  visual?: {
    mode?: "diff" | "update";
    baselineDir?: string;
    maxDiffPixels?: number;
  };
  security?: {
    engine?: "builtin" | "semgrep";
    maxFileSizeKb?: number;
    includeExtensions?: string[];
    excludeDirs?: string[];
    rulesFile?: string;
  };
  desktopSoak?: {
    durationSeconds?: number;
    intervalSeconds?: number;
    gates?: {
      rssGrowthMbMax?: number;
      cpuAvgPercentMax?: number;
      crashCountMax?: number;
    };
  };
};

export type TargetConfig = {
  name: string;
  type: string;
  driver: string;
  baseUrl?: string;
  start?: {
    web?: string;
    api?: string;
  };
  healthcheck?: {
    url?: string;
  };
  scope?: {
    domains?: string[];
    allowLocalhostAnyPort?: boolean;
  };
  app?: string;
  bundleId?: string;
  explore?: {
    budgetSeconds?: number;
    maxDepth?: number;
    maxStates?: number;
    seed?: number;
    denylist?: string[];
    policyFile?: string;
  };
  chaos?: {
    seed?: number;
    budgetSeconds?: number;
    eventRatio?: Partial<ChaosEventRatio>;
  };
  diagnostics?: {
    maxItems?: number;
  };
  load?: {
    vus?: number;
    durationSeconds?: number;
    requestTimeoutMs?: number;
    engines?: Array<"builtin" | "artillery" | "k6">;
  };
  a11y?: {
    standard?: "wcag2a" | "wcag2aa" | "wcag2aaa";
    maxIssues?: number;
    engine?: "axe" | "builtin";
  };
  perf?: {
    preset?: "mobile" | "desktop";
    engine?: "lhci" | "builtin";
  };
  visual?: {
    mode?: "diff" | "update";
    baselineDir?: string;
    maxDiffPixels?: number;
  };
  security?: {
    engine?: "builtin" | "semgrep";
    maxFileSizeKb?: number;
    includeExtensions?: string[];
    excludeDirs?: string[];
    rulesFile?: string;
  };
  desktopSoak?: {
    durationSeconds?: number;
    intervalSeconds?: number;
    gates?: {
      rssGrowthMbMax?: number;
      cpuAvgPercentMax?: number;
      crashCountMax?: number;
    };
  };
  gates?: Partial<GateThresholds>;
};

export type ExploreConfig = {
  baseUrl: string;
  budgetSeconds: number;
  maxDepth: number;
  maxStates: number;
  seed: number;
  denylist: string[];
  denyStrategy: DangerActionPolicy;
};

export type DiagnosticsConfig = {
  maxItems: number;
};
export type RunOverrides = {
  baseUrl?: string;
  allowAllUrls?: boolean;
  app?: string;
  bundleId?: string;
  diagnosticsMaxItems?: number;
  exploreBudgetSeconds?: number;
  exploreMaxDepth?: number;
  exploreMaxStates?: number;
  chaosSeed?: number;
  chaosBudgetSeconds?: number;
  chaosClickRatio?: number;
  chaosInputRatio?: number;
  chaosScrollRatio?: number;
  chaosKeyboardRatio?: number;
  loadVus?: number;
  loadDurationSeconds?: number;
  loadRequestTimeoutMs?: number;
  loadEngine?: "builtin" | "artillery" | "k6" | "both";
  a11yMaxIssues?: number;
  a11yEngine?: "axe" | "builtin";
  perfPreset?: "mobile" | "desktop";
  perfEngine?: "lhci" | "builtin";
  visualMode?: "diff" | "update";
  soakDurationSeconds?: number;
  soakIntervalSeconds?: number;
  autostartTarget?: boolean;
  geminiModel?: string;
  geminiThinkingLevel?: "minimal" | "low" | "medium" | "high";
  geminiToolMode?: "none" | "auto" | "any" | "validated";
  geminiContextCacheMode?: "memory" | "api";
  geminiMediaResolution?: "low" | "medium" | "high";
};
export type BaseUrlPolicyResult = {
  enabled: boolean;
  requestedUrl: string;
  requestedOrigin: string;
  allowedOrigins: string[];
  matched: boolean;
  reason:
    | "non_web_target"
    | "no_scope_domains"
    | "origin_allowed"
    | "origin_not_in_scope_domains"
    | "allow_all_urls"
    | "localhost_origin_allowed"
    | "localhost_origin_rejected";
};
export const DEFAULT_CHAOS_RATIO: ChaosEventRatio = {
  click: 60,
  input: 20,
  scroll: 10,
  keyboard: 10,
};
export const CHAOS_EVENTS_PER_SECOND = 3;
export const NIGHTLY_CHAOS_BUDGET_REDUCTION_FACTOR = 0.55;
export const NIGHTLY_CHAOS_MIN_BUDGET_SECONDS = 110;
export const NIGHTLY_CHAOS_MIN_EVENTS = 180;
export const NIGHTLY_CHAOS_MIN_EVENTS_PER_EXPLORE_STATE = 4;
export const NIGHTLY_CHAOS_CLICK_RATIO_CAP = 28;
export const NIGHTLY_CHAOS_INPUT_RATIO_CAP = 24;
export const DEFAULT_ACTION_DENYLIST = [
  "delete",
  "remove",
  "pay",
  "submit",
  "purchase",
  "send",
  "commit",
  "drop",
  "execute",
  "run",
  "replay",
  "resume",
  "create",
  "save",
  "执行",
  "回放",
  "续跑",
  "试跑",
  "新增",
  "保存",
  "导入",
];
export const DEFAULT_DANGER_POLICY_FILE = "configs/danger-action-policy.yaml";
export const DEFAULT_DIAGNOSTIC_MAX_ITEMS = 20;
export const TOOLCHAIN_VERSION = ORCHESTRATOR_ENV.npm_package_version ?? "0.1.0";
export const DEFAULT_MAX_PARALLEL_TASKS = 4;
export const WEB_COVERAGE_MODEL_VERSION = "web.routes-stories.v1";
export const DESKTOP_COVERAGE_MODEL_VERSION = "desktop.scenarios.v1";
export const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const MIN_DISCOVERED_STATES = 2;
export const SAFE_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
export const PROFILE_CONFIG_ROOT = resolve("profiles");
export const TARGET_CONFIG_ROOT = resolve("targets");
function assertSafeSlug(value: string, fieldName: "profileName" | "targetName"): void {
  if (!SAFE_SLUG_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName} '${value}'; only [A-Za-z0-9._-] are allowed`);
  }
}

export function loadProfileConfig(profileName: string): ProfileConfig {
  assertSafeSlug(profileName, "profileName");
  return loadYamlFileUnderRoot<ProfileConfig>(PROFILE_CONFIG_ROOT, `${profileName}.yaml`);
}

export function loadTargetConfig(targetName: string): TargetConfig {
  assertSafeSlug(targetName, "targetName");
  return loadYamlFileUnderRoot<TargetConfig>(TARGET_CONFIG_ROOT, `${targetName}.yaml`);
}

function normalizeDangerPolicyField(
  value: unknown,
  field: keyof DangerActionPolicy,
  policyFile: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid danger action policy '${policyFile}': '${field}' must be an array of strings`,
    );
  }
  return value
    .map((item, index) => {
      if (typeof item !== "string") {
        throw new Error(
          `Invalid danger action policy '${policyFile}': '${field}[${index}]' must be a string`,
        );
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

export function loadDangerActionPolicy(pathFromRepoRoot: string): DangerActionPolicy {
  try {
    const loaded =
      loadYamlFile<Partial<Record<keyof DangerActionPolicy, unknown>>>(pathFromRepoRoot);
    return {
      lexical: normalizeDangerPolicyField(loaded.lexical, "lexical", pathFromRepoRoot),
      roles: normalizeDangerPolicyField(loaded.roles, "roles", pathFromRepoRoot),
      selectors: normalizeDangerPolicyField(loaded.selectors, "selectors", pathFromRepoRoot),
      urlPatterns: normalizeDangerPolicyField(loaded.urlPatterns, "urlPatterns", pathFromRepoRoot),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load danger action policy '${pathFromRepoRoot}': ${detail}`);
  }
}

function normalizeScopeOrigins(domains: string[] | undefined, targetName: string): string[] {
  if (!domains || domains.length === 0) {
    return [];
  }
  const origins: string[] = [];
  for (const rawDomain of domains) {
    const domain = rawDomain.trim();
    if (domain.length === 0) {
      continue;
    }
    let parsedDomain: URL;
    try {
      parsedDomain = new URL(domain);
    } catch {
      throw new Error(`Invalid scope domain '${rawDomain}' for target '${targetName}'`);
    }
    if (parsedDomain.protocol !== "http:" && parsedDomain.protocol !== "https:") {
      throw new Error(
        `Invalid scope domain '${rawDomain}' for target '${targetName}'; only http/https are supported`,
      );
    }
    origins.push(parsedDomain.origin);
  }
  return Array.from(new Set(origins));
}

function isLocalhostHost(hostname: string): boolean {
  return LOCALHOST_HOSTS.has(hostname.toLowerCase());
}

export function normalizeBaseUrl(rawBaseUrl: string, targetName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid --base-url '${rawBaseUrl}' for target '${targetName}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid --base-url protocol '${parsed.protocol}' for target '${targetName}'; only http/https are supported`,
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const normalizedPath = pathname.length > 0 ? pathname : "";
  return `${parsed.origin}${normalizedPath}${parsed.search}`;
}

export function assertBaseUrlAllowed(
  target: TargetConfig,
  baseUrl: string,
  allowAllUrls = false,
): BaseUrlPolicyResult {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, target.name);
  const parsedUrl = new URL(normalizedBaseUrl);
  const requestedOrigin = parsedUrl.origin;
  if (target.type !== "web") {
    return {
      enabled: false,
      requestedUrl: normalizedBaseUrl,
      requestedOrigin,
      allowedOrigins: [],
      matched: true,
      reason: "non_web_target",
    };
  }

  const allowedOrigins = normalizeScopeOrigins(target.scope?.domains, target.name);
  if (allowAllUrls) {
    return {
      enabled: true,
      requestedUrl: normalizedBaseUrl,
      requestedOrigin,
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["*"],
      matched: true,
      reason: "allow_all_urls",
    };
  }

  if (target.scope?.allowLocalhostAnyPort === true) {
    if (!isLocalhostHost(parsedUrl.hostname)) {
      throw new Error(
        `Invalid --base-url hostname '${parsedUrl.hostname}' for target '${target.name}'; only localhost/127.0.0.1/::1 are allowed`,
      );
    }
    return {
      enabled: true,
      requestedUrl: normalizedBaseUrl,
      requestedOrigin,
      allowedOrigins: [
        "http://localhost:*",
        "http://127.0.0.1:*",
        "http://[::1]:*",
        "https://localhost:*",
        "https://127.0.0.1:*",
        "https://[::1]:*",
      ],
      matched: true,
      reason: "localhost_origin_allowed",
    };
  }

  if (allowedOrigins.length === 0) {
    throw new Error(
      `Target '${target.name}' must configure scope.domains or set scope.allowLocalhostAnyPort=true for web baseUrl policy (or pass --allow-all-urls).`,
    );
  }

  const matched = allowedOrigins.includes(requestedOrigin);
  if (!matched) {
    throw new Error(
      `Invalid --base-url origin '${requestedOrigin}' for target '${target.name}'; allowed origins: ${allowedOrigins.join(", ")}`,
    );
  }

  return {
    enabled: true,
    requestedUrl: normalizedBaseUrl,
    requestedOrigin,
    allowedOrigins,
    matched: true,
    reason: "origin_allowed",
  };
}

export function resolveExploreConfig(
  target: TargetConfig,
  profile: ProfileConfig,
  overrides?: RunOverrides,
): ExploreConfig {
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for explore`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
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
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for chaos`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
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
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for load`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
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
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for a11y`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
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
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for perf`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
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
  const effectiveBaseUrlRaw = overrides?.baseUrl ?? target.baseUrl;
  if (!effectiveBaseUrlRaw) {
    throw new Error(`Target '${target.name}' missing baseUrl for visual`);
  }
  const effectiveBaseUrl = normalizeBaseUrl(effectiveBaseUrlRaw, target.name);
  return {
    baseUrl: effectiveBaseUrl,
    targetName: target.name,
    mode: overrides?.visualMode ?? profileVisual.mode ?? targetVisual.mode ?? "diff",
    baselineDir: profileVisual.baselineDir ?? targetVisual.baselineDir,
    maxDiffPixels: profileVisual.maxDiffPixels ?? targetVisual.maxDiffPixels,
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
      profileSecurity.engine ??
      targetSecurity.engine ??
      (ORCHESTRATOR_ENV.CI ? "semgrep" : "builtin"),
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

export function buildStateModelSummary(
  targetType: string,
  profileSteps: string[],
  stateModel: ReturnType<typeof loadStateModel>,
  states: Manifest["states"],
  desktopResults: {
    desktopReadinessResult?: DesktopReadinessResult;
    desktopSmokeResult?: DesktopSmokeResult;
    desktopE2EResult?: DesktopE2EResult;
    desktopSoakResult?: DesktopSoakResult;
  },
): NonNullable<Manifest["stateModel"]> {
  if (targetType === "web") {
    return {
      modelType: "web",
      configuredRoutes: stateModel.configuredRoutes.length,
      configuredStories: stateModel.configuredStories.length,
      configuredTotal: stateModel.configuredTotal,
      capturedRoutes: states.filter((item) => item.source === "routes").length,
      capturedDiscovery: states.filter((item) => item.source === "discovery").length,
      capturedStories: states.filter((item) => item.source === "stories").length,
    };
  }

  const configuredDesktopScenarioIds = [
    profileSteps.includes("desktop_readiness") ? "desktop.readiness" : undefined,
    profileSteps.includes("desktop_smoke") ? "desktop.smoke" : undefined,
    profileSteps.includes("desktop_e2e") ? "desktop.e2e" : undefined,
    profileSteps.includes("desktop_soak") ? "desktop.soak" : undefined,
  ].filter((value): value is string => Boolean(value));

  const capturedDesktopScenarioIds = [
    desktopResults.desktopReadinessResult?.status === "passed" ? "desktop.readiness" : undefined,
    desktopResults.desktopSmokeResult?.status === "passed" ? "desktop.smoke" : undefined,
    desktopResults.desktopE2EResult?.status === "passed" ? "desktop.e2e" : undefined,
    desktopResults.desktopSoakResult?.status === "passed" ? "desktop.soak" : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    modelType: "desktop",
    configuredRoutes: 0,
    configuredStories: 0,
    configuredTotal: configuredDesktopScenarioIds.length,
    capturedRoutes: 0,
    capturedDiscovery: states.filter(
      (item) => item.source === "discovery" || item.source === "manual",
    ).length,
    capturedStories: 0,
    configuredDesktopScenarios: configuredDesktopScenarioIds.length,
    capturedDesktopScenarios: capturedDesktopScenarioIds.length,
    configuredDesktopScenarioIds,
    capturedDesktopScenarioIds,
  };
}
