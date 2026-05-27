import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, relative, resolve } from "node:path";
import { ORCHESTRATOR_ENV } from "./env.js";

type SpawnedProcess = {
  key: string;
  command: string;
  pid: number;
  exited: boolean;
  exitCode: number | null;
  sendSignal: (signal: NodeJS.Signals) => void;
};

type ParsedSpawnCommand = {
  executable: string;
  args: string[];
  sanitized: string;
};

const ALLOWED_START_EXECUTABLES = new Set([
  "pnpm",
  "npm",
  "npx",
  "node",
  "tsx",
  "vite",
  "playwright",
  "python",
  "python3",
  "uv",
]);
const DISALLOWED_START_ARGS = new Set(["-c", "-e", "--eval"]);
const DEFAULT_TRUSTED_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/hostedtoolcache/node",
];
const SENSITIVE_FLAG_KEYS = new Set([
  "--token",
  "--password",
  "--passwd",
  "--secret",
  "--api-key",
  "--apikey",
  "--auth",
  "--authorization",
]);
const SHELL_OPERATOR_PATTERN = /[;&|><`$]/;

export type RuntimeStartConfig = {
  enabled: boolean;
  baseDir: string;
  startCommands?: {
    web?: string;
    api?: string;
  };
  healthcheckUrl?: string;
};

export type RuntimeStartResult = {
  autostart: boolean;
  started: boolean;
  healthcheckPassed: boolean;
  healthcheckUrl?: string;
  healthcheckReason?: string;
  healthcheckDetail?: string;
  processes: Array<{ key: string; command: string; pid: number }>;
  reportPath: string;
  teardown: () => Promise<void>;
};

export type HealthcheckWaitResult = {
  ok: boolean;
  reason:
    | "healthcheck_passed"
    | "healthcheck_timeout"
    | "healthcheck_non_2xx"
    | "healthcheck_request_error";
  detail: string;
  attempts: number;
  lastStatusCode?: number;
  lastError?: string;
};

function writeRuntimeStartReport(
  baseDir: string,
  relativePath: string,
  payload: RuntimeStartResult,
): void {
  const outputPath = resolve(baseDir, relativePath);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const POLL_INTERVAL_MS = 500;
const HEALTHCHECK_REQUEST_TIMEOUT_MS = 2_000;
const STARTUP_STABILITY_WINDOW_MS = 1_500;
const PROCESS_SHUTDOWN_GRACE_MS = 1_500;
const PROCESS_SHUTDOWN_FORCE_WAIT_MS = 400;
const PROCESS_EXIT_POLL_MS = 50;

function isAcceptedHealthcheckStatus(status: number): boolean {
  if (status >= 200 && status < 400) {
    return true;
  }
  return status === 401 || status === 403;
}

function parseTrustedBinDirs(): string[] {
  const raw = ORCHESTRATOR_ENV.UIQ_TRUSTED_BIN_DIRS?.trim();
  const candidates = raw
    ? raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_TRUSTED_BIN_DIRS;
  return candidates.map((item) => resolve(item));
}

function isUnderTrustedDir(absPath: string, trustedDirs: string[]): boolean {
  return trustedDirs.some((dir) => {
    const rel = relative(dir, absPath).replaceAll("\\", "/");
    return rel === "" || (!rel.startsWith("../") && rel !== "..");
  });
}

function resolveExecutableFromPath(executableName: string): string | null {
  const pathEnv = ORCHESTRATOR_ENV.PATH ?? process.env.PATH ?? "";
  const entries = pathEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const candidate = resolve(entry, executableName);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore and continue
    }
  }
  return null;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        current += command[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new Error("runtime start command has unclosed quote");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function parseCommandString(rawCommand: string): { command: string; args: string[] } {
  const input = rawCommand.trim();
  if (!input) {
    throw new Error("runtime start command is empty");
  }
  if (SHELL_OPERATOR_PATTERN.test(input)) {
    throw new Error("runtime start command contains unsupported shell operators");
  }
  if (input.includes("\u0000") || input.includes("\n") || input.includes("\r")) {
    throw new Error("runtime start command contains invalid control characters");
  }

  const tokens = tokenizeCommand(input);
  if (tokens.length === 0) {
    throw new Error("runtime start command is empty");
  }

  return { command: tokens[0], args: tokens.slice(1) };
}

function isSensitiveKey(token: string): boolean {
  const normalized = token.toLowerCase();
  return /(token|secret|pass(word)?|auth|api[-_]?key|credential)/.test(normalized);
}

function sanitizeCommandForLogs(command: string): string {
  const tokens = tokenizeCommand(command);
  const sanitized: string[] = [];
  let maskNext = false;

  for (const token of tokens) {
    if (maskNext) {
      sanitized.push("***");
      maskNext = false;
      continue;
    }

    const [left, right] = token.split("=", 2);
    const normalizedLeft = left.toLowerCase();
    if (
      right !== undefined &&
      (SENSITIVE_FLAG_KEYS.has(normalizedLeft) || isSensitiveKey(normalizedLeft))
    ) {
      sanitized.push(`${left}=***`);
      continue;
    }
    if (SENSITIVE_FLAG_KEYS.has(normalizedLeft)) {
      sanitized.push(left);
      maskNext = true;
      continue;
    }

    sanitized.push(token);
  }

  return sanitized.join(" ");
}

function parseCommandForSpawn(key: string, command: string): ParsedSpawnCommand {
  const parsed = parseCommandString(command);
  const executable = parsed.command;
  const args = parsed.args;

  if (hasPathSeparator(executable)) {
    throw new Error(
      `Invalid start command for '${key}': executable path separators are not allowed`,
    );
  }

  for (const arg of args) {
    if (DISALLOWED_START_ARGS.has(arg.toLowerCase())) {
      throw new Error(`Invalid start command for '${key}': arg '${arg}' is not allowed`);
    }
  }

  const executableName = basename(executable).toLowerCase();
  if (!ALLOWED_START_EXECUTABLES.has(executableName)) {
    throw new Error(
      `Invalid start command for '${key}': executable '${executableName}' is not allowlisted`,
    );
  }

  const resolvedExecutable = resolveExecutableFromPath(executableName);
  if (!resolvedExecutable) {
    throw new Error(
      `Invalid start command for '${key}': executable '${executableName}' is not resolvable from PATH`,
    );
  }

  const trustedDirs = parseTrustedBinDirs();
  if (!isUnderTrustedDir(resolvedExecutable, trustedDirs)) {
    throw new Error(
      `Invalid start command for '${key}': executable '${resolvedExecutable}' is not under trusted directories`,
    );
  }

  return {
    executable: resolvedExecutable,
    args,
    sanitized: sanitizeCommandForLogs(command),
  };
}

function hasPathSeparator(input: string): boolean {
  return input.includes("/") || input.includes("\\");
}

function parsePortFromCommand(rawCommand: string): string | undefined {
  const parsed = parseCommandString(rawCommand);
  const portIndex = parsed.args.indexOf("--port");
  if (portIndex >= 0) {
    const candidate = parsed.args[portIndex + 1];
    if (candidate && /^\d+$/u.test(candidate)) {
      return candidate;
    }
  }
  const bindIndex = parsed.args.indexOf("--bind");
  if (bindIndex >= 0) {
    const candidate = parsed.args[bindIndex + 1];
    if (candidate) {
      const match = candidate.match(/:(\d+)$/u);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

function spawnCommandWithEnv(
  key: string,
  command: string,
  envOverrides?: Record<string, string>,
): SpawnedProcess {
  const parsed = parseCommandForSpawn(key, command);
  const proc = spawn(parsed.executable, parsed.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(envOverrides ?? {}) },
    stdio: "ignore",
  });

  const spawned: SpawnedProcess = {
    key,
    command: parsed.sanitized,
    pid: proc.pid ?? -1,
    exited: false,
    exitCode: null,
    sendSignal: (signal) => {
      if (!spawned.exited) {
        try {
          proc.kill(signal);
        } catch {
          // Best-effort shutdown: process may already be gone.
        }
      }
    },
  };

  proc.on("exit", (code: number | null) => {
    spawned.exited = true;
    spawned.exitCode = code ?? null;
  });

  return spawned;
}

async function waitForProcessExit(proc: SpawnedProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exited) {
      return true;
    }
    await sleep(Math.min(PROCESS_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return proc.exited;
}

async function stopProcessWithFallback(proc: SpawnedProcess): Promise<void> {
  if (proc.exited) {
    return;
  }
  proc.sendSignal("SIGTERM");
  const exitedAfterTerm = await waitForProcessExit(proc, PROCESS_SHUTDOWN_GRACE_MS);
  if (exitedAfterTerm) {
    return;
  }
  proc.sendSignal("SIGKILL");
  await waitForProcessExit(proc, PROCESS_SHUTDOWN_FORCE_WAIT_MS);
}

async function teardownProcesses(processes: SpawnedProcess[]): Promise<void> {
  for (const proc of [...processes].reverse()) {
    await stopProcessWithFallback(proc);
  }
}

export async function waitForHealthcheck(
  url: string,
  timeoutMs = 30_000,
): Promise<HealthcheckWaitResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastStatusCode: number | undefined;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = deadline - Date.now();
    const requestTimeoutMs = Math.max(100, Math.min(HEALTHCHECK_REQUEST_TIMEOUT_MS, remainingMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      if (isAcceptedHealthcheckStatus(response.status)) {
        return {
          ok: true,
          reason: "healthcheck_passed",
          detail: `received_http_${response.status}`,
          attempts,
          lastStatusCode: response.status,
          lastError,
        };
      }
      lastStatusCode = response.status;
    } catch (error) {
      lastError = toErrorMessage(error);
    } finally {
      clearTimeout(timer);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (lastStatusCode !== undefined) {
    return {
      ok: false,
      reason: "healthcheck_non_2xx",
      detail: `last_http_status=${lastStatusCode}`,
      attempts,
      lastStatusCode,
      lastError,
    };
  }
  if (lastError) {
    return {
      ok: false,
      reason: "healthcheck_request_error",
      detail: `last_error=${lastError}`,
      attempts,
      lastStatusCode,
      lastError,
    };
  }
  return {
    ok: false,
    reason: "healthcheck_timeout",
    detail: "no_response_before_timeout",
    attempts,
    lastStatusCode,
    lastError,
  };
}

export async function startTargetRuntime(config: RuntimeStartConfig): Promise<RuntimeStartResult> {
  const reportPath = "reports/runtime-start.json";
  if (
    !config.enabled ||
    !config.startCommands ||
    (!config.startCommands.web && !config.startCommands.api)
  ) {
    const noop: RuntimeStartResult = {
      autostart: config.enabled,
      started: false,
      healthcheckPassed: true,
      healthcheckUrl: config.healthcheckUrl,
      healthcheckReason: "autostart_disabled_or_no_commands",
      healthcheckDetail: "runtime autostart skipped",
      processes: [],
      reportPath,
      teardown: async () => undefined,
    };
    writeRuntimeStartReport(config.baseDir, reportPath, noop);
    return noop;
  }

  const processes: SpawnedProcess[] = [];
  const apiPort = config.startCommands.api
    ? parsePortFromCommand(config.startCommands.api)
    : undefined;
  try {
    if (config.startCommands.api) {
      processes.push(spawnCommandWithEnv("api", config.startCommands.api));
    }
    if (config.startCommands.web) {
      const webEnvOverrides = apiPort ? { BACKEND_PORT: apiPort } : undefined;
      processes.push(spawnCommandWithEnv("web", config.startCommands.web, webEnvOverrides));
    }
  } catch (error) {
    await teardownProcesses(processes);
    const failedResult: RuntimeStartResult = {
      autostart: true,
      started: processes.length > 0,
      healthcheckPassed: false,
      healthcheckUrl: config.healthcheckUrl,
      healthcheckReason: "startup_command_failed",
      healthcheckDetail: toErrorMessage(error),
      processes: processes.map((item) => ({
        key: item.key,
        command: item.command,
        pid: item.pid,
      })),
      reportPath,
      teardown: async () => undefined,
    };
    writeRuntimeStartReport(config.baseDir, reportPath, failedResult);
    throw error;
  }

  const healthcheckResult = config.healthcheckUrl
    ? await waitForHealthcheck(config.healthcheckUrl)
    : {
        ok: true,
        reason: "healthcheck_passed",
        detail: "healthcheck_url_not_configured",
        attempts: 0,
      };

  let healthcheckReason = healthcheckResult.reason;
  let healthcheckDetail = healthcheckResult.detail;
  const allProcessesAliveAtFirstCheck = processes.every((proc) => !proc.exited);
  if (healthcheckResult.ok && allProcessesAliveAtFirstCheck) {
    // Guard against false positives when an unrelated process already serves the same healthcheck URL.
    // We only consider startup healthy if spawned runtime processes remain alive for a short stability window.
    await sleep(STARTUP_STABILITY_WINDOW_MS);
  }
  const allProcessesAliveAfterStabilityWindow = processes.every((proc) => !proc.exited);
  const healthcheckPassed =
    healthcheckResult.ok && allProcessesAliveAtFirstCheck && allProcessesAliveAfterStabilityWindow;
  if (healthcheckResult.ok && !allProcessesAliveAtFirstCheck) {
    healthcheckReason = "process_exited_before_first_healthcheck";
    healthcheckDetail = "runtime process exited before initial healthcheck settled";
  } else if (healthcheckResult.ok && !allProcessesAliveAfterStabilityWindow) {
    healthcheckReason = "process_exited_during_stability_window";
    healthcheckDetail = "runtime process exited during startup stability window";
  }

  const result: RuntimeStartResult = {
    autostart: true,
    started: processes.length > 0,
    healthcheckPassed,
    healthcheckUrl: config.healthcheckUrl,
    healthcheckReason,
    healthcheckDetail,
    processes: processes.map((item) => ({ key: item.key, command: item.command, pid: item.pid })),
    reportPath,
    teardown: async () => {
      await teardownProcesses(processes);
    },
  };

  writeRuntimeStartReport(config.baseDir, reportPath, result);
  return result;
}
