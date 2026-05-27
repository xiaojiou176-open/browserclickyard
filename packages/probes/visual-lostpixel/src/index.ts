import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { VisualConfig, VisualResult } from "../../../orchestrator/src/commands/visual.js";

const LOSTPIXEL_NOT_AVAILABLE = "gate.visual_engine.blocked.lostpixel_not_available";

function hasLostPixelRuntime(): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("lost-pixel");
    return true;
  } catch {
    return false;
  }
}

function writeReport(baseDir: string, result: VisualResult): void {
  const outputPath = resolve(baseDir, result.reportPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function runVisualWithLostPixelBridge(
  baseDir: string,
  config: VisualConfig,
  fallback: (baseDir: string, config: VisualConfig) => Promise<VisualResult>,
): Promise<VisualResult> {
  if (!hasLostPixelRuntime()) {
    const blocked: VisualResult = {
      engine: "lostpixel-bridge",
      engineUsed: "lostpixel",
      executionStatus: "blocked",
      blockedReasonCode: LOSTPIXEL_NOT_AVAILABLE,
      blockedDetail: "lost-pixel package not installed",
      url: config.baseUrl,
      mode: config.mode,
      baselineCreated: false,
      baselinePath: "",
      currentPath: "",
      diffPath: undefined,
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      reportPath: "visual/report.json",
    };
    writeReport(baseDir, blocked);
    return blocked;
  }

  const bridged = await fallback(baseDir, { ...config, engine: "builtin" });
  const result: VisualResult = {
    ...bridged,
    engine: "lostpixel-bridge",
    engineUsed: "lostpixel",
    executionStatus: bridged.executionStatus,
    blockedReasonCode:
      bridged.executionStatus === "blocked" ? bridged.blockedReasonCode : undefined,
    blockedDetail: bridged.executionStatus === "blocked" ? bridged.blockedDetail : undefined,
  };
  writeReport(baseDir, result);
  return result;
}
