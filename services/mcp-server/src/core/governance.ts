// @ts-nocheck
// 
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_GOVERN_RATE_LIMIT_CALLS,
  DEFAULT_GOVERN_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_GOVERN_SESSION_BUDGET_MS,
  DEFAULT_GOVERN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ALLOWLIST_ENV,
  envPositiveInt,
  isPathInside,
  workspaceRoot,
  writeAudit,
} from "./constants.js";
import type {
  GovernedErrorPayload,
  GovernedToolName,
  JsonObject,
  ToolTextResult,
  UiqRunResult,
} from "./types.js";

const governedToolState = {
  callTimestampsMs: [] as number[],
  consumedBudgetMs: 0,
  reservedBudgetMs: 0,
};

function sanitizeGovernedErrorDetail(detail: string): string {
  let sanitized = detail;
  sanitized = sanitized.replace(/workspace=[^\s,]+/g, "workspace=[REDACTED_PATH]");
  sanitized = sanitized.replace(
    /([A-Za-z]:\\[^\s"'`]+|\/(?:Users|home|var|tmp|private|opt|etc)\/[^\s"'`]+)/g,
    "[REDACTED_PATH]",
  );
  sanitized = sanitized.replace(/\bENOENT\b[^:]*:\s*[^\n]+/g, "ENOENT: path redacted");
  return sanitized;
}

function governedRateLimitCalls(): number {
  return envPositiveInt(
    "UIQ_MCP_GOVERN_RATE_LIMIT_CALLS",
    DEFAULT_GOVERN_RATE_LIMIT_CALLS,
    1,
    1000,
  );
}

function governedRateLimitWindowSeconds(): number {
  return envPositiveInt(
    "UIQ_MCP_GOVERN_RATE_LIMIT_WINDOW_SECONDS",
    DEFAULT_GOVERN_RATE_LIMIT_WINDOW_SECONDS,
    1,
    3600,
  );
}

function governedTimeoutMs(): number {
  return envPositiveInt("UIQ_MCP_GOVERN_TIMEOUT_MS", DEFAULT_GOVERN_TIMEOUT_MS, 1, 30 * 60 * 1000);
}

function governedSessionBudgetMs(): number {
  return envPositiveInt(
    "UIQ_MCP_GOVERN_SESSION_BUDGET_MS",
    DEFAULT_GOVERN_SESSION_BUDGET_MS,
    1,
    24 * 60 * 60 * 1000,
  );
}

function normalizeWorkspaceAllowlist(): string[] {
  const raw = process.env[DEFAULT_WORKSPACE_ALLOWLIST_ENV]?.trim();
  const entries = raw
    ? raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [workspaceRoot()];
  if (entries.length === 0) {
    return [workspaceRoot()];
  }
  return entries.map((entry) => resolve(entry));
}

function governedWorkspaceAllowlist(): string[] {
  return normalizeWorkspaceAllowlist().map((entry) => {
    const normalized = entry.trim();
    if (!normalized) {
      throw new Error(`invalid workspace allowlist entry in ${DEFAULT_WORKSPACE_ALLOWLIST_ENV}`);
    }
    try {
      return realpathSync(normalized);
    } catch {
      throw new Error(`workspace allowlist path does not exist: ${normalized}`);
    }
  });
}

export function governedErrorPayload(
  tool: GovernedToolName,
  reasonCode: string,
  detail: string,
  meta?: JsonObject,
): GovernedErrorPayload {
  return {
    ok: false,
    tool,
    reasonCode,
    detail,
    ...(meta ? { meta } : {}),
  };
}

export function governedErrorResponse(
  tool: GovernedToolName,
  reasonCode: string,
  detail: string,
  meta?: JsonObject,
): ToolTextResult {
  const payload = governedErrorPayload(tool, reasonCode, detail, meta);
  writeAudit({ type: tool, ok: false, detail, meta: { reasonCode, ...(meta ?? {}) } });
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export function classifyGovernedToolError(
  tool: GovernedToolName,
  error: unknown,
): { reasonCode: string; detail: string; meta?: JsonObject } {
  const rawDetail = error instanceof Error ? error.message : String(error);
  const detail = sanitizeGovernedErrorDetail(rawDetail);
  if (detail.includes("workspace allowlist")) {
    return { reasonCode: "WORKSPACE_ALLOWLIST_INVALID", detail };
  }
  if (detail.includes("workspace is not allowlisted")) {
    return { reasonCode: "WORKSPACE_NOT_ALLOWLISTED", detail };
  }
  if (detail.includes("rate limit exceeded")) {
    return { reasonCode: "RATE_LIMIT_EXCEEDED", detail };
  }
  if (detail.includes("session budget exceeded")) {
    return { reasonCode: "BUDGET_EXCEEDED", detail };
  }
  if (detail.includes("timed out")) {
    return { reasonCode: "TIMEOUT_BUDGET_EXCEEDED", detail };
  }
  return { reasonCode: "TOOL_EXECUTION_FAILED", detail, meta: { tool } };
}

export function classifyRunFailureReasonCode(result: UiqRunResult): string {
  const detail = result.detail.toLowerCase();
  if (detail.includes("timed out") || detail.includes("etimedout")) {
    return "TIMEOUT_BUDGET_EXCEEDED";
  }
  if (detail.includes("invalid")) {
    return "INVALID_INPUT";
  }
  return "TOOL_EXECUTION_FAILED";
}

function assertGovernedWorkspaceAllowed(tool: GovernedToolName): void {
  const workspace = realpathSync(workspaceRoot());
  const allowlist = governedWorkspaceAllowlist();
  if (!allowlist.some((entry) => isPathInside(entry, workspace))) {
    throw new Error(`workspace is not allowlisted for ${tool}: workspace=${workspace}`);
  }
}

function enforceGovernedRateLimit(tool: GovernedToolName): void {
  const now = Date.now();
  const windowMs = governedRateLimitWindowSeconds() * 1000;
  const maxCalls = governedRateLimitCalls();
  governedToolState.callTimestampsMs = governedToolState.callTimestampsMs.filter(
    (ts) => now - ts < windowMs,
  );
  if (governedToolState.callTimestampsMs.length >= maxCalls) {
    throw new Error(
      `${tool} rate limit exceeded: ${maxCalls}/${governedRateLimitWindowSeconds()}s`,
    );
  }
  governedToolState.callTimestampsMs.push(now);
}

function reservedAndConsumedBudgetMs(): number {
  return governedToolState.consumedBudgetMs + governedToolState.reservedBudgetMs;
}

function reserveGovernedTimeoutMs(tool: GovernedToolName): number {
  const remainingBudgetMs = governedSessionBudgetMs() - reservedAndConsumedBudgetMs();
  if (remainingBudgetMs <= 0) {
    throw new Error(`${tool} session budget exceeded`);
  }
  const timeoutMs = Math.max(1, Math.min(governedTimeoutMs(), remainingBudgetMs));
  governedToolState.reservedBudgetMs += timeoutMs;
  return timeoutMs;
}

function releaseGovernedBudget(timeoutMs: number): void {
  governedToolState.reservedBudgetMs = Math.max(0, governedToolState.reservedBudgetMs - timeoutMs);
}

export async function withGovernedExecution<T>(
  tool: GovernedToolName,
  execute: (context: { timeoutMs: number }) => Promise<T>,
): Promise<T> {
  assertGovernedWorkspaceAllowed(tool);
  enforceGovernedRateLimit(tool);
  const timeoutMs = reserveGovernedTimeoutMs(tool);
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${tool} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([execute({ timeoutMs }), timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    releaseGovernedBudget(timeoutMs);
    governedToolState.consumedBudgetMs += Date.now() - startedAt;
  }
}

export const __governanceForTests = {
  resetState(): void {
    governedToolState.callTimestampsMs = [];
    governedToolState.consumedBudgetMs = 0;
    governedToolState.reservedBudgetMs = 0;
  },
  snapshotState(): { consumedBudgetMs: number; reservedBudgetMs: number; callCount: number } {
    return {
      consumedBudgetMs: governedToolState.consumedBudgetMs,
      reservedBudgetMs: governedToolState.reservedBudgetMs,
      callCount: governedToolState.callTimestampsMs.length,
    };
  },
};
