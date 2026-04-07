import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDesktopLifecycleStrategy } from "./desktop-lifecycle.js";
import {
  requireOperatorManualDesktopAutomation,
  runChecked,
  sleep,
} from "./desktop-utils.js";

export type DesktopSmokeConfig = {
  targetType: string;
  app?: string;
  bundleId?: string;
};

export type DesktopSmokeResult = {
  targetType: string;
  status: "passed" | "blocked";
  reasonCode?: string;
  started: boolean;
  activated: boolean;
  screenshotPath?: string;
  quit: boolean;
  detail: string;
  reportPath: string;
};

function writeReport(
  baseDir: string,
  reportPath: string,
  result: DesktopSmokeResult,
): DesktopSmokeResult {
  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}

export async function runDesktopSmoke(
  baseDir: string,
  config: DesktopSmokeConfig,
): Promise<DesktopSmokeResult> {
  const screenshotRelative = `screenshots/desktop-${config.targetType}-smoke.png`;
  const screenshotAbs = resolve(baseDir, screenshotRelative);
  const reportPath = "metrics/desktop-smoke.json";

  let started = false;
  let activated = false;
  let quit = false;

  const lifecycle = createDesktopLifecycleStrategy(config);
  if (!lifecycle.ok) {
    const detail =
      lifecycle.reasonCode === "desktop.tauri.app.missing"
        ? "target.app is required for tauri desktop_smoke"
        : lifecycle.reasonCode === "desktop.swift.bundle.missing"
          ? "target.bundleId is required for swift desktop_smoke"
          : `desktop_smoke unsupported for target.type=${config.targetType}`;
    return writeReport(baseDir, reportPath, {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: lifecycle.reasonCode,
      started,
      activated,
      quit,
      detail,
      reportPath,
    });
  }

  const guard = requireOperatorManualDesktopAutomation("desktop-smoke");
  if (!guard.ok) {
    return writeReport(baseDir, reportPath, {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: guard.reasonCode,
      started,
      activated,
      quit,
      detail: guard.detail,
      reportPath,
    });
  }

  const launch = lifecycle.launch();
  if (!launch.ok) {
    return writeReport(baseDir, reportPath, {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: "desktop.smoke.launch_failed",
      started,
      activated,
      quit,
      detail: launch.detail,
      reportPath,
    });
  }
  started = true;
  await sleep(2000);

  const bundleId = lifecycle.resolveBundleId();
  if (lifecycle.targetType === "tauri" && !bundleId) {
    return writeReport(baseDir, reportPath, {
      targetType: config.targetType,
      status: "blocked",
      reasonCode: "desktop.tauri.bundle.lookup_failed",
      started,
      activated,
      quit,
      detail: `unable to resolve bundle identifier from app: ${config.app}`,
      reportPath,
    });
  }

  if (bundleId) {
    const activate = lifecycle.activate(bundleId);
    if (activate.ok) {
      activated = true;
    }
  }
  await sleep(1200);

  const capture = runChecked("screencapture", ["-x", screenshotAbs]);
  quit = lifecycle.quit({
    bundleId,
    appName: lifecycle.appName,
    resolveAppNameFallback: lifecycle.targetType === "swift",
    attemptForceKill: true,
  }).ok;

  const passed = capture.ok && quit;
  const result: DesktopSmokeResult = {
    targetType: config.targetType,
    status: passed ? "passed" : "blocked",
    reasonCode: passed
      ? undefined
      : !capture.ok
        ? "desktop.smoke.screenshot_failed"
        : "desktop.smoke.quit_failed",
    started,
    activated,
    screenshotPath: capture.ok ? screenshotRelative : undefined,
    quit,
    detail: passed
      ? `${lifecycle.targetType} smoke completed`
      : !capture.ok
        ? capture.detail
        : `${lifecycle.targetType} smoke quit failed`,
    reportPath,
  };
  return writeReport(baseDir, reportPath, result);
}
