// @ts-nocheck
// 
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import {
  backendBaseUrl,
  isTimeoutAbortError,
  isTrustedBackendBaseUrl,
  normalizeBackendBaseUrl,
} from "./api-client.js";
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  runtimeRootOverride,
  sleep,
  workspaceRoot,
} from "./constants.js";

function devRuntimeRoot(): string {
  return runtimeRootOverride() ?? resolve(workspaceRoot(), ".runtime-cache/dev");
}

function backendRuntimeLockPath(): string {
  return resolve(devRuntimeRoot(), "mcp-backend-runtime.lock");
}

type RuntimeLockRecord = {
  pid: number;
  action: string;
  acquiredAt: string;
  owner: string;
  processTag?: string;
};

function parseRuntimeLockRecord(lockPath: string): RuntimeLockRecord | null {
  try {
    const parsed = JSON.parse(readFileUtf8(lockPath)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Partial<RuntimeLockRecord>;
    if (
      typeof record.pid !== "number" ||
      typeof record.action !== "string" ||
      typeof record.acquiredAt !== "string" ||
      typeof record.owner !== "string"
    ) {
      return null;
    }
    return record as RuntimeLockRecord;
  } catch {
    return null;
  }
}

function isStaleLock(lockPath: string): boolean {
  const record = parseRuntimeLockRecord(lockPath);
  if (!record) {
    return true;
  }
  if (!isProcessAlive(record.pid)) {
    return true;
  }
  if (record.processTag) {
    const cmd = runtimePidCommand(record.pid);
    if (cmd && !cmd.toLowerCase().includes(record.processTag.toLowerCase())) {
      return true;
    }
  }
  return false;
}

async function acquireRuntimeLock(action: string): Promise<() => void> {
  const lockPath = backendRuntimeLockPath();
  mkdirSync(devRuntimeRoot(), { recursive: true });
  const deadlineMs = Date.now() + 10_000;
  const owner = `${process.pid}:${randomUUID()}`;
  const processTag = basename(process.argv[1] ?? process.argv[0] ?? "node").toLowerCase();
  while (Date.now() <= deadlineMs) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify(
          { pid: process.pid, action, acquiredAt: new Date().toISOString(), owner, processTag },
          null,
          2,
        ),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      return () => {
        try {
          const current = parseRuntimeLockRecord(lockPath);
          if (!current || current.owner !== owner) {
            return;
          }
          unlinkSync(lockPath);
        } catch {
          // ignore lock cleanup failure
        }
      };
    } catch {
      if (existsSync(lockPath) && isStaleLock(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore stale lock cleanup error
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
  }
  throw new Error(`runtime lock timeout for action=${action}`);
}

export const __runtimeLockForTests = {
  backendRuntimeLockPath,
  parseRuntimeLockRecord,
  isStaleLock,
  acquireRuntimeLock,
};

async function withRuntimeLock<T>(action: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRuntimeLock(action);
  try {
    return await fn();
  } finally {
    release();
  }
}

function backendRuntimeStatePath(): string {
  return resolve(devRuntimeRoot(), "mcp-backend-runtime.json");
}

function healthPath(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/health/`;
}

function healthTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.UIQ_MCP_HEALTH_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEALTH_TIMEOUT_MS;
}

function isManagedPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function isProcessAlive(pid: number): boolean {
  if (!isManagedPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtimePidCommand(pid: number): string | null {
  const proc = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (proc.status !== 0) {
    return null;
  }
  const cmd = (proc.stdout ?? "").trim();
  return cmd || null;
}

function matchesManagedCommand(commandLine: string, expected: string[]): boolean {
  if (!expected.length) {
    return false;
  }
  const normalized = commandLine.toLowerCase();
  const expectedBin = basename(expected[0]).toLowerCase();
  if (!normalized.includes(expectedBin)) {
    return false;
  }
  return expected.slice(1).every((part) => normalized.includes(String(part).toLowerCase()));
}

function isTrustedManagedState(state: {
  pid: number;
  baseUrl: string;
  command: string[];
}): boolean {
  if (!isTrustedBackendBaseUrl(state.baseUrl)) {
    return false;
  }
  if (!isProcessAlive(state.pid)) {
    return false;
  }
  const cmd = runtimePidCommand(state.pid);
  if (!cmd) {
    return false;
  }
  return matchesManagedCommand(cmd, state.command);
}

async function pickFreePort(preferredPort: number): Promise<number> {
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolvePromise) => {
      const server = createServer();
      server.unref();
      server.on("error", () => resolvePromise(false));
      server.listen({ host: "127.0.0.1", port }, () => {
        server.close(() => resolvePromise(true));
      });
    });

  let candidate = Math.max(1024, preferredPort);
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const free = await tryPort(candidate);
    if (free) {
      return candidate;
    }
    candidate += 1;
  }
  throw new Error("no free port available near preferred port");
}

type ManagedRuntimeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
  logPath: string;
  command: string[];
};

function readBackendRuntimeState(): ManagedRuntimeState | null {
  const statePath = backendRuntimeStatePath();
  if (!existsSync(statePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileUtf8(statePath)) as unknown;
  } catch {
    clearBackendRuntimeState();
    return null;
  }
  const obj = asObject(parsed);
  if (!obj) {
    clearBackendRuntimeState();
    return null;
  }
  if (
    typeof obj.pid !== "number" ||
    !isManagedPid(obj.pid) ||
    typeof obj.port !== "number" ||
    !Number.isInteger(obj.port) ||
    obj.port < 1 ||
    obj.port > 65535 ||
    typeof obj.baseUrl !== "string"
  ) {
    clearBackendRuntimeState();
    return null;
  }
  if (
    typeof obj.startedAt !== "string" ||
    typeof obj.logPath !== "string" ||
    !Array.isArray(obj.command)
  ) {
    clearBackendRuntimeState();
    return null;
  }
  const command = obj.command.filter((item): item is string => typeof item === "string");
  return {
    pid: obj.pid,
    port: obj.port,
    baseUrl: obj.baseUrl,
    startedAt: obj.startedAt,
    logPath: obj.logPath,
    command,
  };
}

function resolvePreferredBackendPort(
  preferredPort?: number,
): { ok: true; port: number } | { ok: false; detail: string } {
  const candidate =
    preferredPort ?? Number.parseInt(process.env.UIQ_MCP_BACKEND_PORT ?? "18080", 10);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    return {
      ok: false,
      detail: "invalid UIQ_MCP_BACKEND_PORT: expected integer in [1, 65535]",
    };
  }
  return { ok: true, port: candidate };
}

function writeBackendRuntimeState(state: ManagedRuntimeState): void {
  mkdirSync(devRuntimeRoot(), { recursive: true });
  writeFileSync(backendRuntimeStatePath(), JSON.stringify(state, null, 2), "utf8");
}

function clearBackendRuntimeState(): void {
  const statePath = backendRuntimeStatePath();
  if (!existsSync(statePath)) {
    return;
  }
  try {
    unlinkSync(statePath);
  } catch {
    // ignore
  }
}

export async function checkBackendHealth(
  baseUrl: string,
): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const trustedBaseUrl = normalizeBackendBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeout = healthTimeoutMs();
  const timeoutHandle = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(healthPath(trustedBaseUrl), {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);
    return {
      ok: response.ok,
      status: response.status,
      detail: `status=${response.status}`,
    };
  } catch (error) {
    clearTimeout(timeoutHandle);
    const isTimeoutError = isTimeoutAbortError(error, controller.signal);
    return {
      ok: false,
      status: isTimeoutError ? 408 : null,
      detail: isTimeoutError ? `timeout after ${timeout}ms` : `error=${(error as Error).message}`,
    };
  }
}

async function waitBackendHealthy(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; elapsedMs: number; detail: string }> {
  const startedAt = Date.now();
  let lastDetail = "not started";
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const check = await checkBackendHealth(baseUrl);
    if (check.ok) {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        detail: check.detail,
      };
    }
    lastDetail = check.detail;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    detail: lastDetail,
  };
}

export async function startBackendRuntime(preferredPort?: number): Promise<{
  ok: boolean;
  action: "start";
  reused: boolean;
  pid: number | null;
  port: number | null;
  baseUrl: string;
  health: { ok: boolean; status: number | null; detail: string; elapsedMs?: number };
  logPath: string | null;
  detail: string;
}> {
  return withRuntimeLock("start", async () => {
    const existing = readBackendRuntimeState();
    if (existing) {
      if (isTrustedManagedState(existing)) {
        const health = await checkBackendHealth(existing.baseUrl);
        process.env.UIQ_MCP_API_BASE_URL = existing.baseUrl;
        return {
          ok: health.ok,
          action: "start",
          reused: true,
          pid: existing.pid,
          port: existing.port,
          baseUrl: existing.baseUrl,
          health,
          logPath: existing.logPath,
          detail: "reused existing backend runtime",
        };
      }
      clearBackendRuntimeState();
    }

    const workspace = workspaceRoot();
    const pythonExec = resolve(workspace, "scripts/lib/python-exec.sh");
    if (!existsSync(pythonExec)) {
      return {
        ok: false,
        action: "start",
        reused: false,
        pid: null,
        port: null,
        baseUrl: backendBaseUrl(),
        health: { ok: false, status: null, detail: "missing scripts/lib/python-exec.sh" },
        logPath: null,
        detail: "backend runtime start blocked: missing scripts/lib/python-exec.sh",
      };
    }

    const preferredPortResolution = resolvePreferredBackendPort(preferredPort);
    if (!preferredPortResolution.ok) {
      return {
        ok: false,
        action: "start",
        reused: false,
        pid: null,
        port: null,
        baseUrl: backendBaseUrl(),
        health: { ok: false, status: null, detail: preferredPortResolution.detail },
        logPath: null,
        detail: preferredPortResolution.detail,
      };
    }
    const port = await pickFreePort(preferredPortResolution.port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const logPath = resolve(devRuntimeRoot(), `mcp-backend-${port}.log`);
    mkdirSync(devRuntimeRoot(), { recursive: true });

    const command = [
      pythonExec,
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    const child = spawn(command[0], command.slice(1), {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => appendFileSync(logPath, String(chunk), "utf8"));
    child.stderr?.on("data", (chunk) => appendFileSync(logPath, String(chunk), "utf8"));

    const pid = child.pid ?? null;
    if (!pid || !isManagedPid(pid)) {
      return {
        ok: false,
        action: "start",
        reused: false,
        pid: null,
        port: null,
        baseUrl,
        health: { ok: false, status: null, detail: "uvicorn spawned without pid" },
        logPath,
        detail: "backend runtime start failed",
      };
    }

    writeBackendRuntimeState({
      pid,
      port,
      baseUrl,
      startedAt: new Date().toISOString(),
      logPath,
      command,
    });
    const waited = await waitBackendHealthy(baseUrl, 30_000);
    process.env.UIQ_MCP_API_BASE_URL = baseUrl;
    return {
      ok: waited.ok,
      action: "start",
      reused: false,
      pid,
      port,
      baseUrl,
      health: {
        ok: waited.ok,
        status: waited.ok ? 200 : null,
        detail: waited.detail,
        elapsedMs: waited.elapsedMs,
      },
      logPath,
      detail: waited.ok
        ? "backend runtime started"
        : "backend runtime started but health check failed",
    };
  });
}

export async function backendRuntimeStatus(): Promise<{
  ok: boolean;
  action: "status";
  running: boolean;
  pid: number | null;
  port: number | null;
  baseUrl: string;
  health: { ok: boolean; status: number | null; detail: string };
  logPath: string | null;
  detail: string;
}> {
  return withRuntimeLock("status", async () => {
    const state = readBackendRuntimeState();
    if (!state) {
      const baseUrl = backendBaseUrl();
      const health = await checkBackendHealth(baseUrl);
      return {
        ok: false,
        action: "status",
        running: false,
        pid: null,
        port: null,
        baseUrl,
        health,
        logPath: null,
        detail: "no managed backend runtime state found",
      };
    }
    if (!isTrustedBackendBaseUrl(state.baseUrl)) {
      clearBackendRuntimeState();
      return {
        ok: false,
        action: "status",
        running: false,
        pid: state.pid,
        port: state.port,
        baseUrl: state.baseUrl,
        health: { ok: false, status: null, detail: "untrusted runtime baseUrl" },
        logPath: state.logPath,
        detail: "managed backend runtime state rejected",
      };
    }

    const running = isProcessAlive(state.pid);
    const trustedPid = running && isTrustedManagedState(state);
    if (running && !trustedPid) {
      clearBackendRuntimeState();
      return {
        ok: false,
        action: "status",
        running: false,
        pid: state.pid,
        port: state.port,
        baseUrl: state.baseUrl,
        health: { ok: false, status: null, detail: "runtime pid command mismatch" },
        logPath: state.logPath,
        detail: "managed backend runtime state rejected",
      };
    }
    const health = await checkBackendHealth(state.baseUrl);
    process.env.UIQ_MCP_API_BASE_URL = state.baseUrl;
    return {
      ok: running && health.ok,
      action: "status",
      running,
      pid: state.pid,
      port: state.port,
      baseUrl: state.baseUrl,
      health,
      logPath: state.logPath,
      detail: running ? "managed backend runtime detected" : "managed backend runtime not alive",
    };
  });
}

export async function stopBackendRuntime(): Promise<{
  ok: boolean;
  action: "stop";
  stopped: boolean;
  pid: number | null;
  baseUrl: string;
  detail: string;
}> {
  return withRuntimeLock("stop", async () => {
    const state = readBackendRuntimeState();
    if (!state) {
      return {
        ok: true,
        action: "stop",
        stopped: false,
        pid: null,
        baseUrl: backendBaseUrl(),
        detail: "no managed backend runtime state found",
      };
    }
    if (!isTrustedBackendBaseUrl(state.baseUrl)) {
      clearBackendRuntimeState();
      return {
        ok: false,
        action: "stop",
        stopped: false,
        pid: state.pid,
        baseUrl: state.baseUrl,
        detail: "managed backend runtime state rejected: untrusted baseUrl",
      };
    }
    const wasAlive = isProcessAlive(state.pid);
    if (wasAlive && !isTrustedManagedState(state)) {
      clearBackendRuntimeState();
      return {
        ok: false,
        action: "stop",
        stopped: false,
        pid: state.pid,
        baseUrl: state.baseUrl,
        detail: "managed backend runtime state rejected: pid command mismatch",
      };
    }
    if (wasAlive) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // ignore
      }
      const until = Date.now() + 5000;
      while (Date.now() < until && isProcessAlive(state.pid)) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      }
    }
    const stillAlive = isProcessAlive(state.pid);
    if (stillAlive) {
      return {
        ok: false,
        action: "stop",
        stopped: false,
        pid: state.pid,
        baseUrl: state.baseUrl,
        detail: "still_alive",
      };
    }
    clearBackendRuntimeState();
    return {
      ok: true,
      action: "stop",
      stopped: wasAlive,
      pid: state.pid,
      baseUrl: state.baseUrl,
      detail: wasAlive ? "managed backend runtime stopped" : "managed backend runtime already dead",
    };
  });
}

export const __runtimeStateForTests = {
  backendRuntimeStatePath,
  readBackendRuntimeState,
  writeBackendRuntimeState,
  clearBackendRuntimeState,
  resolvePreferredBackendPort,
};

function readFileUtf8(path: string): string {
  return statSync(path).isFile() ? readFileSync(path, "utf8") : "";
}

function asObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}
