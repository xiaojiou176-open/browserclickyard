import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChaosEventRatio } from "../chaos.js";

type JsonSchemaNode = {
  properties?: Record<string, JsonSchemaNode>;
};

const PROFILE_SCHEMA_REGISTRY_FILE = "configs/schemas/profile.v1.schema.json";
const TARGET_SCHEMA_REGISTRY_FILE = "configs/schemas/target.v1.schema.json";

function normalizeRegistryValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function loadSchemaFromRegistry(filePath: string): JsonSchemaNode | null {
  const absolutePath = resolve(process.cwd(), filePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8")) as JsonSchemaNode;
  } catch {
    return null;
  }
}

function readSchemaPropertyKeys(
  schema: JsonSchemaNode | null,
  propertyPath: readonly string[],
): string[] | null {
  if (!schema) {
    return null;
  }
  let cursor: JsonSchemaNode | undefined = schema;
  for (const key of propertyPath) {
    cursor = cursor?.properties?.[key];
    if (!cursor) {
      return null;
    }
  }
  const keys = cursor.properties ? Object.keys(cursor.properties) : [];
  return keys.length > 0 ? normalizeRegistryValues(keys) : null;
}

function createRegisteredSet(
  registryValues: readonly string[] | null,
  fallbackValues: readonly string[],
): Set<string> {
  if (!registryValues || registryValues.length === 0) {
    return new Set(fallbackValues);
  }
  return new Set([...registryValues, ...fallbackValues]);
}

const PROFILE_SCHEMA_REGISTRY = loadSchemaFromRegistry(PROFILE_SCHEMA_REGISTRY_FILE);
const TARGET_SCHEMA_REGISTRY = loadSchemaFromRegistry(TARGET_SCHEMA_REGISTRY_FILE);

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
  "drop",
  "destroy",
  "pay",
  "payment",
  "purchase",
  "checkout",
  "transfer",
  "submit",
  "send",
  "commit",
  "删除",
  "移除",
  "支付",
  "付款",
  "购买",
  "下单",
  "转账",
  "提交",
  "发送",
];
export const DEFAULT_DIAGNOSTIC_MAX_ITEMS = 20;
export const DEFAULT_DANGER_POLICY_FILE = "configs/danger-action-policy.yaml";
export const TOOLCHAIN_VERSION = process.env.npm_package_version ?? "0.1.0";
export const DEFAULT_MAX_PARALLEL_TASKS = 4;
export const PR_GATE_BUDGET_MS = 15 * 60 * 1000;
export const CONFIG_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const FALLBACK_CROSS_TARGET_KEY_GATE_CHECK_IDS = [
  "runtime.healthcheck",
  "test.unit",
  "test.contract",
  "test.ct",
  "test.e2e",
  "scenario.computer_use",
  "a11y.serious_max",
  "perf.lcp_ms_max",
  "perf.fcp_ms_max",
  "visual.diff_pixels_max",
  "load.failed_requests",
  "load.p95_ms",
  "load.rps_min",
  "security.high_vuln",
  "desktop.readiness",
  "desktop.smoke",
  "desktop.e2e",
  "desktop.business_regression",
  "desktop.soak",
];

export const CROSS_TARGET_KEY_GATE_CHECK_IDS = createRegisteredSet(
  null,
  FALLBACK_CROSS_TARGET_KEY_GATE_CHECK_IDS,
);

const FALLBACK_PROFILE_ALLOWED_KEYS = [
  "name",
  "steps",
  "geminiAccuracyMin",
  "geminiParallelConsistencyMin",
  "geminiSampleSizeMin",
  "gates",
  "tests",
  "determinism",
  "diagnostics",
  "explore",
  "chaos",
  "a11y",
  "perf",
  "visual",
  "load",
  "security",
  "desktopSoak",
  "desktopE2E",
  "aiReview",
  "computerUse",
  "enginePolicy",
];

export const PROFILE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, []),
  FALLBACK_PROFILE_ALLOWED_KEYS,
);

const FALLBACK_TARGET_ALLOWED_KEYS = [
  "name",
  "type",
  "driver",
  "geminiAccuracyMin",
  "geminiParallelConsistencyMin",
  "geminiSampleSizeMin",
  "baseUrl",
  "start",
  "healthcheck",
  "scope",
  "app",
  "bundleId",
  "explore",
  "chaos",
  "diagnostics",
  "a11y",
  "perf",
  "visual",
  "load",
  "security",
  "desktopSoak",
  "aiReview",
  "computerUse",
];

export const TARGET_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, []),
  FALLBACK_TARGET_ALLOWED_KEYS,
);

const FALLBACK_PROFILE_GATES_ALLOWED_KEYS = [
  "consoleErrorMax",
  "pageErrorMax",
  "http5xxMax",
  "contractStatus",
  "dangerousActionHitsMax",
  "securityHighVulnMax",
  "a11ySeriousMax",
  "perfLcpMsMax",
  "perfFcpMsMax",
  "visualDiffPixelsMax",
  "loadFailedRequestsMax",
  "loadP95MsMax",
  "loadRpsMin",
  "flakeRateMax",
];

export const PROFILE_GATES_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["gates"]),
  FALLBACK_PROFILE_GATES_ALLOWED_KEYS,
);

export const PROFILE_TESTS_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["tests"]),
  ["e2eSuite"],
);
export const PROFILE_EXPLORE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["explore"]),
  ["engine", "budgetSeconds", "maxDepth", "maxStates", "seed", "denylist", "policyFile"],
);
export const PROFILE_DETERMINISM_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["determinism"]),
  ["timezone", "locale", "seed", "disableAnimations", "reducedMotion"],
);
export const PROFILE_A11Y_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["a11y"]),
  ["standard", "maxIssues", "engine"],
);
export const PROFILE_PERF_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["perf"]),
  ["preset", "engine"],
);
export const PROFILE_VISUAL_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["visual"]),
  ["engine", "mode", "baselineDir", "maxDiffPixels"],
);
export const PROFILE_LOAD_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["load"]),
  ["vus", "durationSeconds", "requestTimeoutMs", "engines"],
);
export const PROFILE_SECURITY_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["security"]),
  ["engine", "maxFileSizeKb", "includeExtensions", "excludeDirs", "rulesFile"],
);
export const PROFILE_AI_REVIEW_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["aiReview"]),
  ["enabled", "maxArtifacts", "emitIssue", "emitPrComment", "severityThreshold"],
);
export const PROFILE_COMPUTER_USE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["computerUse"]),
  ["enabled", "task", "maxSteps", "speedMode"],
);
export const PROFILE_DESKTOP_SOAK_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["desktopSoak"]),
  ["durationSeconds", "intervalSeconds", "gates"],
);
export const PROFILE_DESKTOP_SOAK_GATES_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["desktopSoak", "gates"]),
  ["rssGrowthMbMax", "cpuAvgPercentMax", "crashCountMax"],
);
export const PROFILE_DESKTOP_E2E_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["desktopE2E"]),
  ["keyboardInteractionRequired"],
);
export const PROFILE_ENGINE_POLICY_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["enginePolicy"]),
  ["required", "failOnBlocked"],
);
export const PROFILE_CHAOS_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["chaos"]),
  ["seed", "budgetSeconds", "eventRatio"],
);
export const PROFILE_CHAOS_RATIO_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["chaos", "eventRatio"]),
  ["click", "input", "scroll", "keyboard"],
);
export const PROFILE_DIAGNOSTICS_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(PROFILE_SCHEMA_REGISTRY, ["diagnostics"]),
  ["maxItems"],
);

export const TARGET_SCOPE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["scope"]),
  ["domains", "allowLocalhostAnyPort"],
);
export const TARGET_START_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["start"]),
  ["web", "api"],
);
export const TARGET_HEALTHCHECK_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["healthcheck"]),
  ["url"],
);
export const TARGET_EXPLORE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["explore"]),
  ["engine", "budgetSeconds", "maxDepth", "maxStates", "seed", "denylist", "policyFile"],
);
export const TARGET_CHAOS_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["chaos"]),
  ["seed", "budgetSeconds", "eventRatio"],
);
export const TARGET_CHAOS_RATIO_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["chaos", "eventRatio"]),
  ["click", "input", "scroll", "keyboard"],
);
export const TARGET_DIAGNOSTICS_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["diagnostics"]),
  ["maxItems"],
);
export const TARGET_A11Y_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["a11y"]),
  ["standard", "maxIssues", "engine"],
);
export const TARGET_PERF_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["perf"]),
  ["preset", "engine"],
);
export const TARGET_VISUAL_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["visual"]),
  ["engine", "mode", "baselineDir", "maxDiffPixels"],
);
export const TARGET_LOAD_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["load"]),
  ["vus", "durationSeconds", "requestTimeoutMs", "engines"],
);
export const TARGET_SECURITY_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["security"]),
  ["engine", "maxFileSizeKb", "includeExtensions", "excludeDirs", "rulesFile"],
);
export const TARGET_AI_REVIEW_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["aiReview"]),
  ["enabled", "maxArtifacts", "emitIssue", "emitPrComment", "severityThreshold"],
);
export const TARGET_COMPUTER_USE_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["computerUse"]),
  ["enabled", "task", "maxSteps", "speedMode"],
);
export const TARGET_DESKTOP_SOAK_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["desktopSoak"]),
  ["durationSeconds", "intervalSeconds", "gates"],
);
export const TARGET_DESKTOP_SOAK_GATES_ALLOWED_KEYS = createRegisteredSet(
  readSchemaPropertyKeys(TARGET_SCHEMA_REGISTRY, ["desktopSoak", "gates"]),
  ["rssGrowthMbMax", "cpuAvgPercentMax", "crashCountMax"],
);
