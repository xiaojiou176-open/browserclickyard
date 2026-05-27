import * as childProcess from "node:child_process";

export const MACOS_XCUITEST_DRIVER_ID = "macos-xcuitest";

export type SwiftDriverCheck = {
  id: string;
  status: "passed" | "blocked";
  detail: string;
  reasonCode?: string;
};

export type DesktopActionCategory =
  | "launch"
  | "activate"
  | "interaction"
  | "checkpoint"
  | "teardown";

export function swiftActionReasonCode(category: DesktopActionCategory, detail: string): string {
  const normalized = detail.toLowerCase();
  if (category === "interaction" && normalized.includes("not authorized")) {
    return "desktop.swift.business.interaction.permission_denied";
  }
  if (category === "interaction" && normalized.includes("not allowed assistive access")) {
    return "desktop.swift.business.interaction.permission_denied";
  }
  switch (category) {
    case "launch":
      return "desktop.swift.business.launch_failed";
    case "activate":
      return "desktop.swift.business.activate_failed";
    case "interaction":
      return "desktop.swift.business.interaction_failed";
    case "checkpoint":
      return "desktop.swift.business.checkpoint_failed";
    case "teardown":
      return "desktop.swift.business.teardown_failed";
    default:
      return "desktop.swift.business.unknown_failure";
  }
}

type ProcessRunner = {
  spawnSync: (
    command: string,
    args?: readonly string[],
    options?:
      | childProcess.SpawnSyncOptionsWithBufferEncoding
      | childProcess.SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer; error?: Error };
};

function commandExists(command: string, runner: ProcessRunner = childProcess): boolean {
  try {
    const proc = runner.spawnSync("which", [command], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return proc.status === 0;
  } catch {
    return false;
  }
}

export function buildBundleQuery(bundleId: string): string {
  const escaped = bundleId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `kMDItemCFBundleIdentifier == "${escaped}"`;
}

export function checkXcodebuild(): SwiftDriverCheck {
  return commandExists("xcodebuild")
    ? { id: "desktop.swift.xcodebuild", status: "passed", detail: "xcodebuild found" }
    : {
        id: "desktop.swift.xcodebuild",
        status: "blocked",
        detail: "xcodebuild missing (Xcode CLI tools required)",
        reasonCode: "desktop.swift.xcodebuild.missing",
      };
}

export function checkSwiftBundle(
  bundleId: string | undefined,
  runner: ProcessRunner = childProcess,
): SwiftDriverCheck {
  if (!bundleId) {
    return {
      id: "desktop.swift.bundle",
      status: "blocked",
      detail: "target.bundleId is required for swift driver",
      reasonCode: "desktop.swift.bundle.missing",
    };
  }
  if (!commandExists("mdfind", runner)) {
    return {
      id: "desktop.swift.bundle",
      status: "blocked",
      detail: "mdfind not available on current host",
      reasonCode: "desktop.swift.bundle.lookup_tool_missing",
    };
  }
  try {
    const query = buildBundleQuery(bundleId);
    const proc = runner.spawnSync("mdfind", [query], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    if (proc.error) {
      const err = proc.error as Error & { code?: string };
      const timedOut = err.code === "ETIMEDOUT";
      return {
        id: "desktop.swift.bundle",
        status: "blocked",
        detail: timedOut
          ? `bundleId lookup timed out: ${bundleId}`
          : `bundleId lookup failed: ${bundleId} (${err.message})`,
        reasonCode: timedOut
          ? "desktop.swift.bundle.lookup_timeout"
          : "desktop.swift.bundle.lookup_failed",
      };
    }
    if (proc.status !== 0) {
      return {
        id: "desktop.swift.bundle",
        status: "blocked",
        detail: `bundleId lookup failed: ${bundleId} (exit=${proc.status ?? "unknown"})`,
        reasonCode: "desktop.swift.bundle.lookup_failed",
      };
    }
    const stdout =
      typeof proc.stdout === "string" ? proc.stdout : (proc.stdout?.toString("utf8") ?? "");
    const output = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!output) {
      return {
        id: "desktop.swift.bundle",
        status: "blocked",
        detail: `bundleId not found on host: ${bundleId}`,
        reasonCode: "desktop.swift.bundle.not_found",
      };
    }
    return {
      id: "desktop.swift.bundle",
      status: "passed",
      detail: `bundleId found: ${bundleId} -> ${output}`,
    };
  } catch {
    return {
      id: "desktop.swift.bundle",
      status: "blocked",
      detail: `bundleId lookup failed: ${bundleId}`,
      reasonCode: "desktop.swift.bundle.lookup_failed",
    };
  }
}
