import {
  appNameFromPath,
  findAppNameByBundleId,
  manualDesktopTeardownResult,
  readBundleIdFromApp,
  requireOperatorManualDesktopAutomation,
  runChecked,
  type ShellResult,
} from "./desktop-utils.js";

export type DesktopLifecycleConfig = {
  targetType: string;
  app?: string;
  bundleId?: string;
};

export type DesktopLifecycleReasonCode =
  | "desktop.tauri.app.missing"
  | "desktop.swift.bundle.missing"
  | "desktop.target.unsupported";

type QuitOptions = {
  bundleId?: string;
  appName?: string;
  timeoutMs?: number;
  attemptForceKill?: boolean;
  resolveAppNameFallback?: boolean;
};

export type DesktopLifecycleStrategy = {
  ok: true;
  targetType: "tauri" | "swift";
  appName?: string;
  launch: () => ShellResult;
  resolveBundleId: () => string | undefined;
  resolveAppName: (bundleId?: string) => string | undefined;
  activate: (bundleId: string, timeoutMs?: number) => ShellResult;
  quit: (options?: QuitOptions) => ShellResult;
};

export type DesktopLifecycleResolution =
  | DesktopLifecycleStrategy
  | { ok: false; reasonCode: DesktopLifecycleReasonCode };

function buildLifecycleStrategy(params: {
  targetType: "tauri" | "swift";
  launchArgs: string[];
  appName?: string;
  resolveBundleId: () => string | undefined;
  resolveAppName: (bundleId?: string) => string | undefined;
}): DesktopLifecycleStrategy {
  return {
    ok: true,
    targetType: params.targetType,
    appName: params.appName,
    launch: () => {
      const guard = requireOperatorManualDesktopAutomation("desktop-launch");
      return guard.ok
        ? runChecked("open", params.launchArgs)
        : {
            ok: false,
            detail: guard.detail,
            stdout: "",
            stderr: "",
          };
    },
    resolveBundleId: params.resolveBundleId,
    resolveAppName: params.resolveAppName,
    activate: (_bundleId: string, timeoutMs = 30000) => {
      const guard = requireOperatorManualDesktopAutomation("desktop-activate");
      return guard.ok
        ? runChecked("open", params.launchArgs, timeoutMs)
        : {
            ok: false,
            detail: guard.detail,
            stdout: "",
            stderr: "",
          };
    },
    quit: (options?: QuitOptions) => {
      void options;
      return manualDesktopTeardownResult(params.appName ?? params.resolveBundleId() ?? params.targetType);
    },
  };
}

export function createDesktopLifecycleStrategy(
  config: DesktopLifecycleConfig,
): DesktopLifecycleResolution {
  if (config.targetType === "tauri") {
    if (!config.app) {
      return { ok: false, reasonCode: "desktop.tauri.app.missing" };
    }
    const app = config.app;
    return buildLifecycleStrategy({
      targetType: "tauri",
      launchArgs: ["-a", app],
      appName: appNameFromPath(app),
      resolveBundleId: () => readBundleIdFromApp(app),
      resolveAppName: () => appNameFromPath(app),
    });
  }

  if (config.targetType === "swift") {
    if (!config.bundleId) {
      return { ok: false, reasonCode: "desktop.swift.bundle.missing" };
    }
    const bundleId = config.bundleId;
    return buildLifecycleStrategy({
      targetType: "swift",
      launchArgs: ["-b", bundleId],
      resolveBundleId: () => bundleId,
      resolveAppName: (value?: string) => findAppNameByBundleId(value ?? bundleId),
    });
  }

  return { ok: false, reasonCode: "desktop.target.unsupported" };
}
