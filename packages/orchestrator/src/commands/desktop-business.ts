import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { swiftActionReasonCode } from "../../../drivers/macos-xcuitest/src/index.js";
import { tauriActionReasonCode } from "../../../drivers/tauri-webdriver/src/index.js";
import { createDesktopLifecycleStrategy } from "./desktop-lifecycle.js";
import {
  DESKTOP_HOST_SAFETY_REASON_CODE,
  getWindowCount,
  isProcessRunning,
  requireOperatorManualDesktopAutomation,
  runChecked,
  sleep,
} from "./desktop-utils.js";

export type DesktopBusinessRegressionConfig = {
  targetType: string;
  app?: string;
  bundleId?: string;
  businessInteractionRequired?: boolean;
};

export type DesktopBusinessCheck = {
  id: string;
  status: "passed" | "blocked";
  detail: string;
  reasonCode?: string;
};

export type DesktopBusinessReplayStep = {
  id: string;
  category: "launch" | "activate" | "interaction" | "checkpoint" | "teardown";
  status: "passed" | "blocked";
  timestamp: string;
  detail: string;
  reasonCode?: string;
};

export type DesktopBusinessResult = {
  targetType: string;
  status: "passed" | "blocked";
  reasonCode?: string;
  checks: DesktopBusinessCheck[];
  screenshotPaths: string[];
  replay: DesktopBusinessReplayStep[];
  logPath: string;
  reportPath: string;
};

function shouldTreatAsBlocking(
  config: DesktopBusinessRegressionConfig,
  check: DesktopBusinessCheck,
): boolean {
  if (check.id !== "desktop.business.interaction") {
    return true;
  }
  return config.businessInteractionRequired !== false;
}

function resolveReasonCode(
  targetType: string,
  category: DesktopBusinessReplayStep["category"],
  detail: string,
): string {
  if (targetType === "swift") {
    return swiftActionReasonCode(category, detail);
  }
  return tauriActionReasonCode(category, detail);
}

function appendReplayStep(
  replay: DesktopBusinessReplayStep[],
  targetType: string,
  category: DesktopBusinessReplayStep["category"],
  id: string,
  shellResult: { ok: boolean; detail: string },
): DesktopBusinessReplayStep {
  const reasonCode = shellResult.ok
    ? undefined
    : resolveReasonCode(targetType, category, shellResult.detail);
  const step: DesktopBusinessReplayStep = {
    id,
    category,
    status: shellResult.ok ? "passed" : "blocked",
    timestamp: new Date().toISOString(),
    detail: shellResult.detail,
    reasonCode,
  };
  replay.push(step);
  return step;
}

export async function runDesktopBusinessRegression(
  baseDir: string,
  config: DesktopBusinessRegressionConfig,
): Promise<DesktopBusinessResult> {
  const reportPath = "reports/desktop-business.json";
  const logPath = "logs/desktop-business.log";
  const beforeShotPath = `screenshots/desktop-${config.targetType}-business-before.png`;
  const afterShotPath = `screenshots/desktop-${config.targetType}-business-after.png`;
  const screenshotPaths: string[] = [];
  const checks: DesktopBusinessCheck[] = [];
  const replay: DesktopBusinessReplayStep[] = [];
  const logs: string[] = [];
  mkdirSync(resolve(baseDir, "reports"), { recursive: true });
  mkdirSync(resolve(baseDir, "logs"), { recursive: true });
  mkdirSync(resolve(baseDir, "screenshots"), { recursive: true });

  const lifecycle = createDesktopLifecycleStrategy(config);
  if (!lifecycle.ok) {
    const detail =
      lifecycle.reasonCode === "desktop.tauri.app.missing"
        ? "target.app is required for tauri desktop business regression"
        : lifecycle.reasonCode === "desktop.swift.bundle.missing"
          ? "target.bundleId is required for swift desktop business regression"
          : `unsupported desktop business regression target: ${config.targetType}`;
    const blocked: DesktopBusinessResult = {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: lifecycle.reasonCode,
      checks: [
        {
          id: "desktop.business.bootstrap",
          status: "blocked",
          detail,
          reasonCode: lifecycle.reasonCode,
        },
      ],
      screenshotPaths,
      replay,
      logPath,
      reportPath,
    };
    writeFileSync(resolve(baseDir, logPath), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    writeFileSync(resolve(baseDir, reportPath), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    return blocked;
  }

  const guard = requireOperatorManualDesktopAutomation("desktop-business");
  if (!guard.ok) {
    const blocked: DesktopBusinessResult = {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: DESKTOP_HOST_SAFETY_REASON_CODE,
      checks: [
        {
          id: "desktop.business.host_safety",
          status: "blocked",
          detail: guard.detail,
          reasonCode: DESKTOP_HOST_SAFETY_REASON_CODE,
        },
      ],
      screenshotPaths,
      replay,
      logPath,
      reportPath,
    };
    writeFileSync(resolve(baseDir, logPath), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    writeFileSync(resolve(baseDir, reportPath), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    return blocked;
  }

  const launch = lifecycle.launch();
  appendReplayStep(replay, lifecycle.targetType, "launch", "desktop.business.launch", launch);
  checks.push({
    id: "desktop.business.launch",
    status: launch.ok ? "passed" : "blocked",
    detail: launch.detail,
    reasonCode: launch.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "launch", launch.detail),
  });
  logs.push(`[launch] ${launch.detail}`);

  await sleep(1800);
  const bundleId = lifecycle.resolveBundleId() ?? "";
  const activate = bundleId
    ? lifecycle.activate(bundleId, 30000)
    : {
        ok: false,
        detail: "bundleId missing, cannot activate deterministic business flow",
        stdout: "",
        stderr: "",
      };
  appendReplayStep(replay, lifecycle.targetType, "activate", "desktop.business.activate", activate);
  checks.push({
    id: "desktop.business.activate",
    status: activate.ok ? "passed" : "blocked",
    detail: activate.detail,
    reasonCode: activate.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "activate", activate.detail),
  });
  logs.push(`[activate] ${activate.detail}`);

  const beforeShot = runChecked("screencapture", ["-x", resolve(baseDir, beforeShotPath)]);
  appendReplayStep(
    replay,
    lifecycle.targetType,
    "checkpoint",
    "desktop.business.checkpoint.before",
    beforeShot,
  );
  checks.push({
    id: "desktop.business.checkpoint.before",
    status: beforeShot.ok ? "passed" : "blocked",
    detail: beforeShot.detail,
    reasonCode: beforeShot.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "checkpoint", beforeShot.detail),
  });
  if (beforeShot.ok) {
    screenshotPaths.push(beforeShotPath);
  }
  logs.push(`[checkpoint.before] ${beforeShot.detail}`);

  const interaction = {
    ok: false,
    detail: "desktop business interaction now requires a future host-safe operator workflow",
  };
  appendReplayStep(
    replay,
    lifecycle.targetType,
    "interaction",
    "desktop.business.interaction",
    interaction,
  );
  checks.push({
    id: "desktop.business.interaction",
    status: interaction.ok ? "passed" : "blocked",
    detail: interaction.detail,
    reasonCode: interaction.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "interaction", interaction.detail),
  });
  logs.push(`[interaction] ${interaction.detail}`);

  await sleep(800);
  const appName =
    lifecycle.targetType === "tauri" ? lifecycle.appName : lifecycle.resolveAppName(bundleId);
  const running = appName ? isProcessRunning(appName) : false;
  const windows = appName ? getWindowCount(appName) : undefined;
  const stateHealthy = running && (windows === undefined || windows > 0);
  checks.push({
    id: "desktop.business.state",
    status: stateHealthy ? "passed" : "blocked",
    detail: `running=${running}; window_count=${windows ?? "unknown"}`,
    reasonCode: stateHealthy
      ? undefined
      : `${lifecycle.targetType === "swift" ? "desktop.swift" : "desktop.tauri"}.business.state_invalid`,
  });
  logs.push(`[state] running=${running}; window_count=${windows ?? "unknown"}`);

  const afterShot = runChecked("screencapture", ["-x", resolve(baseDir, afterShotPath)]);
  appendReplayStep(
    replay,
    lifecycle.targetType,
    "checkpoint",
    "desktop.business.checkpoint.after",
    afterShot,
  );
  checks.push({
    id: "desktop.business.checkpoint.after",
    status: afterShot.ok ? "passed" : "blocked",
    detail: afterShot.detail,
    reasonCode: afterShot.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "checkpoint", afterShot.detail),
  });
  if (afterShot.ok) {
    screenshotPaths.push(afterShotPath);
  }
  logs.push(`[checkpoint.after] ${afterShot.detail}`);

  const quit = lifecycle.quit({
    bundleId,
    appName,
    timeoutMs: 30000,
    resolveAppNameFallback: true,
    attemptForceKill: true,
  });
  appendReplayStep(replay, lifecycle.targetType, "teardown", "desktop.business.quit", quit);
  checks.push({
    id: "desktop.business.quit",
    status: quit.ok ? "passed" : "blocked",
    detail: quit.detail,
    reasonCode: quit.ok
      ? undefined
      : resolveReasonCode(lifecycle.targetType, "teardown", quit.detail),
  });
  logs.push(`[teardown] ${quit.detail}`);

  const blockingChecks = checks.filter((check) => shouldTreatAsBlocking(config, check));
  const firstBlocked = blockingChecks.find((check) => check.status === "blocked");
  const result: DesktopBusinessResult = {
    targetType: config.targetType,
    status: blockingChecks.every((check) => check.status === "passed") ? "passed" : "blocked",
    reasonCode: firstBlocked?.reasonCode,
    checks,
    screenshotPaths,
    replay,
    logPath,
    reportPath,
  };

  writeFileSync(resolve(baseDir, logPath), `${logs.join("\n")}\n`, "utf8");
  writeFileSync(resolve(baseDir, reportPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
