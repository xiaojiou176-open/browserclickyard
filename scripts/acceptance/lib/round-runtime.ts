import type { ApiRunStatus, AttemptRecord, RunnerOutcome, Severity } from "./types.js";

export type RunLogEntry = { ts: string; level: string; message: string };

export type RunSnapshot = {
  runId: string;
  status: ApiRunStatus;
  runnerOutcome: RunnerOutcome;
  reasonCode?: string;
  stepCursor?: number;
  taskId?: string;
  lastError?: string | null;
  logs: RunLogEntry[];
};

export const WAITING_STATUSES = new Set<ApiRunStatus>(["waiting_otp", "waiting_user"]);

export const RUNNER_STOP_STATUSES = new Set<ApiRunStatus>([
  "success",
  "failed",
  "cancelled",
  "blocked",
  "waiting_otp",
  "waiting_user",
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function readStringField(value: unknown, keys: string[]): string | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw;
    }
  }
  return undefined;
}

export function readNumberField(value: unknown, keys: string[]): number | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  return undefined;
}

export function readLogs(value: unknown): RunLogEntry[] {
  const rec = asRecord(value);
  const raw = rec?.logs;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const entry = asRecord(item);
      if (!entry) {
        return null;
      }
      const ts = typeof entry.ts === "string" ? entry.ts : new Date().toISOString();
      const level = typeof entry.level === "string" ? entry.level : "info";
      const message = typeof entry.message === "string" ? entry.message : "";
      return { ts, level, message };
    })
    .filter((item): item is RunLogEntry => Boolean(item));
}

export function readReasonCode(value: unknown): string | undefined {
  return readStringField(value, ["reason_code", "reasonCode"]);
}

export function normalizeStatus(raw: unknown): ApiRunStatus {
  if (typeof raw !== "string") {
    return "failed";
  }
  const status = raw.trim().toLowerCase();
  switch (status) {
    case "queued":
    case "running":
    case "waiting_user":
    case "waiting_otp":
    case "success":
    case "failed":
    case "cancelled":
    case "blocked":
      return status;
    default:
      return "failed";
  }
}

export function getSeverity(status: ApiRunStatus, attempt: number, retries: number): Severity {
  if (status === "success") {
    return attempt > 1 ? "P2" : "NONE";
  }
  if (WAITING_STATUSES.has(status)) {
    return "P1";
  }
  if (status === "failed" || status === "cancelled" || status === "blocked") {
    return attempt > retries ? "P0" : "P1";
  }
  return "P2";
}

export function inferRootCause(snapshot: RunSnapshot, fallback?: string): string {
  if (snapshot.lastError && snapshot.lastError.trim().length > 0) {
    return snapshot.lastError;
  }
  const errorLog = [...snapshot.logs]
    .reverse()
    .find((item) => item.level === "error" || /fail|error|timeout|denied|otp/i.test(item.message));
  if (errorLog?.message) {
    return errorLog.message;
  }
  return fallback ?? "unknown";
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractTemplateId(payload: unknown): string {
  const rec = asRecord(payload);
  const template = rec?.template;
  const id = readStringField(template, ["template_id", "templateId"]);
  if (!id) {
    throw new Error("teach did not return template_id");
  }
  return id;
}

export function extractRunSnapshot(payload: unknown): RunSnapshot {
  const rec = asRecord(payload) ?? {};
  const candidateRun = (asRecord(rec.terminalRun) ??
    asRecord(rec.run) ??
    asRecord(rec.createdRun) ??
    {}) as Record<string, unknown>;
  const runId = readStringField(candidateRun, ["run_id", "runId"]) ?? "unknown";
  const reasonCode = readReasonCode(candidateRun) ?? readReasonCode(rec);
  const status = normalizeStatus(candidateRun.status ?? rec.status);
  return {
    runId,
    status,
    runnerOutcome: "ok",
    reasonCode,
    stepCursor: readNumberField(candidateRun, ["step_cursor", "stepCursor"]),
    taskId: readStringField(candidateRun, ["task_id", "taskId"]),
    lastError: readStringField(candidateRun, ["last_error", "lastError"]),
    logs: readLogs(candidateRun),
  };
}

export function toAttemptRecord(input: {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  severity: Severity;
  rootCause: string;
  snapshot: RunSnapshot;
}): AttemptRecord {
  return {
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.snapshot.status,
    runnerOutcome: input.snapshot.runnerOutcome,
    reasonCode: input.snapshot.reasonCode,
    severity: input.severity,
    retryUsed: input.attempt > 1,
    rootCause: input.rootCause,
    runId: input.snapshot.runId,
    taskId: input.snapshot.taskId,
    stepCursor: input.snapshot.stepCursor,
    lastError: input.snapshot.lastError,
    logs: input.snapshot.logs.map((log) => ({ ...log })),
  };
}

export function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}
