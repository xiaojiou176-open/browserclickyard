// @ts-nocheck
// 
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  auditLogPath as ioAuditLogPath,
  safeResolveUnder as ioSafeResolveUnder,
  writeAudit as ioWriteAudit,
} from "./io.js";
import type { JsonObject } from "./types.js";

export const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:18080";
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
export const BACKEND_RUNTIME_LOCK_STALE_MS = 60_000;
export const STREAM_STDOUT_LINE_CAP = 800;
export const STREAM_STDERR_LINE_CAP = 800;
export const STREAM_EVENT_CAP = 1500;
export const PROFILE_TARGET_PATTERN = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_UIQ_SYNC_TIMEOUT_MS = 10 * 60 * 1000;
// The default session should support the core read sequence without tripping governance
// before a client can inspect the basic MCP surfaces.
export const DEFAULT_GOVERN_RATE_LIMIT_CALLS = 20;
export const DEFAULT_GOVERN_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_GOVERN_TIMEOUT_MS = 30_000;
export const DEFAULT_GOVERN_SESSION_BUDGET_MS = 120_000;
export const DEFAULT_WORKSPACE_ALLOWLIST_ENV = "UIQ_MCP_WORKSPACE_ALLOWLIST";
export const DEFAULT_API_RETRY_MAX_ATTEMPTS = 6;
export const DEFAULT_API_RETRY_BASE_DELAY_MS = 100;
export const REDACTED = "[REDACTED]";

export function workspaceRoot(): string {
  return resolve(".");
}

export function runtimeRootOverride(): string | null {
  return null;
}

export function runsRoot(): string {
  return resolve(workspaceRoot(), ".runtime-cache/artifacts/runs");
}

export function repoRoot(): string {
  return workspaceRoot();
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function envPositiveInt(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(parsed, max);
}

export function auditLogPath(): string {
  return ioAuditLogPath();
}

export function writeAudit(event: {
  type: string;
  ok: boolean;
  detail?: string;
  meta?: JsonObject;
}): void {
  ioWriteAudit(event);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function ensureDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function ensureDirReady(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson(absPath: string): unknown {
  return JSON.parse(readUtf8(absPath));
}

export function safeResolveUnder(rootAbs: string, ...segments: string[]): string {
  return ioSafeResolveUnder(rootAbs, ...segments);
}

export function isPathInside(rootAbs: string, absPath: string): boolean {
  const rel = relative(rootAbs, absPath);
  return rel === "" || rel === "." || (!rel.startsWith("..") && !isAbsolute(rel));
}
