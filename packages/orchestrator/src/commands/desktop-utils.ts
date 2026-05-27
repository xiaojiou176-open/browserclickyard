import { execFileSync, spawnSync } from "node:child_process";

export type ShellResult = {
  ok: boolean;
  detail: string;
  stdout: string;
  stderr: string;
};

export const DESKTOP_AUTOMATION_MODE_ENV = "UIQ_DESKTOP_AUTOMATION_MODE";
export const DESKTOP_AUTOMATION_REASON_ENV = "UIQ_DESKTOP_AUTOMATION_REASON";
export const DESKTOP_AUTOMATION_OPERATOR_MANUAL_MODE = "operator-manual";
export const DESKTOP_HOST_SAFETY_REASON_CODE =
  "desktop.host_safety.operator_manual_required";
const MANUAL_DESKTOP_INTERACTION_MARKER = "manual operator interaction required";
const MANUAL_DESKTOP_TEARDOWN_MARKER = "manual operator teardown required";

export function blockedShellResult(detail: string): ShellResult {
  return {
    ok: false,
    detail,
    stdout: "",
    stderr: "",
  };
}

export function requireOperatorManualDesktopAutomation(commandName: string):
  | { ok: true }
  | {
      ok: false;
      detail: string;
      reasonCode: typeof DESKTOP_HOST_SAFETY_REASON_CODE;
    } {
  const mode = process.env[DESKTOP_AUTOMATION_MODE_ENV]?.trim().toLowerCase();
  const reason = process.env[DESKTOP_AUTOMATION_REASON_ENV]?.trim();
  if (mode === DESKTOP_AUTOMATION_OPERATOR_MANUAL_MODE && reason) {
    return { ok: true };
  }

  return {
    ok: false,
    reasonCode: DESKTOP_HOST_SAFETY_REASON_CODE,
    detail:
      `${commandName} is operator-manual host automation. ` +
      `Set ${DESKTOP_AUTOMATION_MODE_ENV}=${DESKTOP_AUTOMATION_OPERATOR_MANUAL_MODE} ` +
      `and ${DESKTOP_AUTOMATION_REASON_ENV}=<auditable reason> to run it.`,
  };
}

export function requireDesktopOperatorManual(action: string): ShellResult | null {
  const guard = requireOperatorManualDesktopAutomation(action);
  return guard.ok ? null : blockedShellResult(guard.detail);
}

export function blockedDesktopInteractionResult(action: string): ShellResult {
  return blockedShellResult(
    `${action} blocked: ${MANUAL_DESKTOP_INTERACTION_MARKER}; ` +
      "scripted host-level desktop input automation is disabled for host safety",
  );
}

export function manualDesktopTeardownResult(target: string): ShellResult {
  return blockedShellResult(
    `${MANUAL_DESKTOP_TEARDOWN_MARKER} for ${target}; ` +
      "scripted desktop quit/kill flows are disabled for host safety",
  );
}

export function isManualDesktopTeardownDetail(detail: string): boolean {
  return detail.includes(MANUAL_DESKTOP_TEARDOWN_MARKER);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function runChecked(command: string, args: string[], timeoutMs = 10000): ShellResult {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout?.toString()?.trim() ?? "";
  const stderr = result.stderr?.toString()?.trim() ?? "";
  if (result.error) {
    return {
      ok: false,
      detail: `${command} ${args.join(" ")} error: ${(result.error as Error).message}`,
      stdout,
      stderr,
    };
  }
  if (result.status === 0) {
    return {
      ok: true,
      detail: `${command} ${args.join(" ")} ok`,
      stdout,
      stderr,
    };
  }
  return {
    ok: false,
    detail: `${command} ${args.join(" ")} failed: ${stderr || stdout || "unknown error"}`,
    stdout,
    stderr,
  };
}

export function appNameFromPath(appPath: string): string {
  const normalized = appPath.endsWith("/") ? appPath.slice(0, -1) : appPath;
  const parts = normalized.split("/");
  const last = parts[parts.length - 1] || "";
  return last.endsWith(".app") ? last.slice(0, -4) : last;
}

export function readBundleIdFromApp(appPath: string): string | undefined {
  try {
    const output = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", `${appPath}/Contents/Info.plist`],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function findAppPathByBundleId(bundleId: string): string | undefined {
  try {
    const output = execFileSync("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split("\n")
      .map((v) => v.trim())
      .find((v) => v.endsWith(".app"));
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function findAppNameByBundleId(bundleId: string): string | undefined {
  const appPath = findAppPathByBundleId(bundleId);
  return appPath ? appNameFromPath(appPath) : undefined;
}

export function isProcessRunning(appName: string): boolean {
  const check = runChecked("pgrep", ["-x", appName], 5000);
  return check.ok;
}

export function findFirstPid(appName: string): number | undefined {
  const check = runChecked("pgrep", ["-x", appName], 5000);
  if (!check.ok || !check.stdout) {
    return undefined;
  }
  const first = check.stdout
    .split("\n")
    .map((v) => v.trim())
    .find(Boolean);
  if (!first) {
    return undefined;
  }
  const pid = Number(first);
  return Number.isInteger(pid) ? pid : undefined;
}

export function getWindowCount(appName: string): number | undefined {
  void appName;
  return undefined;
}

export function getProcessSample(pid: number): { rssMb: number; cpuPercent: number } | undefined {
  const sample = runChecked("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], 5000);
  if (!sample.ok || !sample.stdout) {
    return undefined;
  }
  const parts = sample.stdout.trim().split(/\s+/);
  if (parts.length < 2) {
    return undefined;
  }
  const rssKb = Number(parts[0]);
  const cpu = Number(parts[1]);
  if (!Number.isFinite(rssKb) || !Number.isFinite(cpu)) {
    return undefined;
  }
  return {
    rssMb: Number((rssKb / 1024).toFixed(2)),
    cpuPercent: Number(cpu.toFixed(2)),
  };
}
