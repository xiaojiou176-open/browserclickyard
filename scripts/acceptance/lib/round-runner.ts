import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { redactObject } from "./redact.js";
import type {
  ApiRunStatus,
  AttemptRecord,
  RoundNumber,
  RoundRunsArtifact,
  RunnerOutcome,
  Severity,
  SubjectResult,
} from "./types.js";

export type Args = {
  startUrl: string;
  emailA: string;
  emailB: string;
  password: string;
  otpProvider: string;
  pollTimeoutSeconds: number;
  round: RoundNumber;
  retries: number;
  baseUrl: string;
  token?: string;
  otpCode?: string;
  resume: boolean;
  runIds: string[];
};

type RunLogEntry = { ts: string; level: string; message: string };
type RunSnapshot = {
  runId: string;
  status: ApiRunStatus;
  runnerOutcome: RunnerOutcome;
  reasonCode?: string;
  stepCursor?: number;
  taskId?: string;
  lastError?: string | null;
  logs: RunLogEntry[];
};

type ToolTextResult = { text: string; isError: boolean };

export type RoundExecution = {
  subjects: SubjectResult[];
  manualGatePending: boolean;
  manualGateRunIds: string[];
};

const WAITING_STATUSES = new Set<ApiRunStatus>(["waiting_otp", "waiting_user"]);
const RUNNER_STOP_STATUSES = new Set<ApiRunStatus>([
  "success",
  "failed",
  "cancelled",
  "blocked",
  "waiting_otp",
  "waiting_user",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringField(value: unknown, keys: string[]): string | undefined {
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

function readNumberField(value: unknown, keys: string[]): number | undefined {
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

function readLogs(value: unknown): RunLogEntry[] {
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

function readReasonCode(value: unknown): string | undefined {
  return readStringField(value, ["reason_code", "reasonCode"]);
}

function normalizeStatus(raw: unknown): ApiRunStatus {
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

function getSeverity(status: ApiRunStatus, attempt: number, retries: number): Severity {
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

function inferRootCause(snapshot: RunSnapshot, fallback?: string): string {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class McpToolsClient {
  private constructor(
    readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async connect(args: Args): Promise<McpToolsClient> {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", "services/mcp-server/src/server.ts"],
      cwd: repoRoot,
      stderr: "pipe",
      env: {
        ...process.env,
        UIQ_MCP_API_BASE_URL: args.baseUrl,
        AUTOMATION_BASE_URL: args.baseUrl,
        ...(args.token ? { AUTOMATION_API_TOKEN: args.token } : {}),
      },
    });

    const client = new Client({ name: "acceptance-round", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      return new McpToolsClient(client, transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async callToolText(
    name: string,
    toolArgs: Record<string, unknown> = {},
  ): Promise<ToolTextResult> {
    const res = await this.client.callTool({ name, arguments: toolArgs });
    const textPart = res.content.find(
      (item): item is { type: "text"; text: string } => item.type === "text",
    );
    return {
      text: textPart?.text ?? "",
      isError: Boolean(res.isError),
    };
  }

  async callToolJson<T = unknown>(
    name: string,
    toolArgs: Record<string, unknown> = {},
  ): Promise<{ data: T; isError: boolean }> {
    const { text, isError } = await this.callToolText(name, toolArgs);
    try {
      return { data: JSON.parse(text) as T, isError };
    } catch {
      throw new Error(`tool ${name} returned non-json payload`);
    }
  }
}

function extractTemplateId(payload: unknown): string {
  const rec = asRecord(payload);
  const template = rec?.template;
  const id = readStringField(template, ["template_id", "templateId"]);
  if (!id) {
    throw new Error("teach did not return template_id");
  }
  return id;
}

function extractRunSnapshot(payload: unknown): RunSnapshot {
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

export async function startRuntime(client: McpToolsClient): Promise<void> {
  const { data, isError } = await client.callToolJson<Record<string, unknown>>(
    "uiq_backend_runtime",
    { action: "start" },
  );
  if (isError) {
    throw new Error(`uiq_backend_runtime(start) failed: ${JSON.stringify(redactObject(data))}`);
  }
}

async function teachTemplate(client: McpToolsClient, args: Args): Promise<string> {
  const { data, isError } = await client.callToolJson<Record<string, unknown>>(
    "uiq_register_orchestrate",
    {
      action: "teach",
      startUrl: args.startUrl,
      email: args.emailA,
      password: args.password,
      otpProvider: args.otpProvider,
      pollTimeoutSeconds: args.pollTimeoutSeconds,
      pollIntervalSeconds: 2,
    },
  );

  if (isError) {
    throw new Error(
      `uiq_register_orchestrate(teach) failed: ${JSON.stringify(redactObject(data))}`,
    );
  }

  return extractTemplateId(data);
}

async function pollRunState(
  client: McpToolsClient,
  runId: string,
  timeoutSeconds: number,
): Promise<RunSnapshot> {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < timeoutSeconds) {
    const { data, isError } = await client.callToolJson<Record<string, unknown>>(
      "uiq_register_state",
      { runId },
    );
    if (isError) {
      return {
        runId,
        status: "failed",
        runnerOutcome: "api_error",
        reasonCode: "acceptance.api_state_error",
        lastError: `uiq_register_state failed for runId=${runId}`,
        logs: [],
      };
    }

    const run = asRecord(data.run);
    if (run) {
      const snapshot = {
        runId: readStringField(run, ["run_id", "runId"]) ?? runId,
        status: normalizeStatus(run.status),
        runnerOutcome: "ok",
        reasonCode: readReasonCode(run),
        stepCursor: readNumberField(run, ["step_cursor", "stepCursor"]),
        taskId: readStringField(run, ["task_id", "taskId"]),
        lastError: readStringField(run, ["last_error", "lastError"]),
        logs: readLogs(run),
      } satisfies RunSnapshot;

      if (RUNNER_STOP_STATUSES.has(snapshot.status)) {
        return snapshot;
      }
    }

    await sleep(2000);
  }

  return {
    runId,
    status: "failed",
    runnerOutcome: "timeout",
    reasonCode: "acceptance.poll_timeout",
    lastError: `poll timeout after ${timeoutSeconds}s`,
    logs: [
      {
        ts: new Date().toISOString(),
        level: "error",
        message: `poll timeout after ${timeoutSeconds}s`,
      },
    ],
  };
}

function toAttemptRecord(input: {
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

async function cloneThenPoll(
  client: McpToolsClient,
  args: Args,
  templateId: string,
  email: string,
): Promise<RunSnapshot> {
  const { data, isError } = await client.callToolJson<Record<string, unknown>>(
    "uiq_register_orchestrate",
    {
      action: "clone",
      templateId,
      email,
      password: args.password,
      otpCode: args.otpCode,
      otpProvider: args.otpProvider,
      pollTimeoutSeconds: args.pollTimeoutSeconds,
      pollIntervalSeconds: 2,
    },
  );
  if (isError) {
    return {
      runId: "unknown",
      status: "failed",
      runnerOutcome: "api_error",
      reasonCode: "acceptance.clone_error",
      lastError: `clone failed: ${JSON.stringify(redactObject(data))}`,
      logs: [],
    };
  }

  const cloned = extractRunSnapshot(data);
  if (!cloned.runId || cloned.runId === "unknown") {
    return {
      runId: "unknown",
      status: "failed",
      runnerOutcome: "parse_error",
      reasonCode: "acceptance.clone_missing_run_id",
      lastError: "clone did not return runId",
      logs: [],
    };
  }

  return pollRunState(client, cloned.runId, args.pollTimeoutSeconds);
}

async function resumeThenPoll(
  client: McpToolsClient,
  args: Args,
  runId: string,
): Promise<RunSnapshot> {
  const { data, isError } = await client.callToolJson<Record<string, unknown>>(
    "uiq_register_orchestrate",
    {
      action: "resume",
      runId,
      otpCode: args.otpCode,
      otpProvider: args.otpProvider,
      pollTimeoutSeconds: args.pollTimeoutSeconds,
      pollIntervalSeconds: 2,
    },
  );
  if (isError) {
    return {
      runId,
      status: "failed",
      runnerOutcome: "api_error",
      reasonCode: "acceptance.resume_error",
      lastError: `resume failed: ${JSON.stringify(redactObject(data))}`,
      logs: [],
    };
  }

  const resumed = extractRunSnapshot(data);
  return pollRunState(client, resumed.runId || runId, args.pollTimeoutSeconds);
}

async function runRound1(client: McpToolsClient, args: Args): Promise<RoundExecution> {
  const templateId = await teachTemplate(client, args);
  const attempts: AttemptRecord[] = [];

  const cloneStartedAt = new Date().toISOString();
  const cloneSnapshot = await cloneThenPoll(client, args, templateId, args.emailA);
  const cloneFinishedAt = new Date().toISOString();
  const cloneSeverity = getSeverity(cloneSnapshot.status, 1, 1);
  const cloneRootCause = inferRootCause(
    cloneSnapshot,
    cloneSnapshot.status === "success" ? "completed" : "round1 clone incomplete",
  );
  attempts.push(
    toAttemptRecord({
      attempt: 1,
      startedAt: cloneStartedAt,
      finishedAt: cloneFinishedAt,
      severity: cloneSeverity,
      rootCause: cloneRootCause,
      snapshot: cloneSnapshot,
    }),
  );

  let finalSnapshot = cloneSnapshot;
  if (WAITING_STATUSES.has(cloneSnapshot.status)) {
    const resumeStartedAt = new Date().toISOString();
    const resumeSnapshot = await resumeThenPoll(client, args, cloneSnapshot.runId);
    const resumeFinishedAt = new Date().toISOString();
    const resumeSeverity = getSeverity(resumeSnapshot.status, 2, 2);
    const resumeRootCause = inferRootCause(
      resumeSnapshot,
      resumeSnapshot.status === "success" ? "completed after resume" : "round1 resume incomplete",
    );
    attempts.push(
      toAttemptRecord({
        attempt: 2,
        startedAt: resumeStartedAt,
        finishedAt: resumeFinishedAt,
        severity: resumeSeverity,
        rootCause: resumeRootCause,
        snapshot: resumeSnapshot,
      }),
    );
    finalSnapshot = resumeSnapshot;
  }

  const finalSeverity =
    attempts[attempts.length - 1]?.severity ?? getSeverity(finalSnapshot.status, 1, 1);
  const subject: SubjectResult = {
    subject: "emailA",
    email: args.emailA,
    finalStatus: finalSnapshot.status,
    runnerOutcome: finalSnapshot.runnerOutcome,
    reasonCode: finalSnapshot.reasonCode,
    severity: finalSeverity,
    pass: finalSnapshot.status === "success",
    rootCause: attempts[attempts.length - 1]?.rootCause ?? "unknown",
    attempts,
  };

  return { subjects: [subject], manualGatePending: false, manualGateRunIds: [] };
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

async function runRound2(client: McpToolsClient, args: Args): Promise<RoundExecution> {
  const templateId = await teachTemplate(client, args);
  const attempts: AttemptRecord[] = [];
  const durationsMs: number[] = [];

  for (let i = 0; i < 3; i += 1) {
    const attempt = i + 1;
    const startedAt = new Date().toISOString();
    const startedTs = Date.now();
    const snapshot = await cloneThenPoll(client, args, templateId, args.emailB);
    const finishedAt = new Date().toISOString();
    durationsMs.push(Date.now() - startedTs);
    const severity = getSeverity(snapshot.status, attempt, 3);
    const rootCause = inferRootCause(
      snapshot,
      snapshot.status === "success" ? "completed" : `round2 clone-${attempt} incomplete`,
    );
    attempts.push(
      toAttemptRecord({ attempt, startedAt, finishedAt, severity, rootCause, snapshot }),
    );
  }

  const successCount = attempts.filter((item) => item.status === "success").length;
  const total = attempts.length;
  const successRate = total === 0 ? 0 : successCount / total;
  const avgMs =
    total === 0 ? 0 : Math.round(durationsMs.reduce((acc, cur) => acc + cur, 0) / total);
  const p95Ms = Math.round(percentile95(durationsMs));

  const aggregateStatus: ApiRunStatus = successRate === 1 ? "success" : "failed";
  const aggregateSeverity: Severity = successRate === 1 ? "NONE" : successRate === 0 ? "P0" : "P1";
  const aggregateRunnerOutcome: RunnerOutcome = successRate === 1 ? "ok" : "synthetic_aggregate";
  const aggregateReasonCode =
    successRate === 1
      ? undefined
      : successRate === 0
        ? "acceptance.round2_all_failed"
        : "acceptance.round2_partial_success";
  const aggregateRootCause = `otp_success_rate=${(successRate * 100).toFixed(2)}% (${successCount}/${total}), avg_ms=${avgMs}, p95_ms=${p95Ms}`;

  const subject: SubjectResult = {
    subject: "emailB",
    email: args.emailB,
    finalStatus: aggregateStatus,
    runnerOutcome: aggregateRunnerOutcome,
    reasonCode: aggregateReasonCode,
    severity: aggregateSeverity,
    pass: successRate === 1,
    rootCause: aggregateRootCause,
    attempts,
  };

  return { subjects: [subject], manualGatePending: false, manualGateRunIds: [] };
}

async function runRound3Phase1(client: McpToolsClient, args: Args): Promise<RoundExecution> {
  const templateId = await teachTemplate(client, args);
  const startedAt = new Date().toISOString();
  const snapshot = await cloneThenPoll(client, args, templateId, args.emailA);
  const finishedAt = new Date().toISOString();

  const waiting = WAITING_STATUSES.has(snapshot.status);
  const normalizedStatus: ApiRunStatus = snapshot.status;
  const runnerOutcome: RunnerOutcome = waiting ? "manual_gate" : snapshot.runnerOutcome;
  const reasonCode = waiting ? "acceptance.manual_gate_required" : snapshot.reasonCode;
  const severity: Severity = waiting ? "P1" : getSeverity(snapshot.status, 1, 1);
  const rootCause = waiting
    ? "manual gate required for round 3"
    : inferRootCause(snapshot, "round3 clone completed without manual gate");
  const attempt = toAttemptRecord({
    attempt: 1,
    startedAt,
    finishedAt,
    severity,
    rootCause,
    snapshot: { ...snapshot, status: normalizedStatus, runnerOutcome, reasonCode },
  });

  const subject: SubjectResult = {
    subject: "emailA",
    email: args.emailA,
    finalStatus: normalizedStatus,
    runnerOutcome,
    reasonCode,
    severity,
    pass: false,
    rootCause,
    attempts: [attempt],
  };

  return {
    subjects: [subject],
    manualGatePending: waiting,
    manualGateRunIds: waiting && snapshot.runId ? [snapshot.runId] : [],
  };
}

async function runRound3Resume(client: McpToolsClient, args: Args): Promise<RoundExecution> {
  const subjects: SubjectResult[] = [];
  for (let i = 0; i < args.runIds.length; i += 1) {
    const runId = args.runIds[i]?.trim();
    if (!runId) {
      continue;
    }
    const startedAt = new Date().toISOString();
    const snapshot = await resumeThenPoll(client, args, runId);
    const finishedAt = new Date().toISOString();
    const severity = getSeverity(snapshot.status, 1, 1);
    const rootCause = inferRootCause(
      snapshot,
      snapshot.status === "success" ? "completed" : "round3 resume incomplete",
    );

    const subject: SubjectResult = {
      subject: i === 0 ? "emailA" : i === 1 ? "emailB" : `run-${i + 1}`,
      email: i === 0 ? args.emailA : i === 1 ? args.emailB : "<unknown>",
      finalStatus: snapshot.status,
      runnerOutcome: snapshot.runnerOutcome,
      reasonCode: snapshot.reasonCode,
      severity,
      pass: snapshot.status === "success",
      rootCause,
      attempts: [
        toAttemptRecord({
          attempt: 1,
          startedAt,
          finishedAt,
          severity,
          rootCause,
          snapshot,
        }),
      ],
    };
    subjects.push(subject);
  }

  return { subjects, manualGatePending: false, manualGateRunIds: [] };
}

export function buildSummary(
  subjects: SubjectResult[],
  manualGatePending: boolean,
): RoundRunsArtifact["summary"] {
  const passedCount = subjects.filter((item) => item.pass).length;
  const failedCount = subjects.length - passedCount;
  const severityCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, NONE: 0 };
  for (const item of subjects) {
    severityCounts[item.severity] = (severityCounts[item.severity] ?? 0) + 1;
  }

  if (manualGatePending) {
    return {
      pass: false,
      status: "PAUSED",
      subjectCount: subjects.length,
      passedCount,
      failedCount,
      severityCounts,
    };
  }

  return {
    pass: failedCount === 0,
    status: failedCount === 0 ? "PASS" : "FAIL",
    subjectCount: subjects.length,
    passedCount,
    failedCount,
    severityCounts,
  };
}

export async function executeRound(client: McpToolsClient, args: Args): Promise<RoundExecution> {
  if (args.round === 1) {
    return runRound1(client, args);
  }
  if (args.round === 2) {
    return runRound2(client, args);
  }

  if (args.resume) {
    if (args.runIds.length === 0) {
      throw new Error("round 3 resume requires --runIds");
    }
    return runRound3Resume(client, args);
  }
  return runRound3Phase1(client, args);
}
