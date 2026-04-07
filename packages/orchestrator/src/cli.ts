import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureRunDirectories, sanitizeRunId } from "../../core/src/artifacts/runtimePaths.js";
import { runA11y } from "./commands/a11y.js";
import { runCapture } from "./commands/capture.js";
import { runChaos } from "./commands/chaos.js";
import {
  type ComputerUseExecutionResult,
  type ComputerUseOptions,
  runComputerUse,
} from "./commands/computer-use.js";
import { runDesktopReadiness } from "./commands/desktop.js";
import { runDesktopBusinessRegression } from "./commands/desktop-business.js";
import { runDesktopE2E } from "./commands/desktop-e2e.js";
import { runDesktopSmoke } from "./commands/desktop-smoke.js";
import { runDesktopSoak } from "./commands/desktop-soak.js";
import { runExplore } from "./commands/explore.js";
import { runLoad } from "./commands/load.js";
import { runPerf } from "./commands/perf.js";
import { writeSummaryReport } from "./commands/report.js";
import {
  assertBaseUrlAllowed,
  loadProfileConfig,
  loadTargetConfig,
  resolveA11yConfig,
  resolveChaosConfig,
  resolveDesktopSoakConfig,
  resolveExploreConfig,
  resolveLoadConfig,
  resolvePerfConfig,
  resolveSecurityConfig,
  resolveVisualConfig,
  runProfile,
} from "./commands/run.js";
import { runSecurity } from "./commands/security.js";
import { loadStateModel } from "./commands/state-model.js";
import { runTestSuite } from "./commands/test-suite.js";
import { runVisual } from "./commands/visual.js";

type Args = {
  command: string;
  profile?: string;
  target?: string;
  runId?: string;
  task?: string;
  maxSteps?: number;
  speedMode?: boolean;
  baseUrl?: string;
  app?: string;
  bundleId?: string;
  diagnosticsMaxItems?: number;
  exploreBudgetSeconds?: number;
  exploreMaxDepth?: number;
  exploreMaxStates?: number;
  exploreEngine?: "builtin" | "crawlee";
  chaosSeed?: number;
  chaosBudgetSeconds?: number;
  chaosClickRatio?: number;
  chaosInputRatio?: number;
  chaosScrollRatio?: number;
  chaosKeyboardRatio?: number;
  loadVus?: number;
  loadDurationSeconds?: number;
  loadRequestTimeoutMs?: number;
  loadEngine?: string;
  a11yMaxIssues?: number;
  a11yEngine?: "axe" | "builtin";
  perfPreset?: "mobile" | "desktop";
  perfEngine?: "lhci" | "builtin";
  visualEngine?: "builtin" | "lostpixel" | "backstop";
  visualMode?: "diff" | "update";
  aiReview?: boolean;
  aiReviewMaxArtifacts?: number;
  soakDurationSeconds?: number;
  soakIntervalSeconds?: number;
  autostartTarget?: boolean;
  geminiModel?: string;
  geminiThinkingLevel?: string;
  geminiToolMode?: string;
  geminiContextCacheMode?: string;
  geminiMediaResolution?: string;
};

const SUPPORTED_COMMANDS = [
  "run",
  "capture",
  "explore",
  "chaos",
  "a11y",
  "perf",
  "visual",
  "e2e",
  "load",
  "security",
  "computer-use",
  "desktop-readiness",
  "desktop-e2e",
  "desktop-business",
  "desktop-soak",
  "engines:check",
  "report",
] as const;

function printHelp(): void {}

function assertIntInRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer in [${min}, ${max}], got ${value}`);
  }
}

function assertNumberInRange(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected number in [${min}, ${max}], got ${value}`);
  }
}

export function validateRunOverrides(args: Args): void {
  if (args.baseUrl !== undefined) {
    try {
      const parsed = new URL(args.baseUrl);
      if (!parsed.protocol.startsWith("http")) {
        throw new Error("protocol");
      }
    } catch {
      throw new Error(`Invalid --base-url: expected valid http/https URL, got ${args.baseUrl}`);
    }
  }
  if (args.app !== undefined && args.app.trim().length === 0) {
    throw new Error("Invalid --app: empty value");
  }
  if (args.bundleId !== undefined && args.bundleId.trim().length === 0) {
    throw new Error("Invalid --bundle-id: empty value");
  }
  assertIntInRange("--diagnostics-max-items", args.diagnosticsMaxItems, 1, 1000);
  assertIntInRange("--explore-budget-seconds", args.exploreBudgetSeconds, 1, 86400);
  assertIntInRange("--explore-max-depth", args.exploreMaxDepth, 0, 50);
  assertIntInRange("--explore-max-states", args.exploreMaxStates, 1, 10000);
  if (args.exploreEngine !== undefined && !["builtin", "crawlee"].includes(args.exploreEngine)) {
    throw new Error(
      `Invalid --explore-engine: expected builtin|crawlee, got ${args.exploreEngine}`,
    );
  }
  assertIntInRange("--chaos-seed", args.chaosSeed, 0, 2147483647);
  assertIntInRange("--chaos-budget-seconds", args.chaosBudgetSeconds, 1, 86400);
  assertNumberInRange("--chaos-ratio-click", args.chaosClickRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-input", args.chaosInputRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-scroll", args.chaosScrollRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-keyboard", args.chaosKeyboardRatio, 0, 100);

  const ratioFields = [
    args.chaosClickRatio,
    args.chaosInputRatio,
    args.chaosScrollRatio,
    args.chaosKeyboardRatio,
  ].filter((v) => v !== undefined) as number[];
  if (ratioFields.length > 0) {
    const sum = ratioFields.reduce((acc, v) => acc + v, 0);
    if (sum <= 0) {
      throw new Error("Invalid chaos ratios: at least one provided ratio must be > 0");
    }
  }
  assertIntInRange("--load-vus", args.loadVus, 1, 10000);
  assertIntInRange("--load-duration-seconds", args.loadDurationSeconds, 1, 86400);
  assertIntInRange("--load-request-timeout-ms", args.loadRequestTimeoutMs, 100, 120000);
  assertIntInRange("--a11y-max-issues", args.a11yMaxIssues, 1, 10000);
  assertIntInRange("--ai-review-max-artifacts", args.aiReviewMaxArtifacts, 1, 500);
  assertIntInRange("--soak-duration-seconds", args.soakDurationSeconds, 5, 86400);
  assertIntInRange("--soak-interval-seconds", args.soakIntervalSeconds, 1, 3600);
  if (
    args.perfPreset !== undefined &&
    args.perfPreset !== "mobile" &&
    args.perfPreset !== "desktop"
  ) {
    throw new Error(`Invalid --perf-preset: expected mobile|desktop, got ${args.perfPreset}`);
  }
  if (args.visualMode !== undefined && args.visualMode !== "diff" && args.visualMode !== "update") {
    throw new Error(`Invalid --visual-mode: expected diff|update, got ${args.visualMode}`);
  }
  if (
    args.loadEngine !== undefined &&
    !["builtin", "artillery", "k6", "both"].includes(args.loadEngine)
  ) {
    throw new Error(
      `Invalid --load-engine: expected builtin|artillery|k6|both, got ${args.loadEngine}`,
    );
  }
  if (args.a11yEngine !== undefined && !["axe", "builtin"].includes(args.a11yEngine)) {
    throw new Error(`Invalid --a11y-engine: expected axe|builtin, got ${args.a11yEngine}`);
  }
  if (args.perfEngine !== undefined && !["lhci", "builtin"].includes(args.perfEngine)) {
    throw new Error(`Invalid --perf-engine: expected lhci|builtin, got ${args.perfEngine}`);
  }
  if (
    args.visualEngine !== undefined &&
    !["builtin", "lostpixel", "backstop"].includes(args.visualEngine)
  ) {
    throw new Error(
      `Invalid --visual-engine: expected builtin|lostpixel|backstop, got ${args.visualEngine}`,
    );
  }
}

function validateExploreOverrides(args: Args): void {
  assertIntInRange("--explore-budget-seconds", args.exploreBudgetSeconds, 1, 86400);
  assertIntInRange("--explore-max-depth", args.exploreMaxDepth, 0, 50);
  assertIntInRange("--explore-max-states", args.exploreMaxStates, 1, 10000);
  if (args.exploreEngine !== undefined && !["builtin", "crawlee"].includes(args.exploreEngine)) {
    throw new Error(
      `Invalid --explore-engine: expected builtin|crawlee, got ${args.exploreEngine}`,
    );
  }
}

function validateChaosOverrides(args: Args): void {
  assertIntInRange("--chaos-seed", args.chaosSeed, 0, 2147483647);
  assertIntInRange("--chaos-budget-seconds", args.chaosBudgetSeconds, 1, 86400);
  assertNumberInRange("--chaos-ratio-click", args.chaosClickRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-input", args.chaosInputRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-scroll", args.chaosScrollRatio, 0, 100);
  assertNumberInRange("--chaos-ratio-keyboard", args.chaosKeyboardRatio, 0, 100);

  const ratioFields = [
    args.chaosClickRatio,
    args.chaosInputRatio,
    args.chaosScrollRatio,
    args.chaosKeyboardRatio,
  ].filter((v) => v !== undefined) as number[];
  if (ratioFields.length > 0) {
    const sum = ratioFields.reduce((acc, v) => acc + v, 0);
    if (sum <= 0) {
      throw new Error("Invalid chaos ratios: at least one provided ratio must be > 0");
    }
  }
}

function validateComputerUseOverrides(args: Args): void {
  if (!args.task || args.task.trim().length === 0) {
    throw new Error("Invalid --task: value is required for computer-use command");
  }
  assertIntInRange("--max-steps", args.maxSteps, 1, 10_000);
}

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const args: Args = { command: command ?? "run" };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const next = rest[i + 1];
    if (token === "--profile" && next) {
      args.profile = next;
    }
    if (token === "--target" && next) {
      args.target = next;
    }
    if (token === "--run-id" && next) {
      args.runId = next;
    }
    if (token === "--task" && next) {
      args.task = next;
    }
    if (token === "--max-steps" && next) {
      args.maxSteps = Number(next);
    }
    if (token === "--speed-mode" && next && (next === "true" || next === "false")) {
      args.speedMode = next === "true";
    }
    if (token === "--base-url" && next) {
      args.baseUrl = next;
    }
    if (token === "--app" && next) {
      args.app = next;
    }
    if (token === "--bundle-id" && next) {
      args.bundleId = next;
    }
    if (token === "--diagnostics-max-items" && next) {
      args.diagnosticsMaxItems = Number(next);
    }
    if (token === "--explore-budget-seconds" && next) {
      args.exploreBudgetSeconds = Number(next);
    }
    if (token === "--explore-max-depth" && next) {
      args.exploreMaxDepth = Number(next);
    }
    if (token === "--explore-max-states" && next) {
      args.exploreMaxStates = Number(next);
    }
    if (token === "--explore-engine" && next && (next === "builtin" || next === "crawlee")) {
      args.exploreEngine = next;
    }
    if (token === "--chaos-seed" && next) {
      args.chaosSeed = Number(next);
    }
    if (token === "--chaos-budget-seconds" && next) {
      args.chaosBudgetSeconds = Number(next);
    }
    if (token === "--chaos-ratio-click" && next) {
      args.chaosClickRatio = Number(next);
    }
    if (token === "--chaos-ratio-input" && next) {
      args.chaosInputRatio = Number(next);
    }
    if (token === "--chaos-ratio-scroll" && next) {
      args.chaosScrollRatio = Number(next);
    }
    if (token === "--chaos-ratio-keyboard" && next) {
      args.chaosKeyboardRatio = Number(next);
    }
    if (token === "--load-vus" && next) {
      args.loadVus = Number(next);
    }
    if (token === "--load-duration-seconds" && next) {
      args.loadDurationSeconds = Number(next);
    }
    if (token === "--load-request-timeout-ms" && next) {
      args.loadRequestTimeoutMs = Number(next);
    }
    if (token === "--load-engine" && next) {
      args.loadEngine = next;
    }
    if (token === "--a11y-max-issues" && next) {
      args.a11yMaxIssues = Number(next);
    }
    if (token === "--a11y-engine" && next && (next === "axe" || next === "builtin")) {
      args.a11yEngine = next;
    }
    if (token === "--perf-preset" && next && (next === "mobile" || next === "desktop")) {
      args.perfPreset = next;
    }
    if (token === "--perf-engine" && next && (next === "lhci" || next === "builtin")) {
      args.perfEngine = next;
    }
    if (
      token === "--visual-engine" &&
      next &&
      (next === "builtin" || next === "lostpixel" || next === "backstop")
    ) {
      args.visualEngine = next;
    }
    if (token === "--visual-mode" && next && (next === "diff" || next === "update")) {
      args.visualMode = next;
    }
    if (token === "--ai-review" && next && (next === "true" || next === "false")) {
      args.aiReview = next === "true";
    }
    if (token === "--ai-review-max-artifacts" && next) {
      args.aiReviewMaxArtifacts = Number(next);
    }
    if (token === "--soak-duration-seconds" && next) {
      args.soakDurationSeconds = Number(next);
    }
    if (token === "--soak-interval-seconds" && next) {
      args.soakIntervalSeconds = Number(next);
    }
    if (token === "--autostart-target" && next && (next === "true" || next === "false")) {
      args.autostartTarget = next === "true";
    }
    if (token === "--gemini-model" && next) {
      args.geminiModel = next;
    }
    if (token === "--gemini-thinking-level" && next) {
      args.geminiThinkingLevel = next;
    }
    if (token === "--gemini-tool-mode" && next) {
      args.geminiToolMode = next;
    }
    if (token === "--gemini-context-cache-mode" && next) {
      args.geminiContextCacheMode = next;
    }
    if (token === "--gemini-media-resolution" && next) {
      args.geminiMediaResolution = next;
    }
  }

  return args;
}

type ComputerUseDispatchDependencies = {
  execute?: (options: ComputerUseOptions) => ComputerUseExecutionResult;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export function dispatchComputerUseCommand(
  args: Args,
  runId: string,
  dependencies: ComputerUseDispatchDependencies = {},
): number {
  validateComputerUseOverrides(args);
  const execute = dependencies.execute ?? runComputerUse;
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  const result = execute({
    task: args.task ?? "",
    maxSteps: args.maxSteps ?? 50,
    speedMode: args.speedMode ?? false,
    runId,
  });

  log(`runId=${runId}`);
  log(`computerUse=${JSON.stringify(result)}`);
  if (result.status !== "ok") {
    error(`computer_use_reason=${result.reason}`);
    if (result.error) {
      error(`computer_use_error=${result.error}`);
    }
    return result.exitCode > 0 ? result.exitCode : 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (args.command === "run") {
    validateRunOverrides(args);
    const profile = args.profile ?? "pr";
    const target = args.target ?? "web.local";
    const result = await runProfile(profile, target, args.runId, {
      baseUrl: args.baseUrl,
      app: args.app,
      bundleId: args.bundleId,
      diagnosticsMaxItems: args.diagnosticsMaxItems,
      exploreBudgetSeconds: args.exploreBudgetSeconds,
      exploreMaxDepth: args.exploreMaxDepth,
      exploreMaxStates: args.exploreMaxStates,
      exploreEngine: args.exploreEngine,
      chaosSeed: args.chaosSeed,
      chaosBudgetSeconds: args.chaosBudgetSeconds,
      chaosClickRatio: args.chaosClickRatio,
      chaosInputRatio: args.chaosInputRatio,
      chaosScrollRatio: args.chaosScrollRatio,
      chaosKeyboardRatio: args.chaosKeyboardRatio,
      loadVus: args.loadVus,
      loadDurationSeconds: args.loadDurationSeconds,
      loadRequestTimeoutMs: args.loadRequestTimeoutMs,
      loadEngine: args.loadEngine as "builtin" | "artillery" | "k6" | "both" | undefined,
      a11yMaxIssues: args.a11yMaxIssues,
      a11yEngine: args.a11yEngine,
      perfPreset: args.perfPreset,
      perfEngine: args.perfEngine,
      visualEngine: args.visualEngine,
      visualMode: args.visualMode,
      aiReview: args.aiReview,
      aiReviewMaxArtifacts: args.aiReviewMaxArtifacts,
      soakDurationSeconds: args.soakDurationSeconds,
      soakIntervalSeconds: args.soakIntervalSeconds,
      autostartTarget: args.autostartTarget,
    });
    try {
      const manifestRaw = readFileSync(result.manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw) as { gateResults?: { status?: string } };
      const gateStatus = manifest.gateResults?.status ?? "unknown";
      if (gateStatus !== "passed") {
        process.exit(2);
      }
    } catch (_error) {
      process.exit(3);
    }
    return;
  }

  const runId = sanitizeRunId(args.runId ?? new Date().toISOString().replace(/[:.]/g, "-"));
  if (args.command === "computer-use") {
    const exitCode = dispatchComputerUseCommand(args, runId);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }
  const baseDir = ensureRunDirectories(runId);

  if (args.command === "capture") {
    validateRunOverrides(args);
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for capture`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const stateModel = loadStateModel();
    const useCaptureApiMock =
      target.type === "web" &&
      (target.name === "web.ci" || process.env.UIQ_CAPTURE_API_MOCK === "1");
    const _result = await runCapture(baseDir, effectiveBaseUrl, {
      states: [...stateModel.configuredRoutes, ...stateModel.configuredStories],
      mockApis: useCaptureApiMock,
    });
    return;
  }

  if (args.command === "explore") {
    validateRunOverrides(args);
    validateExploreOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "nightly");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for explore`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runExplore(
      baseDir,
      resolveExploreConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        exploreBudgetSeconds: args.exploreBudgetSeconds,
        exploreMaxDepth: args.exploreMaxDepth,
        exploreMaxStates: args.exploreMaxStates,
        exploreEngine: args.exploreEngine,
      }),
    );
    return;
  }

  if (args.command === "chaos") {
    validateRunOverrides(args);
    validateChaosOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "nightly");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for chaos`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runChaos(
      baseDir,
      resolveChaosConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        chaosSeed: args.chaosSeed,
        chaosBudgetSeconds: args.chaosBudgetSeconds,
        chaosClickRatio: args.chaosClickRatio,
        chaosInputRatio: args.chaosInputRatio,
        chaosScrollRatio: args.chaosScrollRatio,
        chaosKeyboardRatio: args.chaosKeyboardRatio,
      }),
    );
    return;
  }

  if (args.command === "a11y") {
    validateRunOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "pr");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for a11y`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runA11y(
      baseDir,
      resolveA11yConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        a11yMaxIssues: args.a11yMaxIssues,
        a11yEngine: args.a11yEngine as "axe" | "builtin" | undefined,
      }),
    );
    return;
  }

  if (args.command === "perf") {
    validateRunOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "pr");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for perf`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runPerf(
      baseDir,
      resolvePerfConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        perfPreset: args.perfPreset as "mobile" | "desktop" | undefined,
        perfEngine: args.perfEngine as "lhci" | "builtin" | undefined,
      }),
    );
    return;
  }

  if (args.command === "visual") {
    validateRunOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "pr");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for visual`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runVisual(
      baseDir,
      resolveVisualConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        visualMode: args.visualMode,
        visualEngine: args.visualEngine,
      }),
    );
    return;
  }

  if (args.command === "unit" || args.command === "ct" || args.command === "e2e") {
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    const e2eSuite =
      args.command === "e2e"
        ? (loadProfileConfig(args.profile ?? "pr").tests?.e2eSuite ?? "smoke")
        : "smoke";
    const result = runTestSuite(baseDir, args.command, effectiveBaseUrl, e2eSuite);
    if (result.status !== "passed") {
      process.exit(2);
    }
    return;
  }

  if (args.command === "report") {
    const _reportPath = writeSummaryReport(baseDir, "passed", []);
    return;
  }

  if (args.command === "load") {
    validateRunOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "nightly");
    const target = loadTargetConfig(args.target ?? "web.local");
    const effectiveBaseUrl = args.baseUrl ?? target.baseUrl;
    if (!effectiveBaseUrl) {
      throw new Error(`Target '${target.name}' missing baseUrl for load`);
    }
    assertBaseUrlAllowed(target, effectiveBaseUrl);
    const _result = await runLoad(
      baseDir,
      resolveLoadConfig(target, profile, {
        baseUrl: effectiveBaseUrl,
        loadVus: args.loadVus,
        loadDurationSeconds: args.loadDurationSeconds,
        loadRequestTimeoutMs: args.loadRequestTimeoutMs,
        loadEngine: args.loadEngine as "builtin" | "artillery" | "k6" | "both" | undefined,
      }),
    );
    return;
  }

  if (args.command === "security") {
    const profile = loadProfileConfig(args.profile ?? "nightly");
    const target = loadTargetConfig(args.target ?? "web.local");
    const _result = runSecurity(baseDir, resolveSecurityConfig(target, profile));
    return;
  }

  if (args.command === "desktop-readiness") {
    const target = loadTargetConfig(args.target ?? "tauri.macos");
    const _result = runDesktopReadiness(baseDir, {
      targetType: target.type,
      app: args.app,
      bundleId: args.bundleId,
    });
    return;
  }

  if (args.command === "desktop-smoke") {
    const target = loadTargetConfig(args.target ?? "tauri.macos");
    const _result = await runDesktopSmoke(baseDir, {
      targetType: target.type,
      app: args.app,
      bundleId: args.bundleId,
    });
    return;
  }

  if (args.command === "desktop-e2e") {
    const target = loadTargetConfig(args.target ?? "tauri.macos");
    const _result = await runDesktopE2E(baseDir, {
      targetType: target.type,
      app: args.app,
      bundleId: args.bundleId,
    });
    return;
  }

  if (args.command === "desktop-business") {
    validateRunOverrides(args);
    const target = loadTargetConfig(args.target ?? "tauri.macos");
    const defaultProfile = target.type === "swift" ? "swift.regression" : "tauri.regression";
    const profile = loadProfileConfig(args.profile ?? defaultProfile);
    const _result = await runDesktopBusinessRegression(baseDir, {
      targetType: target.type,
      app: args.app ?? target.app,
      bundleId: args.bundleId ?? target.bundleId,
      businessInteractionRequired: profile.desktopE2E?.keyboardInteractionRequired !== false,
    });
    return;
  }

  if (args.command === "desktop-soak") {
    validateRunOverrides(args);
    const profile = loadProfileConfig(args.profile ?? "tauri.smoke");
    const target = loadTargetConfig(args.target ?? "tauri.macos");
    const _result = await runDesktopSoak(
      baseDir,
      resolveDesktopSoakConfig(target, profile, {
        app: args.app,
        bundleId: args.bundleId,
        soakDurationSeconds: args.soakDurationSeconds,
        soakIntervalSeconds: args.soakIntervalSeconds,
      }),
    );
    return;
  }

  if (args.command === "engines:check") {
    const profile = args.profile ?? "pr";
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), "scripts/ci/check-engine-runtime.mjs"), "--profile", profile],
      {
        stdio: "inherit",
      },
    );
    if ((result.status ?? 1) !== 0) {
      process.exit(result.status ?? 1);
    }
    return;
  }
  process.exit(1);
}

const cliEntrypoint = process.argv[1];
const isCliEntrypoint = cliEntrypoint
  ? import.meta.url === pathToFileURL(cliEntrypoint).href
  : false;

if (isCliEntrypoint) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  });
}
