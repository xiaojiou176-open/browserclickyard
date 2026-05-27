#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { redactErrorMessage, redactObject } from "./lib/redact.js";
import {
  asRecord,
  extractRunSnapshot,
  extractTemplateId,
  getSeverity,
  inferRootCause,
  normalizeStatus,
  percentile95,
  RUNNER_STOP_STATUSES,
  type RunSnapshot,
  readLogs,
  readNumberField,
  readReasonCode,
  readStringField,
  sleep,
  toAttemptRecord,
  WAITING_STATUSES,
} from "./lib/round-runtime.js";
import type {
  ApiRunStatus,
  RoundNumber,
  RoundRunsArtifact,
  RunnerOutcome,
  Severity,
  SubjectResult,
} from "./lib/types.js";

type Args = {
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

type ToolTextResult = { text: string; isError: boolean };

type RoundExecution = {
  subjects: SubjectResult[];
  manualGatePending: boolean;
  manualGateRunIds: string[];
};

const _HELP_TEXT = `Acceptance round runner (MCP tools chain)

Usage:
  pnpm acceptance:round -- --round <1|2|3> --startUrl <url> --emailA <email> --emailB <email> --password <secret>

Required args (or env fallback):
  --startUrl              env START_URL
  --emailA                env EMAIL_A
  --emailB                env EMAIL_B
  --password              env PASSWORD
  --round                 required cli arg

Round 3 resume-only minimum:
  --round 3 --resume --runIds <id1,id2> [--otpCode <6-digit-code>]

Optional args (or env fallback):
  --baseUrl               env UIQ_MCP_API_BASE_URL | BASE_URL (default http://127.0.0.1:18080)
  --token                 env AUTOMATION_API_TOKEN | AUTOMATION_API_TOKEN
  --otpProvider           env OTP_PROVIDER (default manual)
  --pollTimeoutSeconds    default 120
  --retries               default 1
  --otpCode               env OTP_CODE
  --resume                cli flag
  --runIds <id1,id2>      comma-separated run IDs for resume

Round behavior:
  - Round1: teach -> clone(emailA) -> poll; waiting state triggers one resume attempt.
  - Round2: teach -> clone(emailB) x3; computes OTP success-rate and timing stats.
  - Round3 phase1: teach -> clone(emailA) and stop at manual gate with actionable output.
  - Round3 resume: --resume --runIds <ids> [--otpCode 123456] then poll to terminal.
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function asBool(v: string | boolean | undefined): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  if (!v) {
    return false;
  }
  return ["1", "true", "yes", "y"].includes(v.toLowerCase());
}

function asInt(v: string | undefined, fallback: number): number {
  if (!v) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`missing required input: ${name}`);
  }
  return value;
}

class McpToolsClient {
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

async function startRuntime(client: McpToolsClient): Promise<void> {
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

async function _runRound1(client: McpToolsClient, args: Args): Promise<RoundExecution> {
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

async function _runRound2(client: McpToolsClient, args: Args): Promise<RoundExecution> {
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

async function _runRound3Phase1(client: McpToolsClient, args: Args): Promise<RoundExecution> {
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

async function _runRound3Resume(client: McpToolsClient, args: Args): Promise<RoundExecution> {
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

function buildSummary(
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

async function writeArtifacts(
  payload: RoundRunsArtifact,
): Promise<{ runsPath: string; summaryPath: string }> {
  const outDir = path.resolve(".runtime-cache/artifacts/acceptance");
  await mkdir(outDir, { recursive: true });
  const runsPath = path.resolve(outDir, `round-${payload.round}-runs.json`);
  const summaryPath = path.resolve(outDir, `round-${payload.round}-summary.md`);

  const safePayload = redactObject(payload);
  await writeFile(runsPath, `${JSON.stringify(safePayload, null, 2)}\n`, "utf8");

  const lines: string[] = [];
  lines.push(`# Acceptance Round ${payload.round} Summary`);
  lines.push("");
  lines.push(`- Generated: ${payload.generatedAt}`);
  lines.push(`- Mode: ${payload.runMode}`);
  lines.push(`- Result: **${payload.summary.status}**`);
  lines.push(`- Pass: ${payload.summary.pass}`);
  lines.push(`- Subjects: ${payload.summary.passedCount}/${payload.summary.subjectCount} passed`);
  lines.push(
    `- Severity: P0=${payload.summary.severityCounts.P0 ?? 0}, P1=${payload.summary.severityCounts.P1 ?? 0}, P2=${payload.summary.severityCounts.P2 ?? 0}`,
  );
  lines.push("");

  if (payload.manualGatePending) {
    lines.push("## Manual Gate");
    lines.push("");
    lines.push("Round 3 is paused at manual gate. Resume with:");
    lines.push("");
    lines.push("```bash");
    lines.push(
      `pnpm acceptance:round -- --round 3 --resume --runIds ${payload.manualGateRunIds.join(",")} --startUrl "${payload.startUrl}" --emailA "${payload.subjects[0]?.email ?? ""}" --emailB "${payload.subjects[1]?.email ?? ""}" --password "<redacted>"`,
    );
    lines.push("```");
    lines.push("");
  }

  lines.push("## Per Subject");
  lines.push("");
  lines.push("| Subject | Final Status | Pass | Severity | Root Cause |");
  lines.push("|---|---|---:|---|---|");
  for (const subject of payload.subjects) {
    lines.push(
      `| ${subject.subject} | ${subject.finalStatus} | ${subject.pass} | ${subject.severity} | ${subject.rootCause} |`,
    );
  }

  lines.push("");
  lines.push("## Root Causes");
  lines.push("");
  for (const subject of payload.subjects) {
    lines.push(`- ${subject.subject}: ${subject.rootCause}`);
  }

  await writeFile(summaryPath, `${redactObject(lines).join("\n")}\n`, "utf8");
  return { runsPath, summaryPath };
}

function loadConfig(): Args {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help || cli.h) {
    process.exit(0);
  }

  const baseUrl =
    (cli.baseUrl as string | undefined) ||
    process.env.UIQ_MCP_API_BASE_URL ||
    process.env.BASE_URL ||
    "http://127.0.0.1:18080";

  const roundRaw = (cli.round as string | undefined) || "";
  const roundNum = Number.parseInt(roundRaw, 10);
  if (![1, 2, 3].includes(roundNum)) {
    throw new Error(`invalid round: ${roundRaw || "<empty>"}, expected 1|2|3`);
  }

  const retriesRaw = asInt(cli.retries as string | undefined, 1);
  const retries = Math.max(0, Math.min(1, retriesRaw));
  const resume = asBool(cli.resume as string | boolean | undefined);
  const resumeOnly = roundNum === 3 && resume;

  const startUrl = (cli.startUrl as string | undefined) || process.env.START_URL || "";
  const emailA = (cli.emailA as string | undefined) || process.env.EMAIL_A || "<resume-email-a>";
  const emailB = (cli.emailB as string | undefined) || process.env.EMAIL_B || "<resume-email-b>";
  const password =
    (cli.password as string | undefined) || process.env.PASSWORD || "<resume-password>";

  return {
    startUrl: resumeOnly ? startUrl : required("startUrl", startUrl),
    emailA: resumeOnly ? emailA : required("emailA", emailA),
    emailB: resumeOnly ? emailB : required("emailB", emailB),
    password: resumeOnly ? password : required("password", password),
    otpProvider: (
      (cli.otpProvider as string | undefined) ||
      process.env.OTP_PROVIDER ||
      "manual"
    ).trim(),
    pollTimeoutSeconds: asInt(cli.pollTimeoutSeconds as string | undefined, 120),
    round: roundNum as RoundNumber,
    retries,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token:
      (cli.token as string | undefined) ||
      process.env.AUTOMATION_API_TOKEN ||
      process.env.AUTOMATION_API_TOKEN ||
      undefined,
    otpCode: (cli.otpCode as string | undefined) || process.env.OTP_CODE || undefined,
    resume,
    runIds: ((cli.runIds as string | undefined) || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

async function main(): Promise<void> {
  const args = loadConfig();
  const mcp = await McpToolsClient.connect(args);

  try {
    await startRuntime(mcp);

    const execution = await executeRound(mcp, args);
    const payload: RoundRunsArtifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      round: args.round,
      resume: args.resume,
      baseUrl: args.baseUrl,
      startUrl: args.startUrl,
      otpProvider: args.otpProvider,
      pollTimeoutSeconds: args.pollTimeoutSeconds,
      retries: args.retries,
      runMode: "mcp_tools",
      manualGatePending: execution.manualGatePending,
      manualGateRunIds: execution.manualGateRunIds,
      summary: buildSummary(execution.subjects, execution.manualGatePending),
      subjects: execution.subjects,
    };

    const { runsPath, summaryPath } = await writeArtifacts(payload);

    if (payload.manualGatePending) {
      process.exit(20);
    }

    process.exit(payload.summary.pass ? 0 : 1);
  } finally {
    await mcp.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const _safe = redactErrorMessage(error);
  process.exit(1);
});
