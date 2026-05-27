import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const TAURI_WEBDRIVER_DRIVER_ID = "tauri-webdriver";

export type TauriDriverCheck = {
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

export function tauriActionReasonCode(category: DesktopActionCategory, detail: string): string {
  const normalized = detail.toLowerCase();
  if (category === "interaction" && normalized.includes("not authorized")) {
    return "desktop.tauri.business.interaction.permission_denied";
  }
  if (category === "interaction" && normalized.includes("not allowed assistive access")) {
    return "desktop.tauri.business.interaction.permission_denied";
  }
  switch (category) {
    case "launch":
      return "desktop.tauri.business.launch_failed";
    case "activate":
      return "desktop.tauri.business.activate_failed";
    case "interaction":
      return "desktop.tauri.business.interaction_failed";
    case "checkpoint":
      return "desktop.tauri.business.checkpoint_failed";
    case "teardown":
      return "desktop.tauri.business.teardown_failed";
    default:
      return "desktop.tauri.business.unknown_failure";
  }
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function hostIsDarwin(): boolean {
  return process.platform === "darwin";
}

export function checkDesktopHost(): TauriDriverCheck {
  return hostIsDarwin()
    ? { id: "desktop.host.platform", status: "passed", detail: "host platform is darwin" }
    : {
        id: "desktop.host.platform",
        status: "blocked",
        detail: `desktop commands require darwin host, got ${process.platform}`,
        reasonCode: "desktop.host.unsupported_os",
      };
}

export function checkDesktopCommand(command: string): TauriDriverCheck {
  return commandExists(command)
    ? { id: `desktop.host.command.${command}`, status: "passed", detail: `${command} found` }
    : {
        id: `desktop.host.command.${command}`,
        status: "blocked",
        detail: `${command} missing (desktop command dependency)`,
        reasonCode: `desktop.host.command_missing.${command}`,
      };
}

export function checkTauriAppPath(appPath: string | undefined): TauriDriverCheck {
  if (!appPath) {
    return {
      id: "desktop.tauri.app_path",
      status: "blocked",
      detail: "target.app is required for tauri driver",
      reasonCode: "desktop.tauri.app.missing",
    };
  }
  const abs = resolve(appPath);
  if (!existsSync(abs)) {
    return {
      id: "desktop.tauri.app_path",
      status: "blocked",
      detail: `tauri app not found: ${abs}`,
      reasonCode: "desktop.tauri.app.not_found",
    };
  }
  const stat = statSync(abs);
  if (!stat.isFile() && !stat.isDirectory()) {
    return {
      id: "desktop.tauri.app_path",
      status: "blocked",
      detail: `invalid tauri app path: ${abs}`,
      reasonCode: "desktop.tauri.app.invalid_path",
    };
  }
  return { id: "desktop.tauri.app_path", status: "passed", detail: `tauri app found: ${abs}` };
}

export function checkTauriDriverBinary(): TauriDriverCheck {
  return commandExists("tauri-driver")
    ? { id: "desktop.tauri.webdriver_binary", status: "passed", detail: "tauri-driver found" }
    : {
        id: "desktop.tauri.webdriver_binary",
        status: "blocked",
        detail: "tauri-driver missing (install required)",
        reasonCode: "desktop.tauri.webdriver_binary.missing",
      };
}
