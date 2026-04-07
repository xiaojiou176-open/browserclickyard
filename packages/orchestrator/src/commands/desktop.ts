import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkSwiftBundle, checkXcodebuild } from "../../../drivers/macos-xcuitest/src/index.js";
import {
  checkDesktopCommand,
  checkDesktopHost,
  checkTauriAppPath,
  checkTauriDriverBinary,
} from "../../../drivers/tauri-webdriver/src/index.js";

export type DesktopReadinessConfig = {
  targetType: string;
  app?: string;
  bundleId?: string;
};

export type DesktopReadinessResult = {
  targetType: string;
  status: "passed" | "blocked";
  checks: Array<{
    id: string;
    status: "passed" | "blocked";
    detail: string;
    reasonCode?: string;
  }>;
  reasonCode?: string;
  reportPath: string;
};

export function runDesktopReadiness(
  baseDir: string,
  config: DesktopReadinessConfig,
): DesktopReadinessResult {
  const checks: DesktopReadinessResult["checks"] = [];

  if (config.targetType === "tauri") {
    checks.push(checkDesktopHost());
    checks.push(checkDesktopCommand("open"));
    checks.push(checkDesktopCommand("screencapture"));
    checks.push(checkTauriAppPath(config.app));
    checks.push(checkTauriDriverBinary());
  } else if (config.targetType === "swift") {
    checks.push(checkDesktopHost());
    checks.push(checkDesktopCommand("open"));
    checks.push(checkDesktopCommand("screencapture"));
    checks.push(checkSwiftBundle(config.bundleId));
    checks.push(checkXcodebuild());
  } else {
    checks.push({
      id: "desktop.unsupported_target_type",
      status: "blocked",
      detail: `desktop readiness only supports tauri/swift, got ${config.targetType}`,
    });
  }

  const status: "passed" | "blocked" = checks.every((c) => c.status === "passed")
    ? "passed"
    : "blocked";
  const firstBlocked = checks.find((c) => c.status === "blocked");
  const result: DesktopReadinessResult = {
    targetType: config.targetType,
    status,
    checks,
    reasonCode: firstBlocked?.reasonCode,
    reportPath: "metrics/desktop-readiness.json",
  };
  writeFileSync(resolve(baseDir, result.reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}
