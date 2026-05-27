import type { ChaosEventRatio } from "../chaos.js";
import type { DangerActionPolicy } from "../explore.js";
import type { GateThresholds } from "../report.js";

export type ProfileConfig = {
  name: string;
  steps: string[];
  geminiAccuracyMin?: number;
  geminiParallelConsistencyMin?: number;
  geminiSampleSizeMin?: number;
  gates?: GateThresholds;
  tests?: {
    e2eSuite?: "smoke" | "regression" | "full";
  };
  determinism?: {
    timezone?: string;
    locale?: string;
    seed?: number;
    disableAnimations?: boolean;
    reducedMotion?: "reduce" | "no-preference";
  };
  explore?: {
    engine?: "builtin" | "crawlee";
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
    engine?: "builtin" | "lostpixel" | "backstop";
    mode?: "diff" | "update";
    baselineDir?: string;
    maxDiffPixels?: number;
  };
  aiReview?: {
    enabled?: boolean;
    maxArtifacts?: number;
    emitIssue?: boolean;
    emitPrComment?: boolean;
    severityThreshold?: "critical" | "high" | "medium" | "low";
  };
  computerUse?: {
    enabled?: boolean;
    task?: string;
    maxSteps?: number;
    speedMode?: boolean;
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
  desktopE2E?: {
    keyboardInteractionRequired?: boolean;
  };
  enginePolicy?: {
    required?: Array<"crawlee" | "lostpixel" | "backstop" | "semgrep" | "k6">;
    failOnBlocked?: boolean;
  };
};

export type TargetConfig = {
  name: string;
  type: "web" | "tauri" | "swift";
  driver: string;
  geminiAccuracyMin?: number;
  geminiParallelConsistencyMin?: number;
  geminiSampleSizeMin?: number;
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
    engine?: "builtin" | "crawlee";
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
    engine?: "builtin" | "lostpixel" | "backstop";
    mode?: "diff" | "update";
    baselineDir?: string;
    maxDiffPixels?: number;
  };
  aiReview?: {
    enabled?: boolean;
    maxArtifacts?: number;
    emitIssue?: boolean;
    emitPrComment?: boolean;
    severityThreshold?: "critical" | "high" | "medium" | "low";
  };
  computerUse?: {
    enabled?: boolean;
    task?: string;
    maxSteps?: number;
    speedMode?: boolean;
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

export type ExploreConfig = {
  engine: "builtin" | "crawlee";
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

export type AiReviewConfig = {
  enabled: boolean;
  maxArtifacts: number;
  emitIssue: boolean;
  emitPrComment: boolean;
  severityThreshold: "critical" | "high" | "medium" | "low";
};

export type ComputerUseConfig = {
  enabled: boolean;
  task?: string;
  maxSteps?: number;
  speedMode?: boolean;
  taskSource?: "profile" | "target" | "env";
};

export type RunOverrides = {
  baseUrl?: string;
  allowAllUrls?: boolean;
  app?: string;
  bundleId?: string;
  computerUseTask?: string;
  computerUseMaxSteps?: number;
  computerUseSpeedMode?: boolean;
  diagnosticsMaxItems?: number;
  exploreBudgetSeconds?: number;
  exploreMaxDepth?: number;
  exploreMaxStates?: number;
  exploreEngine?: "builtin" | "crawlee";
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
  visualEngine?: "builtin" | "lostpixel" | "backstop";
  visualMode?: "diff" | "update";
  aiReview?: boolean;
  aiReviewMaxArtifacts?: number;
  soakDurationSeconds?: number;
  soakIntervalSeconds?: number;
  autostartTarget?: boolean;
};

export type ComputerUseRuntimeConfig = {
  enabled: boolean;
  task?: string;
  maxSteps?: number;
  speedMode?: boolean;
  taskSource?: "profile" | "target" | "env";
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

export type BlockedStepDetail = {
  stepId: string;
  reasonCode: string;
  detail: string;
  artifactPath: string;
};

export type FailureLocation = {
  checkId: string;
  status: "failed" | "blocked";
  reasonCode: string;
  stepId: string;
  artifactPath: string;
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
