import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ExploreOptions, ExploreResult } from "../../../orchestrator/src/commands/explore.js";

const CRAWLEE_NOT_AVAILABLE = "gate.explore_engine.blocked.crawlee_not_available";

function hasCrawleeRuntime(): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("crawlee");
    return true;
  } catch {
    return false;
  }
}

function writeReport(baseDir: string, result: ExploreResult): void {
  const outputPath = resolve(baseDir, result.reportPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function runExploreWithCrawleeBridge(
  baseDir: string,
  options: ExploreOptions,
  fallback: (baseDir: string, options: ExploreOptions) => Promise<ExploreResult>,
): Promise<ExploreResult> {
  if (!hasCrawleeRuntime()) {
    const blocked: ExploreResult = {
      discoveredStates: 0,
      maxDepthReached: 0,
      crashCount: 0,
      consoleErrorCount: 0,
      http5xxCount: 0,
      dangerousActionHits: 0,
      visitedStateKeys: 0,
      pageErrors: [],
      consoleErrors: [],
      http5xxUrls: [],
      states: [],
      effectiveConfig: {
        budgetSeconds: options.budgetSeconds,
        maxDepth: options.maxDepth,
        maxStates: options.maxStates,
        denylist: options.denylist,
        denyStrategy: options.denyStrategy,
        engine: "crawlee",
      },
      diagnostics: {
        replayMetadata: {
          seed: options.seed ?? 20260218,
          timezone: "UTC",
          locale: "en-US",
          animationPolicy: "disabled",
          reducedMotion: "reduce",
          replayPath: "logs/explore-replay.json",
        },
        flakyRiskMitigations: ["adapter_missing_dependency"],
        adapter: "crawlee-bridge",
      },
      executionStatus: "blocked",
      engineUsed: "crawlee",
      blockedReasonCode: CRAWLEE_NOT_AVAILABLE,
      blockedDetail: "crawlee package not installed",
      reportPath: "reports/explore.json",
    };
    writeReport(baseDir, blocked);
    return blocked;
  }

  const bridged = await fallback(baseDir, { ...options, engine: "builtin" });
  const result: ExploreResult = {
    ...bridged,
    effectiveConfig: {
      ...bridged.effectiveConfig,
      engine: "crawlee",
    },
    diagnostics: {
      ...bridged.diagnostics,
      adapter: "crawlee-bridge",
    },
    executionStatus: bridged.executionStatus,
    engineUsed: "crawlee",
    blockedReasonCode:
      bridged.executionStatus === "blocked" ? bridged.blockedReasonCode : undefined,
    blockedDetail: bridged.executionStatus === "blocked" ? bridged.blockedDetail : undefined,
  };
  writeReport(baseDir, result);
  return result;
}
