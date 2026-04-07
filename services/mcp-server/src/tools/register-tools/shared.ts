// @ts-nocheck
// 
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  apiGetRun,
  apiSubmitRunOtp,
  backendBaseUrl,
  parseRunStatus,
} from "../../core/api-client.js";
import {
  DEFAULT_UIQ_SYNC_TIMEOUT_MS,
  ensureDir,
  readJson,
  readUtf8,
  repoRoot,
  runsRoot,
  STREAM_EVENT_CAP,
  STREAM_STDERR_LINE_CAP,
  STREAM_STDOUT_LINE_CAP,
  safeResolveUnder,
  sleep,
  workspaceRoot,
  writeAudit,
} from "../../core/constants.js";
import { redactSensitiveLine, redactSensitiveText } from "../../core/redaction.js";
import type { JsonObject, RunOverrideValues, StreamEvent, UiqRunResult } from "../../core/types.js";

export function listRunIds(limit = 20): string[] {
  const root = runsRoot();
  if (!ensureDir(root)) {
    return [];
  }
  return readdirSync(root)
    .map((name) => {
      const abs = resolve(root, name);
      const stat = statSync(abs);
      return { name, mtimeMs: stat.mtimeMs, isDir: stat.isDirectory() };
    })
    .filter((d) => d.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map((d) => d.name);
}

export function latestRunId(): string | undefined {
  return listRunIds(1)[0];
}

function parseRunResult(output: string): { runId?: string; manifest?: string } {
  const lines = output.split("\n");
  let runId: string | undefined;
  let manifest: string | undefined;
  for (const line of lines) {
    if (line.startsWith("runId=")) {
      runId = line.slice("runId=".length).trim();
    }
    if (line.startsWith("manifest=")) {
      manifest = line.slice("manifest=".length).trim();
    }
  }
  return { runId, manifest };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function appendRunOverrides(args: string[], overrides: RunOverrideValues): void {
  const push = (flag: string, value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }
    args.push(flag, String(value));
  };
  push("--base-url", overrides.baseUrl);
  push("--app", overrides.app);
  push("--bundle-id", overrides.bundleId);
  push("--diagnostics-max-items", overrides.diagnosticsMaxItems);
  push("--explore-budget-seconds", overrides.exploreBudgetSeconds);
  push("--explore-max-depth", overrides.exploreMaxDepth);
  push("--explore-max-states", overrides.exploreMaxStates);
  push("--chaos-seed", overrides.chaosSeed);
  push("--chaos-budget-seconds", overrides.chaosBudgetSeconds);
  push("--chaos-ratio-click", overrides.chaosClickRatio);
  push("--chaos-ratio-input", overrides.chaosInputRatio);
  push("--chaos-ratio-scroll", overrides.chaosScrollRatio);
  push("--chaos-ratio-keyboard", overrides.chaosKeyboardRatio);
  push("--load-vus", overrides.loadVus);
  push("--load-duration-seconds", overrides.loadDurationSeconds);
  push("--load-request-timeout-ms", overrides.loadRequestTimeoutMs);
  push("--load-engine", overrides.loadEngine);
  push("--a11y-max-issues", overrides.a11yMaxIssues);
  push("--a11y-engine", overrides.a11yEngine);
  push("--perf-preset", overrides.perfPreset);
  push("--perf-engine", overrides.perfEngine);
  push("--visual-mode", overrides.visualMode);
  push("--soak-duration-seconds", overrides.soakDurationSeconds);
  push("--soak-interval-seconds", overrides.soakIntervalSeconds);
  if (typeof overrides.autostartTarget === "boolean") {
    push("--autostart-target", overrides.autostartTarget ? "true" : "false");
  }
}

export function desktopInputWarnings(params: {
  command?: string;
  profile?: string;
  target?: string;
  app?: string;
  bundleId?: string;
}): string[] {
  const { command, profile, target, app, bundleId } = params;
  const targetText = target ?? "";
  const profileText = profile ?? "";
  const commandText = command ?? "";
  const isTauri =
    targetText.startsWith("tauri") ||
    profileText.startsWith("tauri.") ||
    commandText.startsWith("desktop-");
  const isSwift =
    targetText.startsWith("swift") ||
    profileText.startsWith("swift.") ||
    commandText.startsWith("desktop-");
  const warnings: string[] = [];
  if (isTauri && !app) {
    warnings.push("desktop target requires explicit --app; missing input will return blocked");
  }
  if (isSwift && !bundleId) {
    warnings.push(
      "desktop target requires explicit --bundle-id; missing input will return blocked",
    );
  }
  return warnings;
}

function uiqInvocation(args: string[]): { command: string; args: string[] } {
  const localFakeBin = resolve(workspaceRoot(), ".runtime-cache/bin/uiq");
  if (existsSync(localFakeBin)) {
    return { command: localFakeBin, args };
  }
  return { command: "pnpm", args: ["uiq", ...args] };
}

function automationTeachInvocation(command: string): { command: string; args: string[] } {
  const fake = process.env.UIQ_MCP_FAKE_AUTOMATION_TEACH_BIN?.trim();
  if (fake) {
    return { command: fake, args: [command] };
  }
  return { command: "pnpm", args: ["-C", "automation", command] };
}

export function runUiqSync(args: string[], timeoutMs = DEFAULT_UIQ_SYNC_TIMEOUT_MS): UiqRunResult {
  const invocation = uiqInvocation(args);
  const proc = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const rawStdout = proc.stdout ?? "";
  const rawStderr = proc.stderr ?? "";
  const parsed = parseRunResult(`${rawStdout}\n${rawStderr}`);
  const stdout = redactSensitiveText(rawStdout);
  const stderr = redactSensitiveText(rawStderr);
  if (proc.error) {
    const result = {
      ok: false,
      detail: `uiq execution error: ${(proc.error as Error).message}`,
      stdout,
      stderr,
      runId: parsed.runId,
      manifest: parsed.manifest,
      exitCode: proc.status,
    };
    writeAudit({
      type: "uiq_run_sync",
      ok: false,
      detail: result.detail,
      meta: { argCount: args.length },
    });
    return result;
  }
  const ok = proc.status === 0;
  const result = {
    ok,
    detail: ok ? "ok" : `uiq exited with code ${proc.status}`,
    stdout,
    stderr,
    runId: parsed.runId,
    manifest: parsed.manifest,
    exitCode: proc.status,
  };
  writeAudit({
    type: "uiq_run_sync",
    ok: result.ok,
    detail: result.detail,
    meta: { runId: result.runId ?? null, manifest: result.manifest ?? null },
  });
  return result;
}

export async function runUiqStream(
  args: string[],
  timeoutMs: number,
): Promise<
  UiqRunResult & {
    events: StreamEvent[];
    elapsedMs: number;
    timedOut: boolean;
    killStage: "none" | "sigterm" | "sigkill";
  }
> {
  const startedAt = Date.now();
  const events: StreamEvent[] = [];
  const invocation = uiqInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let droppedStdoutLines = 0;
  let droppedStderrLines = 0;
  let droppedEvents = 0;
  let inlineRunId: string | undefined;
  let inlineManifest: string | undefined;

  const pushBounded = <T>(arr: T[], item: T, cap: number): boolean => {
    if (arr.length < cap) {
      arr.push(item);
      return false;
    }
    arr.shift();
    arr.push(item);
    return true;
  };

  const outRl = createInterface({ input: child.stdout });
  outRl.on("line", (line) => {
    const redactedLine = redactSensitiveLine(line);
    if (pushBounded(stdoutLines, redactedLine, STREAM_STDOUT_LINE_CAP)) {
      droppedStdoutLines += 1;
    }
    const event: StreamEvent = {
      ts: new Date().toISOString(),
      stream: "stdout",
      line: redactedLine,
    };
    if (pushBounded(events, event, STREAM_EVENT_CAP)) {
      droppedEvents += 1;
    }
    if (line.startsWith("runId=")) {
      inlineRunId = line.slice("runId=".length).trim();
    }
    if (line.startsWith("manifest=")) {
      inlineManifest = line.slice("manifest=".length).trim();
    }
  });

  const errRl = createInterface({ input: child.stderr });
  errRl.on("line", (line) => {
    const redactedLine = redactSensitiveLine(line);
    if (pushBounded(stderrLines, redactedLine, STREAM_STDERR_LINE_CAP)) {
      droppedStderrLines += 1;
    }
    const event: StreamEvent = {
      ts: new Date().toISOString(),
      stream: "stderr",
      line: redactedLine,
    };
    if (pushBounded(events, event, STREAM_EVENT_CAP)) {
      droppedEvents += 1;
    }
    if (line.startsWith("runId=")) {
      inlineRunId = line.slice("runId=".length).trim();
    }
    if (line.startsWith("manifest=")) {
      inlineManifest = line.slice("manifest=".length).trim();
    }
  });

  let timedOut = false;
  let killStage: "none" | "sigterm" | "sigkill" = "none";
  let killFallbackHandle: NodeJS.Timeout | undefined;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killStage = "sigterm";
    child.kill("SIGTERM");
    killFallbackHandle = setTimeout(() => {
      if (!isProcessAlive(child.pid ?? -1)) {
        return;
      }
      killStage = "sigkill";
      child.kill("SIGKILL");
    }, 1_000);
  }, timeoutMs);

  await new Promise<void>((resolveDone) => {
    child.on("close", () => resolveDone());
    child.on("error", () => resolveDone());
  });

  clearTimeout(timeoutHandle);
  if (killFallbackHandle) {
    clearTimeout(killFallbackHandle);
  }
  outRl.close();
  errRl.close();

  if (droppedStdoutLines > 0) {
    stdoutLines.unshift(`[truncated ${droppedStdoutLines} stdout lines]`);
  }
  if (droppedStderrLines > 0) {
    stderrLines.unshift(`[truncated ${droppedStderrLines} stderr lines]`);
  }
  if (droppedEvents > 0) {
    events.unshift({
      ts: new Date().toISOString(),
      stream: "stderr",
      line: `[truncated ${droppedEvents} stream events]`,
    });
  }

  const stdout = stdoutLines.join("\n");
  const stderr = stderrLines.join("\n");
  const parsed = parseRunResult(`${stdout}\n${stderr}`);
  const exitCode = child.exitCode;
  const elapsedMs = Date.now() - startedAt;
  const didTimeout =
    timedOut || (typeof exitCode === "number" && exitCode < 0 && elapsedMs >= timeoutMs);
  const ok = !didTimeout && exitCode === 0;

  const result = {
    ok,
    detail: didTimeout
      ? `uiq timed out after ${timeoutMs}ms`
      : ok
        ? "ok"
        : `uiq exited with code ${String(exitCode)}`,
    stdout,
    stderr,
    runId: inlineRunId ?? parsed.runId,
    manifest: inlineManifest ?? parsed.manifest,
    exitCode,
    events,
    elapsedMs,
    timedOut: didTimeout,
    killStage,
  };
  writeAudit({
    type: "uiq_run_stream",
    ok: result.ok,
    detail: result.detail,
    meta: {
      runId: result.runId ?? null,
      manifest: result.manifest ?? null,
      eventCount: result.events.length,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut,
      killStage: result.killStage,
    },
  });
  return result;
}

export function listYamlStemNames(dirAbs: string): string[] {
  if (!ensureDir(dirAbs)) {
    return [];
  }
  return readdirSync(dirAbs)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => name.replace(/\.(ya?ml)$/i, ""));
}

export function readRunOverview(runId: string): {
  runId: string;
  gateStatus: string | null;
  failedChecks: Array<{
    id: string;
    status: string;
    actual: unknown;
    expected: unknown;
    reasonCode?: string;
    evidencePath: string | null;
    source: "manifest" | "summary";
  }>;
  summaryPath: string;
  manifestPath: string;
} {
  const defaultEvidencePathByCheckId: Record<string, string> = {
    gate: "reports/summary.json",
    a11y: "a11y/axe.json",
    perf: "perf/lighthouse.json",
    visual: "visual/report.json",
    security: "security/report.json",
    load: "metrics/load-summary.json",
    explore: "explore/report.json",
    chaos: "chaos/report.json",
    desktopReadiness: "metrics/desktop-readiness.json",
    desktopSmoke: "metrics/desktop-smoke.json",
    desktopE2E: "metrics/desktop-e2e.json",
    desktopSoak: "metrics/desktop-soak.json",
    "console.error": "reports/summary.json",
    "page.error": "reports/summary.json",
    "http.5xx": "reports/summary.json",
    "runtime.healthcheck": "reports/summary.json",
    "driver.capability": "reports/summary.json",
    "test.unit": "reports/summary.json",
    "test.contract": "reports/summary.json",
    "test.ct": "reports/summary.json",
    "test.e2e": "reports/summary.json",
    "security.high_vuln": "security/report.json",
    "a11y.serious_max": "a11y/axe.json",
    "a11y.engine_ready": "a11y/axe.json",
    "perf.lcp_ms_max": "perf/lighthouse.json",
    "perf.fcp_ms_max": "perf/lighthouse.json",
    "perf.engine_ready": "perf/lighthouse.json",
    "visual.diff_pixels_max": "visual/report.json",
    "visual.baseline_ready": "visual/report.json",
    "load.failed_requests": "metrics/load-summary.json",
    "load.p95_ms": "metrics/load-summary.json",
    "load.rps_min": "metrics/load-summary.json",
    "explore.under_explored": "explore/report.json",
    "desktop.readiness": "metrics/desktop-readiness.json",
    "desktop.smoke": "metrics/desktop-smoke.json",
    "desktop.e2e": "metrics/desktop-e2e.json",
    "desktop.soak": "metrics/desktop-soak.json",
  };
  const fallbackEvidencePathForCheck = (id: string, explicitPath?: string): string | null => {
    const normalized = explicitPath?.trim();
    if (normalized) {
      return normalized;
    }
    return defaultEvidencePathByCheckId[id] ?? null;
  };
  const root = runsRoot();
  const runRoot = safeResolveUnder(root, runId);
  const manifestPath = resolve(runRoot, "manifest.json");
  const summaryPath = resolve(runRoot, "reports/summary.json");
  const manifest = existsSync(manifestPath)
    ? (readJson(manifestPath) as {
        gateResults?: {
          status?: string;
          checks?: Array<{
            id?: string;
            status?: string;
            actual?: unknown;
            expected?: unknown;
            reasonCode?: string;
            evidencePath?: string;
          }>;
        };
      })
    : undefined;
  const summary = existsSync(summaryPath)
    ? (readJson(summaryPath) as {
        status?: string;
        checks?: Array<{
          id?: string;
          status?: string;
          actual?: unknown;
          expected?: unknown;
          reasonCode?: string;
          evidencePath?: string;
        }>;
      })
    : undefined;
  if (!manifest && !summary) {
    throw new Error(`run artifacts missing for ${runId}: manifest.json and reports/summary.json`);
  }

  const manifestChecks = manifest?.gateResults?.checks;
  const source: "manifest" | "summary" = Array.isArray(manifestChecks) ? "manifest" : "summary";
  const checks = source === "manifest" ? (manifestChecks ?? []) : (summary?.checks ?? []);
  const failedChecks = checks
    .filter((c) => c.status === "failed" || c.status === "blocked")
    .map((c) => ({
      id: c.id ?? "unknown",
      status: c.status ?? "unknown",
      actual: c.actual,
      expected: c.expected,
      ...(c.reasonCode ? { reasonCode: c.reasonCode } : {}),
      evidencePath: fallbackEvidencePathForCheck(c.id?.trim() || "unknown", c.evidencePath),
      source,
    }));

  return {
    runId,
    gateStatus: manifest?.gateResults?.status ?? summary?.status ?? null,
    failedChecks,
    summaryPath,
    manifestPath,
  };
}

export function readRepoTextFile(relativePath: string): string {
  const root = repoRoot();
  const raw = relativePath.trim();
  if (!raw) {
    throw new Error("relativePath is required");
  }
  if (raw.includes("\\")) {
    throw new Error("relativePath must use forward slashes");
  }
  if (isAbsolute(raw)) {
    throw new Error("absolute path is not allowed");
  }
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("parent path is not allowed");
  }

  const abs = safeResolveUnder(root, raw);
  const rootReal = realpathSync(root);
  const canonicalRel = relative(rootReal, abs).replace(/\\/g, "/");
  if (
    !canonicalRel ||
    canonicalRel === "." ||
    canonicalRel.startsWith("..") ||
    canonicalRel.includes("/../")
  ) {
    throw new Error("path traversal blocked");
  }

  const isAllowedFile = canonicalRel === "README.md";
  const isAllowedDir =
    canonicalRel.startsWith("docs/") ||
    canonicalRel.startsWith("configs/profiles/") ||
    canonicalRel.startsWith("configs/targets/") ||
    canonicalRel.startsWith("configs/");
  const isAllowedNestedPath =
    canonicalRel === "contracts/openapi" || canonicalRel.startsWith("contracts/openapi/");
  if (!isAllowedFile && !isAllowedDir && !isAllowedNestedPath) {
    throw new Error(
      "path not allowed; use docs/, configs/profiles/, configs/targets/, contracts/openapi/, configs/, README.md",
    );
  }

  const ext = extname(abs).toLowerCase();
  if (![".md", ".yaml", ".yml", ".json", ".txt"].includes(ext)) {
    throw new Error("file extension not allowed");
  }
  return readUtf8(abs);
}

function readRunJson(runId: string, rel: string): unknown {
  return readJson(safeResolveUnder(runsRoot(), runId, rel));
}

export function pickRunIdOrLatest(input?: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }
  const latest = latestRunId();
  if (!latest) {
    throw new Error("no runs found");
  }
  return latest;
}

export function analyzeA11y(runId: string, topN: number): JsonObject {
  const data = readRunJson(runId, "a11y/axe.json") as {
    counts?: JsonObject;
    issues?: Array<{ id?: string; severity?: string; message?: string; selector?: string }>;
    scannedAt?: string;
  };
  const issues = (data.issues ?? []).slice(0, Math.max(1, topN)).map((it, i) => ({
    rank: i + 1,
    id: it.id ?? "unknown",
    severity: it.severity ?? "unknown",
    message: it.message ?? "",
    selector: it.selector ?? "",
  }));
  return {
    runId,
    counts: data.counts ?? {},
    scannedAt: data.scannedAt ?? null,
    topIssues: issues,
  };
}

export function analyzePerf(runId: string): JsonObject {
  const data = readRunJson(runId, "perf/lighthouse.json") as {
    engine?: string;
    preset?: string;
    metrics?: JsonObject;
    measuredAt?: string;
    fallbackUsed?: boolean;
    deterministic?: JsonObject;
  };
  return {
    runId,
    engine: data.engine ?? null,
    preset: data.preset ?? null,
    measuredAt: data.measuredAt ?? null,
    fallbackUsed: data.fallbackUsed ?? null,
    metrics: data.metrics ?? {},
    deterministic: data.deterministic ?? {},
  };
}

export function analyzeVisual(runId: string): JsonObject {
  const data = readRunJson(runId, "visual/report.json") as {
    mode?: string;
    diffPixels?: number;
    totalPixels?: number;
    diffRatio?: number;
    baselineCreated?: boolean;
    baselinePath?: string;
    currentPath?: string;
    diffPath?: string;
  };
  return {
    runId,
    mode: data.mode ?? null,
    diffPixels: data.diffPixels ?? null,
    totalPixels: data.totalPixels ?? null,
    diffRatio: data.diffRatio ?? null,
    baselineCreated: data.baselineCreated ?? null,
    baselinePath: data.baselinePath ?? null,
    currentPath: data.currentPath ?? null,
    diffPath: data.diffPath ?? null,
  };
}

export function analyzeSecurity(runId: string): JsonObject {
  const root = runsRoot();
  const reportPath = safeResolveUnder(root, runId, "security/report.json");
  const ticketsPath = safeResolveUnder(root, runId, "metrics/security-tickets.json");
  const report = existsSync(reportPath) ? (readJson(reportPath) as JsonObject) : {};
  const tickets = existsSync(ticketsPath) ? (readJson(ticketsPath) as unknown[]) : [];
  return {
    runId,
    hasReport: existsSync(reportPath),
    hasTickets: existsSync(ticketsPath),
    report,
    ticketCount: tickets.length,
    ticketsSample: tickets.slice(0, 20),
  };
}

export function comparePerf(runA: string, runB: string): JsonObject {
  const a = analyzePerf(runA) as { metrics?: JsonObject };
  const b = analyzePerf(runB) as { metrics?: JsonObject };
  const metricsA = a.metrics ?? {};
  const metricsB = b.metrics ?? {};
  const keys = new Set([...Object.keys(metricsA), ...Object.keys(metricsB)]);
  const deltas: JsonObject = {};
  for (const key of keys) {
    const va = metricsA[key];
    const vb = metricsB[key];
    if (typeof va === "number" && typeof vb === "number") {
      deltas[key] = { from: va, to: vb, delta: Number((vb - va).toFixed(3)) };
    }
  }
  return { runA, runB, deltas };
}

export function buildTemplateName(startUrl: string): string {
  try {
    const host = new URL(startUrl).hostname.replace(/[^a-zA-Z0-9]+/g, "-");
    return `register-${host}-${Date.now()}`;
  } catch {
    return `register-${Date.now()}`;
  }
}

export function buildRegisterTemplatePayload(
  flowId: string,
  name: string,
  emailDefault?: string,
  passwordDefault?: string,
  otpProvider = "gmail",
): JsonObject {
  const defaults: JsonObject = {};
  if (emailDefault?.trim()) {
    defaults.email = emailDefault.trim();
  }
  if (passwordDefault?.trim()) {
    defaults.password = passwordDefault.trim();
  }
  return {
    flow_id: flowId,
    name,
    params_schema: [
      { key: "email", type: "email", required: true },
      { key: "password", type: "secret", required: true },
    ],
    defaults,
    policies: {
      retries: 1,
      timeout_seconds: 180,
      otp: {
        required: true,
        provider: otpProvider,
        timeout_seconds: 180,
        regex: "\\b(\\d{6})\\b",
      },
    },
  };
}

export function runAutomationTeach(params: {
  mode: string;
  startUrl: string;
  sessionId?: string;
  successSelector?: string;
  headless?: boolean;
}): UiqRunResult {
  const command = params.mode === "manual" ? "record:manual" : "record:midscene";
  const invocation = automationTeachInvocation(command);
  const env = {
    ...process.env,
    BASE_URL: backendBaseUrl(),
    START_URL: params.startUrl,
    ...(params.sessionId ? { SESSION_ID: params.sessionId } : {}),
    ...(params.successSelector ? { SUCCESS_SELECTOR: params.successSelector } : {}),
    ...(params.headless !== undefined ? { HEADLESS: params.headless ? "true" : "false" } : {}),
  };
  const proc = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  const rawStdout = proc.stdout ?? "";
  const rawStderr = proc.stderr ?? "";
  const stdout = redactSensitiveText(rawStdout);
  const stderr = redactSensitiveText(rawStderr);
  const parsed = parseRunResult(`${rawStdout}\n${rawStderr}`);
  if (proc.error) {
    return {
      ok: false,
      detail: `automation teach failed: ${(proc.error as Error).message}`,
      stdout,
      stderr,
      runId: parsed.runId,
      manifest: parsed.manifest,
      exitCode: proc.status,
    };
  }
  return {
    ok: proc.status === 0,
    detail: proc.status === 0 ? "ok" : `automation teach exited with code ${proc.status}`,
    stdout,
    stderr,
    runId: parsed.runId,
    manifest: parsed.manifest,
    exitCode: proc.status,
  };
}

export function normalizeOrchestrateMode(mode?: string): string | undefined {
  const normalized = mode?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized === "midscene" ? "ai" : normalized;
}

function terminalRunState(status: string): boolean {
  return (
    status === "waiting_otp" ||
    status === "waiting_user" ||
    status === "success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function resolveOtpCodeFromProvider(
  provider: string,
  senderFilter?: string,
  subjectFilter?: string,
): string | undefined {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "manual" || normalized === "vonage") {
    return undefined;
  }
  if (normalized !== "gmail" && normalized !== "imap") {
    return undefined;
  }
  const host = normalized === "gmail" ? "imap.gmail.com" : process.env.IMAP_HOST?.trim() || "";
  const username =
    normalized === "gmail"
      ? process.env.GMAIL_IMAP_USER?.trim() || ""
      : process.env.IMAP_USER?.trim() || "";
  const password =
    normalized === "gmail"
      ? process.env.GMAIL_IMAP_PASSWORD?.trim() || ""
      : process.env.IMAP_PASSWORD?.trim() || "";
  if (!host || !username || !password) {
    return undefined;
  }
  const py = spawnSync(
    "python3",
    [
      "-c",
      [
        "import imaplib, os, re, sys",
        "from email import message_from_bytes",
        "host, username, sender_filter, subject_filter = sys.argv[1:5]",
        "password = os.environ.get('UIQ_MCP_IMAP_PASSWORD', '')",
        "if not password:",
        "  print('', end='')",
        "  raise SystemExit(0)",
        "mail = imaplib.IMAP4_SSL(host)",
        "mail.login(username, password)",
        "mail.select('INBOX')",
        "status, data = mail.search(None, 'ALL')",
        "code = ''",
        "if status == 'OK':",
        "  ids = data[0].split()",
        "  for message_id in reversed(ids[-60:]):",
        "    s2, msg_data = mail.fetch(message_id, '(RFC822)')",
        "    if s2 != 'OK' or not msg_data:",
        "      continue",
        "    raw = None",
        "    for part in msg_data:",
        "      if isinstance(part, tuple) and len(part) > 1 and isinstance(part[1], bytes):",
        "        raw = part[1]",
        "        break",
        "    if raw is None:",
        "      continue",
        "    msg = message_from_bytes(raw)",
        "    sender = (msg.get('From') or '')",
        "    subject = (msg.get('Subject') or '')",
        "    if sender_filter and sender_filter not in sender:",
        "      continue",
        "    if subject_filter and subject_filter not in subject:",
        "      continue",
        "    body = ''",
        "    if msg.is_multipart():",
        "      chunks = []",
        "      for p in msg.walk():",
        "        if p.get_content_type() != 'text/plain':",
        "          continue",
        "        payload = p.get_payload(decode=True)",
        "        if isinstance(payload, bytes):",
        "          chunks.append(payload.decode(errors='ignore'))",
        "      body = '\\n'.join(chunks)",
        "    else:",
        "      payload = msg.get_payload(decode=True)",
        "      body = payload.decode(errors='ignore') if isinstance(payload, bytes) else str(payload or '')",
        "    m = re.search(r'\\b(\\d{6})\\b', body)",
        "    if m:",
        "      code = m.group(1)",
        "      break",
        "try:",
        "  mail.close()",
        "except Exception:",
        "  pass",
        "mail.logout()",
        "print(code, end='')",
      ].join("\n"),
      host,
      username,
      senderFilter ?? "",
      subjectFilter ?? "",
    ],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, UIQ_MCP_IMAP_PASSWORD: password } },
  );
  const out = (py.stdout ?? "").trim();
  return out || undefined;
}

export async function pollRunToTerminal(params: {
  runId: string;
  otpCode?: string;
  otpProvider?: string;
  senderFilter?: string;
  subjectFilter?: string;
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
}): Promise<JsonObject> {
  const deadlineMs = Date.now() + Math.max(10, params.pollTimeoutSeconds) * 1000;
  let submittedOtpCode: string | undefined;
  const provider = params.otpProvider?.trim().toLowerCase();
  const autoProvider = Boolean(provider && provider !== "manual" && provider !== "vonage");
  while (Date.now() < deadlineMs) {
    const run = await apiGetRun(params.runId);
    const status = parseRunStatus(run);
    if (status === "waiting_otp") {
      let otp = params.otpCode?.trim();
      if (!otp && autoProvider) {
        otp = resolveOtpCodeFromProvider(provider ?? "", params.senderFilter, params.subjectFilter);
      }
      if (otp) {
        if (submittedOtpCode !== otp) {
          await apiSubmitRunOtp(params.runId, otp);
          submittedOtpCode = otp;
        }
      } else {
        if (autoProvider) {
          await sleep(Math.max(1, params.pollIntervalSeconds) * 1000);
          continue;
        }
        return run;
      }
    } else if (status === "waiting_user") {
      return run;
    } else if (terminalRunState(status)) {
      return run;
    }
    await sleep(Math.max(1, params.pollIntervalSeconds) * 1000);
  }
  throw new Error(`run ${params.runId} polling timeout after ${params.pollTimeoutSeconds}s`);
}

export function getWorkspaceRoot(): string {
  return workspaceRoot();
}
