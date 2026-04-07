import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureRunDirectories,
  sanitizeRunId,
} from "../../../../core/src/artifacts/runtimePaths.js";
import { writeManifest } from "../../../../core/src/manifest/io.js";
import type { Manifest, ManifestGateCheck } from "../../../../core/src/manifest/types.js";
import {
  getDriverCapabilityContract,
  isStepSupportedByDriver,
} from "../../../../drivers/capabilities.js";
import {
  type ComputerUseExecutionResult,
  type ComputerUseOptions,
  runComputerUse,
} from "../computer-use.js";
import { loadStateModel } from "../state-model.js";
import { startTargetRuntime, waitForHealthcheck } from "../target-runtime.js";
import type { TestSuiteResult } from "../test-suite.js";
import { throwIfAborted } from "./concurrency.js";
import { finalizePipelineReporting } from "./pipeline/reporting.js";
import {
  createInitialPipelineStageState,
  executePipelineStages,
  type PipelineStageState,
  type PostFixRegressionReport,
} from "./pipeline/stage-execution.js";
import { assertBaseUrlAllowed, loadProfileConfig, loadTargetConfig } from "./run-config.js";
import { gateReasonCode, getGitInfo } from "./run-reporting.js";
import { resolveDiagnosticsConfig } from "./run-resolve.js";
import { DEFAULT_MAX_PARALLEL_TASKS } from "./run-schema.js";
import type { BlockedStepDetail, RunOverrides } from "./run-types.js";

export type RunProfileDependencies = {
  runComputerUse?: (options: ComputerUseOptions) => ComputerUseExecutionResult;
};

type RunPipelineErrorMeta = Record<string, unknown>;

type RunPipelineErrorLogEntry = {
  timestamp: string;
  level: "warning" | "error";
  event: string;
  reasonCode: string;
  detail: string;
  meta?: RunPipelineErrorMeta;
};

export class RunPipelineError extends Error {
  readonly reasonCode: string;
  readonly meta: RunPipelineErrorMeta;

  constructor(
    reasonCode: string,
    message: string,
    meta: RunPipelineErrorMeta = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunPipelineError";
    this.reasonCode = reasonCode;
    this.meta = meta;
  }
}

function toReasonCodeFromError(error: unknown): string {
  if (error instanceof RunPipelineError) {
    return error.reasonCode;
  }
  if (error instanceof Error) {
    const matched = error.message.match(/\[([a-z0-9_.-]+)\]/i);
    if (matched?.[1]) {
      return matched[1];
    }
  }
  return "gate.execution.failed.unhandled_error";
}

function toErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toStructuredPipelineError(
  error: unknown,
  fallbackReasonCode = "gate.execution.failed.unhandled_error",
): RunPipelineError {
  if (error instanceof RunPipelineError) {
    return error;
  }
  const reasonCode = toReasonCodeFromError(error) || fallbackReasonCode;
  const message = toErrorDetail(error);
  return new RunPipelineError(reasonCode, message, { source: "runProfile" }, { cause: error });
}

function writePipelineErrorLog(
  baseDir: string | undefined,
  level: "warning" | "error",
  event: string,
  reasonCode: string,
  detail: string,
  meta?: RunPipelineErrorMeta,
): void {
  const payload: RunPipelineErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    reasonCode,
    detail,
    ...(meta ? { meta } : {}),
  };
  const rendered = JSON.stringify(payload);
  const output = `${rendered}\n`;
  process.stderr.write(output);
  if (!baseDir) {
    return;
  }
  try {
    const logDir = resolve(baseDir, "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, "orchestrator-errors.jsonl"), `${rendered}\n`, "utf8");
  } catch (logError) {
    const fallback = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "pipeline.error.log_write_failed",
      reasonCode: "gate.execution.failed.log_write_failed",
      detail: toErrorDetail(logError),
      meta: { originalEvent: event, originalReasonCode: reasonCode },
    });
    process.stderr.write(`${fallback}\n`);
  }
}

function buildMinimalFailureCheck(reasonCode: string, detail: string): ManifestGateCheck {
  return {
    id: "execution.pipeline",
    expected: "completed",
    actual: detail,
    severity: "BLOCKER",
    status: "failed",
    reasonCode,
    evidencePath: "reports/summary.json",
  };
}

export function persistMinimalFailureArtifacts(input: {
  baseDir: string;
  resolvedRunId: string;
  startedAt: string;
  profileName: string;
  target: ReturnType<typeof loadTargetConfig>;
  effectiveBaseUrl: string;
  effectiveApp?: string;
  effectiveBundleId?: string;
  reasonCode: string;
  detail: string;
  runtimeReportPath: string;
  aiPreflightPath?: string;
  maxParallelTasks?: number;
  stageDurationsMs?: Record<string, number>;
}): { summaryPath: string; manifestPath: string } {
  const check = buildMinimalFailureCheck(input.reasonCode, input.detail);
  const status: "failed" = "failed";
  const summaryPath = "reports/summary.json";
  const finishedAt = new Date().toISOString();
  const reportPayload = {
    status,
    checks: [check],
    summary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      aiModel: "models/gemini-3.1-pro-preview",
      promptVersion: "",
      blockedByMissingEngineCount: 0,
    },
    thresholds: {},
    diagnostics: {
      runtime: { reportPath: input.runtimeReportPath },
      errors: [
        {
          reasonCode: input.reasonCode,
          detail: input.detail,
        },
      ],
    },
  };
  writeFileSync(
    resolve(input.baseDir, summaryPath),
    `${JSON.stringify(reportPayload, null, 2)}\n`,
    "utf8",
  );

  const reports: Manifest["reports"] = {
    report: summaryPath,
    runtime: input.runtimeReportPath,
    ...(input.aiPreflightPath ? { aiPreflight: input.aiPreflightPath } : {}),
  };
  const manifest: Manifest = {
    schemaVersion: "1.1",
    runId: input.resolvedRunId,
    target: {
      type: input.target.type,
      name: input.target.name,
      baseUrl: input.effectiveBaseUrl,
      app: input.effectiveApp ?? "",
      bundleId: input.effectiveBundleId ?? "",
    },
    profile: input.profileName,
    git: getGitInfo(),
    timing: {
      startedAt: input.startedAt,
      finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(input.startedAt).getTime()),
    },
    execution: {
      maxParallelTasks: input.maxParallelTasks ?? 1,
      stagesMs: input.stageDurationsMs ?? {},
      criticalPath: [],
    },
    states: [],
    evidenceIndex: [
      {
        id: "report.summary",
        source: "report",
        kind: "report",
        path: summaryPath,
      },
      {
        id: "report.runtime",
        source: "report",
        kind: "report",
        path: input.runtimeReportPath,
      },
    ],
    reports,
    summary: {
      consoleError: 0,
      pageError: 0,
      http5xx: 0,
      aiModel: "models/gemini-3.1-pro-preview",
      promptVersion: "",
      blockedByMissingEngineCount: 0,
    },
    gateResults: {
      status,
      checks: [check],
    },
    toolchain: {
      node: process.version,
    },
  };
  const manifestPath = writeManifest(input.baseDir, manifest);
  return { summaryPath, manifestPath };
}

function throwAiPreflightViolation(
  reasonCode: string,
  message: string,
  meta: RunPipelineErrorMeta,
): never {
  throw new RunPipelineError(reasonCode, `[${reasonCode}] ${message}`, meta);
}

function resolveMaxParallelTasks(): number {
  return DEFAULT_MAX_PARALLEL_TASKS;
}

export function resolveAiFixMaxIterations(): number {
  const raw = process.env.AI_FIX_MAX_ITERATIONS;
  if (!raw || raw.trim().length === 0) {
    return 2;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 2;
  }
  return Math.max(0, parsed);
}

function tailCommandOutput(text: string, maxLines = 60): string {
  return text.split("\n").slice(-maxLines).join("\n").trim();
}

function argsForSuite(
  suite: "unit" | "ct" | "e2e" | "contract",
  e2eSuite: "smoke" | "regression" | "full",
): string[] {
  if (suite === "unit") {
    return ["test:unit"];
  }
  if (suite === "contract") {
    return ["test:contract"];
  }
  if (suite === "ct") {
    return ["test:ct"];
  }
  if (e2eSuite === "smoke") {
    return ["test:e2e", "--grep", "@smoke"];
  }
  if (e2eSuite === "regression") {
    return ["test:e2e", "--grep", "@regression"];
  }
  return ["test:e2e"];
}

function computeIsolatedCtPort(baseDir: string): number {
  let hash = 0;
  for (const ch of baseDir) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return 4300 + (hash % 200);
}

type AiPreflightReport = {
  generatedAt: string;
  status: "passed" | "blocked" | "skipped";
  reasonCode: string;
  requiresAi: boolean;
  aiProvider: string;
  hasGeminiKey: boolean;
  profileName: string;
  policySnapshot?: ProviderPolicySnapshot;
};

type ProviderPolicySnapshot = {
  sourcePath: string;
  provider: string;
  primary: string;
  fallback: string;
  fallbackMode: string;
  strictNoFallback: boolean;
};

const DEFAULT_PROVIDER_POLICY: Omit<ProviderPolicySnapshot, "sourcePath"> = {
  provider: "gemini",
  primary: "gemini",
  fallback: "none",
  fallbackMode: "strict",
  strictNoFallback: true,
};

function parseProviderPolicyValue(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

function loadProviderPolicySnapshot(): ProviderPolicySnapshot {
  const configuredPath =
    process.env.PROVIDER_POLICY_PATH?.trim() || "configs/ai/provider-policy.yaml";
  try {
    const raw = readFileSync(resolve(process.cwd(), configuredPath), "utf8");
    const parsed = parseProviderPolicyValue(raw);
    const provider = (parsed.provider || DEFAULT_PROVIDER_POLICY.provider).trim().toLowerCase();
    const primary = (parsed.primary || provider || DEFAULT_PROVIDER_POLICY.primary)
      .trim()
      .toLowerCase();
    const fallback = (parsed.fallback || DEFAULT_PROVIDER_POLICY.fallback).trim().toLowerCase();
    const fallbackMode = (parsed.fallbackMode || DEFAULT_PROVIDER_POLICY.fallbackMode)
      .trim()
      .toLowerCase();
    return {
      sourcePath: configuredPath,
      provider: provider || DEFAULT_PROVIDER_POLICY.provider,
      primary: primary || DEFAULT_PROVIDER_POLICY.primary,
      fallback: fallback || DEFAULT_PROVIDER_POLICY.fallback,
      fallbackMode: fallbackMode || DEFAULT_PROVIDER_POLICY.fallbackMode,
      strictNoFallback: fallbackMode === "strict" && fallback === "none",
    };
  } catch (error) {
    writePipelineErrorLog(
      undefined,
      "warning",
      "provider_policy_load_failed",
      "ai.gemini.preflight.provider_policy_read_failed",
      toErrorDetail(error),
      { configuredPath },
    );
    return {
      sourcePath: configuredPath,
      ...DEFAULT_PROVIDER_POLICY,
    };
  }
}

function resolveAiProvider(policy: ProviderPolicySnapshot): string {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw && raw.length > 0) {
    return raw;
  }
  if (policy.primary) {
    return policy.primary;
  }
  return policy.provider || "gemini";
}

function resolveFixResultPath(baseDir: string, state: PipelineStageState): string | undefined {
  const fromGenerated = state.generatedReports.fixResult;
  if (fromGenerated && existsSync(resolve(baseDir, fromGenerated))) {
    return fromGenerated;
  }
  const fallback = "reports/fix-result.json";
  if (existsSync(resolve(baseDir, fallback))) {
    return fallback;
  }
  return undefined;
}

function isFixResultExecutable(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.executable === "boolean") {
    return record.executable;
  }
  if (typeof record.canExecute === "boolean") {
    return record.canExecute;
  }
  if (typeof record.hasExecutableFixes === "boolean") {
    return record.hasExecutableFixes;
  }
  if (Array.isArray(record.actions)) {
    return record.actions.length > 0;
  }
  if (typeof record.status === "string") {
    const normalized = record.status.trim().toLowerCase();
    if (normalized === "applied" || normalized === "ready" || normalized === "completed") {
      return true;
    }
  }
  return false;
}

function readExecutableFixResult(
  baseDir: string,
  state: PipelineStageState,
): { executable: boolean; path?: string } {
  const fixResultPath = resolveFixResultPath(baseDir, state);
  if (!fixResultPath) {
    return { executable: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(resolve(baseDir, fixResultPath), "utf8")) as unknown;
    return { executable: isFixResultExecutable(parsed), path: fixResultPath };
  } catch (error) {
    writePipelineErrorLog(
      baseDir,
      "warning",
      "fix_result_parse_failed",
      "gate.post_fix_regression.blocked.fix_result_parse_error",
      toErrorDetail(error),
      { fixResultPath },
    );
    return { executable: false, path: fixResultPath };
  }
}

function failedCriticalSuites(
  state: PipelineStageState,
): Array<"unit" | "contract" | "ct" | "e2e"> {
  const failed: Array<"unit" | "contract" | "ct" | "e2e"> = [];
  if (state.unitTestResult?.status === "failed") {
    failed.push("unit");
  }
  if (state.contractTestResult?.status === "failed") {
    failed.push("contract");
  }
  if (state.ctTestResult?.status === "failed") {
    failed.push("ct");
  }
  if (state.e2eTestResult?.status === "failed") {
    failed.push("e2e");
  }
  return failed;
}

function assignSuiteResult(
  state: PipelineStageState,
  suite: "unit" | "contract" | "ct" | "e2e",
  result: TestSuiteResult,
): void {
  if (suite === "unit") {
    state.unitTestResult = result;
    state.generatedReports.testUnit = result.reportPath;
    return;
  }
  if (suite === "contract") {
    state.contractTestResult = result;
    state.generatedReports.testContract = result.reportPath;
    return;
  }
  if (suite === "ct") {
    state.ctTestResult = result;
    state.generatedReports.testCt = result.reportPath;
    return;
  }
  state.e2eTestResult = result;
  state.generatedReports.testE2e = result.reportPath;
}

export async function runPostFixRegressionLoop(
  baseDir: string,
  state: PipelineStageState,
  runTestSuite: (suite: "unit" | "contract" | "ct" | "e2e") => Promise<TestSuiteResult>,
  maxIterations: number,
): Promise<PostFixRegressionReport> {
  const fixSignal = readExecutableFixResult(baseDir, state);
  let failedSuites = failedCriticalSuites(state);
  const initialFailedSuites = [...failedSuites];
  const iterations: PostFixRegressionReport["iterations"] = [];
  let iterationsExecuted = 0;
  let status: PostFixRegressionReport["status"] = "skipped";
  let reasonCode = gateReasonCode("post_fix.regression", "passed", "no_executable_fix_result");
  let converged = true;

  if (fixSignal.executable) {
    status = "passed";
    reasonCode = gateReasonCode("post_fix.regression", "passed", "no_failed_critical_suites");
    converged = failedSuites.length === 0;
    while (failedSuites.length > 0 && iterationsExecuted < maxIterations) {
      const rerunSuites = [...failedSuites];
      const iterationResultBySuite = new Map<
        "unit" | "contract" | "ct" | "e2e",
        PostFixRegressionReport["iterations"][number]["results"][number]
      >();
      const parallelSuites = rerunSuites.filter((suite) => suite !== "e2e");
      await Promise.all(
        parallelSuites.map(async (suite) => {
          const result = await runTestSuite(suite);
          assignSuiteResult(state, suite, result);
          iterationResultBySuite.set(suite, {
            suite,
            status: result.status,
            reportPath: result.reportPath,
            exitCode: result.exitCode,
          });
        }),
      );
      if (rerunSuites.includes("e2e")) {
        const result = await runTestSuite("e2e");
        assignSuiteResult(state, "e2e", result);
        iterationResultBySuite.set("e2e", {
          suite: "e2e",
          status: result.status,
          reportPath: result.reportPath,
          exitCode: result.exitCode,
        });
      }
      const iterationResults = rerunSuites
        .map((suite) => iterationResultBySuite.get(suite))
        .filter(
          (result): result is PostFixRegressionReport["iterations"][number]["results"][number] =>
            result !== undefined,
        );
      iterationsExecuted += 1;
      failedSuites = failedCriticalSuites(state);
      iterations.push({
        iteration: iterationsExecuted,
        rerunSuites,
        results: iterationResults,
      });
      if (failedSuites.length === 0) {
        converged = true;
        status = "passed";
        reasonCode = gateReasonCode("post_fix.regression", "passed", "converged");
        break;
      }
      converged = false;
    }

    if (!converged || failedSuites.length > 0) {
      status = "failed";
      converged = false;
      reasonCode = gateReasonCode("post_fix.regression", "failed", "not_converged");
    }
  }

  const report: PostFixRegressionReport = {
    generatedAt: new Date().toISOString(),
    status,
    reasonCode,
    maxIterations,
    iterationsExecuted,
    fixResultPath: fixSignal.path,
    fixResultExecutable: fixSignal.executable,
    converged,
    initialFailedSuites,
    remainingFailedSuites: failedSuites,
    iterations,
  };
  const reportPath = "reports/post-fix-regression.json";
  writeFileSync(resolve(baseDir, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  state.postFixRegression = report;
  state.generatedReports.postFixRegression = reportPath;
  return report;
}

function writeAiPreflightReport(baseDir: string, report: AiPreflightReport): string {
  const reportPath = "reports/ai-preflight.json";
  writeFileSync(resolve(baseDir, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export function runAiPreflight(
  profileName: string,
  profile: ReturnType<typeof loadProfileConfig>,
  baseDir: string,
): string {
  const requiresAi = profile.aiReview?.enabled === true;
  const policySnapshot = loadProviderPolicySnapshot();
  const aiProvider = resolveAiProvider(policySnapshot);
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (!requiresAi) {
    return writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "skipped",
      reasonCode: "ai.gemini.preflight.skipped.ai_not_required",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
  }
  if (policySnapshot.strictNoFallback && aiProvider !== policySnapshot.primary) {
    writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "blocked",
      reasonCode: "ai.gemini.strict_policy_violation",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
    throwAiPreflightViolation(
      "ai.gemini.strict_policy_violation",
      `strict policy requires AI provider '${policySnapshot.primary}', received '${aiProvider}'`,
      { profileName, aiProvider, expectedProvider: policySnapshot.primary },
    );
  }
  if (policySnapshot.strictNoFallback && aiProvider !== "gemini") {
    writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "blocked",
      reasonCode: "ai.gemini.strict_policy_violation",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
    throwAiPreflightViolation(
      "ai.gemini.strict_policy_violation",
      `strict policy requires AI provider 'gemini', received '${aiProvider}'`,
      { profileName, aiProvider, expectedProvider: "gemini" },
    );
  }
  if (policySnapshot.strictNoFallback && !hasGeminiKey) {
    writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "blocked",
      reasonCode: "ai.gemini.strict_policy_violation",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
    throwAiPreflightViolation("ai.gemini.strict_policy_violation", "GEMINI_API_KEY is required", {
      profileName,
      aiProvider,
    });
  }
  if (aiProvider !== "gemini") {
    writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "blocked",
      reasonCode: "ai.gemini.unavailable.provider_not_gemini",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
    throwAiPreflightViolation(
      "ai.gemini.unavailable",
      "AI_PROVIDER must be set to 'gemini' for AI review",
      {
        profileName,
        aiProvider,
      },
    );
  }
  if (!hasGeminiKey) {
    return writeAiPreflightReport(baseDir, {
      generatedAt: new Date().toISOString(),
      status: "passed",
      reasonCode: "ai.gemini.preflight.passed.local_review_without_api_key",
      requiresAi,
      aiProvider,
      hasGeminiKey,
      profileName,
      policySnapshot,
    });
  }
  return writeAiPreflightReport(baseDir, {
    generatedAt: new Date().toISOString(),
    status: "passed",
    reasonCode: "ai.gemini.preflight.passed.ready",
    requiresAi,
    aiProvider,
    hasGeminiKey,
    profileName,
    policySnapshot,
  });
}

async function runTestSuiteAsync(
  baseDir: string,
  suite: "unit" | "contract" | "ct" | "e2e",
  baseUrl?: string,
  e2eSuite: "smoke" | "regression" | "full" = "smoke",
): Promise<TestSuiteResult> {
  const started = Date.now();
  const args = argsForSuite(suite, e2eSuite);
  const reportPath = `reports/test-${suite}.json`;
  const ctPort = suite === "ct" ? computeIsolatedCtPort(baseDir) : undefined;
  const env = {
    ...process.env,
    ...(baseUrl ? { BASE_URL: baseUrl, UIQ_BASE_URL: baseUrl } : {}),
    ...(ctPort ? { UIQ_CT_PORT: String(ctPort), UIQ_CT_HOST: "127.0.0.1" } : {}),
  };

  const result = await new Promise<TestSuiteResult>((resolvePromise) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const failed: TestSuiteResult = {
        suite,
        status: "failed",
        exitCode: 1,
        durationMs: Date.now() - started,
        command: "pnpm",
        args,
        reportPath,
        stdoutTail: tailCommandOutput(stdout),
        stderrTail: tailCommandOutput(`${stderr}\n${error.message}`),
      };
      resolvePromise(failed);
    });
    child.on("close", (code) => {
      const done: TestSuiteResult = {
        suite,
        status: code === 0 ? "passed" : "failed",
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        command: "pnpm",
        args,
        reportPath,
        stdoutTail: tailCommandOutput(stdout),
        stderrTail: tailCommandOutput(stderr),
      };
      resolvePromise(done);
    });
  });

  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}

export async function runProfile(
  profileName: string,
  targetName: string,
  runId?: string,
  overrides?: RunOverrides,
  dependencies: RunProfileDependencies = {},
): Promise<{ runId: string; manifestPath: string }> {
  const profile = loadProfileConfig(profileName);
  const target = loadTargetConfig(targetName);
  const isWebTarget = target.type === "web";
  const driverContract = getDriverCapabilityContract(target.driver, target.type);

  const resolvedRunId = sanitizeRunId(runId ?? new Date().toISOString().replace(/[:.]/g, "-"));
  const startedAt = new Date().toISOString();
  const baseDir = ensureRunDirectories(resolvedRunId);
  const effectiveApp = overrides?.app ?? target.app;
  const effectiveBundleId = overrides?.bundleId ?? target.bundleId;
  const effectiveBaseUrl = overrides?.baseUrl ?? target.baseUrl ?? "http://localhost:4173";
  const baseUrlPolicy = assertBaseUrlAllowed(target, effectiveBaseUrl, overrides?.allowAllUrls);
  const stateModel = loadStateModel();
  const maxParallelTasks = resolveMaxParallelTasks();
  const maxFixIterations = resolveAiFixMaxIterations();
  const autostartEnabled = overrides?.autostartTarget ?? true;
  const startConfig = {
    enabled: isWebTarget && autostartEnabled,
    baseDir,
    startCommands: target.start,
    healthcheckUrl: overrides?.baseUrl ?? target.healthcheck?.url ?? effectiveBaseUrl,
  };
  const healthcheckUrl = startConfig.healthcheckUrl ?? effectiveBaseUrl;
  let runtimeStart: Awaited<ReturnType<typeof startTargetRuntime>> = {
    autostart: startConfig.enabled,
    started: false,
    healthcheckPassed: !startConfig.enabled,
    healthcheckUrl: startConfig.healthcheckUrl,
    healthcheckReason: "runtime_not_started",
    healthcheckDetail: "runtime start has not been attempted",
    processes: [],
    reportPath: "reports/runtime-start.json",
    teardown: async () => undefined,
  };

  const blockedStepReasons: string[] = [];
  const blockedStepDetails: BlockedStepDetail[] = [];
  const recordBlockedStep = (
    stepId: string,
    detail: string,
    options?: {
      reasonCode?: string;
      artifactPath?: string;
    },
  ): void => {
    blockedStepReasons.push(`step.${stepId} ${detail}`);
    blockedStepDetails.push({
      stepId,
      reasonCode:
        options?.reasonCode ??
        gateReasonCode("driver.capability", "blocked", "unsupported_target_type"),
      detail,
      artifactPath: options?.artifactPath ?? "reports/summary.json",
    });
  };

  const unsupportedSteps = new Set(
    profile.steps.filter((stepId) => !isStepSupportedByDriver(stepId, target.type, driverContract)),
  );
  const stepRequested = (stepId: string): boolean =>
    profile.steps.includes(stepId) && !unsupportedSteps.has(stepId);
  for (const stepId of unsupportedSteps) {
    recordBlockedStep(stepId, `unsupported by driver=${target.driver} target.type=${target.type}`);
  }

  const stageState = createInitialPipelineStageState(runtimeStart.reportPath);
  let aiPreflightPath: string | undefined = "reports/ai-preflight.json";
  const effectiveDiagnosticsConfig = resolveDiagnosticsConfig(
    target,
    profile,
    overrides?.diagnosticsMaxItems,
  );
  const e2eSuite = profile.tests?.e2eSuite ?? "smoke";
  const stageDurationsMs: Record<string, number> = {};
  const runStage = async (
    stageId: string,
    signal: AbortSignal,
    task: () => Promise<void>,
  ): Promise<void> => {
    throwIfAborted(signal);
    const startedAtMs = Date.now();
    await task();
    throwIfAborted(signal);
    stageDurationsMs[stageId] = Date.now() - startedAtMs;
  };

  const waitForRuntimeReady = async (timeoutMs: number) =>
    waitForHealthcheck(healthcheckUrl, timeoutMs);

  const formatRuntimeReadinessDetail = (stepId: string, reason: string, detail: string): string =>
    `[${stepId}] runtime_unreachable url=${healthcheckUrl} reason=${reason} detail=${detail}`;

  const trimRuntimeReadinessDetail = (value: string): string => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  };

  const ensureRuntimeReady = async (stepId: string, signal: AbortSignal): Promise<void> => {
    throwIfAborted(signal);
    if (!isWebTarget) {
      return;
    }
    const runtimeReady = await waitForRuntimeReady(8_000);
    throwIfAborted(signal);
    if (runtimeReady.ok) {
      return;
    }
    if (
      !startConfig.enabled ||
      (!startConfig.startCommands?.web && !startConfig.startCommands?.api)
    ) {
      throw new Error(
        formatRuntimeReadinessDetail(
          stepId,
          runtimeReady.reason,
          trimRuntimeReadinessDetail(runtimeReady.detail),
        ),
      );
    }
    await runtimeStart.teardown();
    runtimeStart = await startTargetRuntime(startConfig);
    stageState.generatedReports.runtime = runtimeStart.reportPath;
    if (!runtimeStart.healthcheckPassed) {
      const reason = runtimeStart.healthcheckReason ?? "unknown";
      const detail = trimRuntimeReadinessDetail(runtimeStart.healthcheckDetail ?? "n/a");
      throw new Error(
        `[${stepId}] runtime_restart_failed url=${healthcheckUrl} reason=${reason} detail=${detail}`,
      );
    }
  };

  let runtimeReadyLock = Promise.resolve();
  const ensureRuntimeReadySerialized = async (
    stepId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const ensured = runtimeReadyLock.then(async () => ensureRuntimeReady(stepId, signal));
    runtimeReadyLock = ensured.then(
      () => undefined,
      () => undefined,
    );
    await ensured;
  };

  try {
    runtimeStart = await startTargetRuntime(startConfig);
    stageState.generatedReports.runtime = runtimeStart.reportPath;

    aiPreflightPath = runAiPreflight(profileName, profile, baseDir);
    stageState.generatedReports.aiPreflight = aiPreflightPath;
    if (isWebTarget) {
      await ensureRuntimeReadySerialized("bootstrap", new AbortController().signal);
    }

    const runProfileTestSuite = async (
      suite: "unit" | "contract" | "ct" | "e2e",
      signal?: AbortSignal,
    ): Promise<TestSuiteResult> => {
      const activeSignal = signal ?? new AbortController().signal;
      if (isWebTarget && suite === "e2e") {
        await ensureRuntimeReadySerialized("test.e2e", activeSignal);
      }
      throwIfAborted(activeSignal);
      return runTestSuiteAsync(baseDir, suite, effectiveBaseUrl, e2eSuite);
    };

    await executePipelineStages(
      {
        baseDir,
        profile,
        target,
        overrides,
        isWebTarget,
        effectiveBaseUrl,
        effectiveApp,
        effectiveBundleId,
        unsupportedSteps,
        maxParallelTasks,
        stateModel,
        stepRequested,
        recordBlockedStep,
        runStage,
        ensureRuntimeReady,
        ensureRuntimeReadySerialized,
        runTestSuite: runProfileTestSuite,
        runComputerUse: dependencies.runComputerUse ?? runComputerUse,
      },
      stageState,
    );
    await runPostFixRegressionLoop(baseDir, stageState, runProfileTestSuite, maxFixIterations);

    const { manifestPath } = finalizePipelineReporting({
      baseDir,
      resolvedRunId,
      startedAt,
      profile,
      target,
      effectiveBaseUrl,
      effectiveApp,
      effectiveBundleId,
      stateModel,
      runtimeStart,
      driverContract,
      blockedStepReasons,
      blockedStepDetails,
      effectiveDiagnosticsConfig,
      maxParallelTasks,
      stageDurationsMs,
      baseUrlPolicy,
      state: stageState,
    });

    return { runId: resolvedRunId, manifestPath };
  } catch (error) {
    const structuredError = toStructuredPipelineError(error);
    const failureDetail = structuredError.message;
    const artifacts = persistMinimalFailureArtifacts({
      baseDir,
      resolvedRunId,
      startedAt,
      profileName,
      target,
      effectiveBaseUrl,
      effectiveApp,
      effectiveBundleId,
      reasonCode: structuredError.reasonCode,
      detail: failureDetail,
      runtimeReportPath: runtimeStart.reportPath,
      aiPreflightPath,
      maxParallelTasks,
      stageDurationsMs,
    });
    writePipelineErrorLog(
      baseDir,
      "error",
      "pipeline_run_failed",
      structuredError.reasonCode,
      failureDetail,
      {
        profileName,
        targetName,
        runId: resolvedRunId,
        summaryPath: artifacts.summaryPath,
        manifestPath: artifacts.manifestPath,
      },
    );
    throw structuredError;
  } finally {
    await runtimeStart.teardown();
  }
}
