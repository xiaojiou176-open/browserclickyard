export type ManifestGateCheck = {
  id: string;
  acId?: string;
  expected: number | string;
  actual: number | string;
  severity: "BLOCKER" | "MAJOR" | "MINOR";
  status: "passed" | "failed" | "blocked";
  reasonCode?: string;
  evidencePath: string;
};

export type ManifestProof = {
  coveragePath: string;
  stabilityPath: string;
  gapsPath: string;
  reproPath: string;
  summary: {
    configuredCoverageRatio: number;
    gatePassRatio: number;
    stabilityStatus: "stable" | "degraded" | "failed";
  };
};

export type ManifestEvidenceItem = {
  id: string;
  source: "state" | "report" | "gate" | "diagnostic";
  kind:
    | "screenshot"
    | "dom"
    | "trace"
    | "network"
    | "log"
    | "video"
    | "report"
    | "metric"
    | "other";
  path: string;
};

export type ManifestCacheStats =
  | {
      hit: number;
      miss: number;
      hitRate: number;
      hits?: number;
      misses?: number;
    }
  | {
      hits: number;
      misses: number;
      hitRate: number;
      hit?: number;
      miss?: number;
    };

export type Manifest = {
  schemaVersion?: "1.1";
  schemaCompatibility?: "v1.1" | "legacy_v1";
  runId: string;
  target: Record<string, string> & { type: string; name: string };
  profile: string;
  git: { branch: string; commit: string; dirty: boolean };
  timing: { startedAt: string; finishedAt: string; durationMs: number };
  execution?: {
    maxParallelTasks: number;
    stagesMs: Record<string, number>;
    criticalPath: string[];
  };
  states: Array<Record<string, unknown>>;
  evidenceIndex: ManifestEvidenceItem[];
  reports: Record<string, string> & {
    fixPlan?: string;
    fixResult?: string;
    postFixRegression?: string;
  };
  stateModel?: {
    modelType?: "web" | "desktop";
    configuredRoutes: number;
    configuredStories: number;
    configuredTotal: number;
    capturedRoutes: number;
    capturedDiscovery: number;
    capturedStories: number;
    configuredDesktopScenarios?: number;
    capturedDesktopScenarios?: number;
    configuredDesktopScenarioIds?: string[];
    capturedDesktopScenarioIds?: string[];
  };
  summary: {
    consoleError: number;
    pageError: number;
    http5xx: number;
    highVuln?: number;
    a11ySerious?: number;
    perfLcpMs?: number;
    perfFcpMs?: number;
    visualDiffPixels?: number;
    loadFailedRequests?: number;
    loadP95Ms?: number;
    loadRps?: number;
    dangerousActionHits?: number;
    aiReviewFindings?: number;
    aiReviewHighOrAbove?: number;
    engineAvailability?: Record<string, "available" | "missing" | "not_checked">;
    blockedByMissingEngineCount?: number;
    aiModel?: string;
    promptVersion?: string;
    fixIterations?: number;
    fixConverged?: boolean;
    cacheStats?: ManifestCacheStats;
    computerUseSafetyConfirmations?: number;
  };
  diagnostics?: {
    capture?: {
      consoleErrors: string[];
      pageErrors: string[];
      http5xxUrls: string[];
      truncation?: {
        consoleErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        pageErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        http5xxUrls: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
      };
    };
    explore?: {
      engineUsed?: "builtin" | "crawlee";
      consoleErrors: string[];
      pageErrors: string[];
      http5xxUrls: string[];
      truncation?: {
        consoleErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        pageErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        http5xxUrls: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
      };
    };
    chaos?: {
      consoleErrors: string[];
      pageErrors: string[];
      http5xxUrls: string[];
      truncation?: {
        consoleErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        pageErrors: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
        http5xxUrls: {
          originalCount: number;
          uniqueCount: number;
          keptCount: number;
          truncated: boolean;
        };
      };
    };
    load?: {
      totalRequests: number;
      failedRequests: number;
      http5xx: number;
      requestsPerSecond: number;
      engines?: Array<{
        engine: "builtin" | "artillery" | "k6";
        status: "ok" | "failed" | "blocked";
        detail: string;
        requestsPerSecond?: number;
        p95Ms?: number;
        failedRequests?: number;
      }>;
    };
    tests?: {
      unit?: Record<string, unknown>;
      contract?: Record<string, unknown>;
      ct?: Record<string, unknown>;
      e2e?: Record<string, unknown>;
    };
    runtime?: {
      autostart: boolean;
      started: boolean;
      healthcheckPassed: boolean;
      healthcheckUrl?: string;
      processes?: Array<{ key: string; command: string; pid: number }>;
    };
    a11y?: {
      engine: string;
      standard: string;
      counts: {
        critical: number;
        serious: number;
        moderate: number;
        minor: number;
        total: number;
      };
    };
    perf?: {
      engine: string;
      preset: string;
      fallbackUsed?: boolean;
      metricsCompleteness?: "full_lhci" | "builtin_partial";
      metrics: {
        ttfbMs: number;
        domContentLoadedMs: number;
        loadEventMs: number;
        firstPaintMs: number;
        firstContentfulPaintMs: number;
        largestContentfulPaintMs: number;
        jsHeapUsedMb: number;
      };
    };
    visual?: {
      engine: string;
      engineUsed?: "builtin" | "lostpixel" | "backstop";
      mode: string;
      baselineCreated: boolean;
      diffPixels: number;
      totalPixels: number;
      diffRatio: number;
      baselinePath: string;
      currentPath: string;
      diffPath?: string;
    };
    aiReview?: {
      enabled: boolean;
      maxArtifacts: number;
      severityThreshold: "critical" | "high" | "medium" | "low";
      findings: number;
      highOrAbove: number;
      reportPath: string;
      markdownPath?: string;
    };
    security?: {
      executionStatus?: "ok" | "failed" | "blocked";
      blockedReason?: string;
      errorMessage?: string;
      totalIssueCount?: number;
      dedupedIssueCount?: number;
      ticketCount?: number;
      topTickets?: Array<{
        ticketId: string;
        severity: "BLOCKER" | "MAJOR" | "MINOR";
        impactScope: string;
        affectedFileCount: number;
      }>;
      highVulnCount: number;
      mediumVulnCount: number;
      lowVulnCount: number;
      clusters?: {
        byRule: Array<{
          id: string;
          key: string;
          severity: "HIGH" | "MEDIUM" | "LOW";
          count: number;
          sampleIssueId: string;
        }>;
        byComponent: Array<{
          id: string;
          key: string;
          severity: "HIGH" | "MEDIUM" | "LOW";
          count: number;
          sampleIssueId: string;
        }>;
      };
    };
    desktopReadiness?: {
      targetType: string;
      status: "passed" | "blocked";
      checks: Array<{ id: string; status: "passed" | "blocked"; detail: string }>;
      reportPath: string;
    };
    desktopSmoke?: {
      targetType: string;
      status: "passed" | "blocked";
      started: boolean;
      activated: boolean;
      screenshotPath?: string;
      quit: boolean;
      detail: string;
      reportPath: string;
    };
    desktopE2E?: {
      targetType: string;
      status: "passed" | "blocked";
      checks: Array<{ id: string; status: "passed" | "blocked"; detail: string }>;
      screenshotPath?: string;
      reportPath: string;
    };
    desktopBusiness?: {
      targetType: string;
      status: "passed" | "blocked";
      checks: Array<{ id: string; status: "passed" | "blocked"; detail: string }>;
      screenshotPaths: string[];
      replay: Array<{
        id: string;
        category: "launch" | "activate" | "interaction" | "checkpoint" | "teardown";
        status: "passed" | "blocked";
        timestamp: string;
        detail: string;
        reasonCode?: string;
      }>;
      logPath: string;
      reportPath: string;
    };
    desktopSoak?: {
      targetType: string;
      status: "passed" | "blocked";
      durationSeconds: number;
      intervalSeconds: number;
      appName?: string;
      crashCount: number;
      rssGrowthMb?: number;
      rssMaxMb?: number;
      cpuAvgPercent?: number;
      samples: Array<{ timestamp: string; running: boolean; rssMb?: number; cpuPercent?: number }>;
      reportPath: string;
    };
    http5xxUrls?: string[];
    truncation?: {
      http5xxUrls: {
        originalCount: number;
        uniqueCount: number;
        keptCount: number;
        truncated: boolean;
      };
    };
    execution?: {
      maxParallelTasks: number;
      stagesMs: Record<string, number>;
      criticalPath: string[];
    };
    engineAvailability?: Record<string, "available" | "missing" | "not_checked">;
  };
  runEnvironment?: {
    autostart: boolean;
    started: boolean;
    healthcheckPassed: boolean;
    healthcheckUrl: string;
    healthcheckReason?: string;
    healthcheckDetail?: string;
    host: string;
    node: string;
    ci: boolean;
  };
  toolVersions?: {
    node: string;
    a11y: string;
    perf: string;
    load: string[];
    security: string;
  };
  proof?: ManifestProof;
  gateResults: {
    status: "passed" | "failed" | "blocked";
    checks: ManifestGateCheck[];
  };
  toolchain: Record<string, unknown> & { node: string };
};
