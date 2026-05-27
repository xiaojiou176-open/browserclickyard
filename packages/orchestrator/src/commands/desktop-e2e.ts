import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDesktopLifecycleStrategy } from "./desktop-lifecycle.js";
import {
  DESKTOP_HOST_SAFETY_REASON_CODE,
  getWindowCount,
  isProcessRunning,
  requireOperatorManualDesktopAutomation,
  runChecked,
  sleep,
} from "./desktop-utils.js";

export type DesktopE2EConfig = {
  targetType: string;
  app?: string;
  bundleId?: string;
  businessInteractionRequired?: boolean;
  seed?: number;
};

export type DesktopE2ECheck = {
  id: string;
  status: "passed" | "blocked";
  detail: string;
  reasonCode?: string;
};

export type DesktopE2EResult = {
  targetType: string;
  status: "passed" | "blocked";
  reasonCode?: string;
  checks: DesktopE2ECheck[];
  interactionMetrics?: DesktopE2EInteractionMetrics;
  interactionRounds?: DesktopE2EInteractionRound[];
  interactionMetadata?: DesktopE2EInteractionMetadata;
  screenshotPath?: string;
  reportPath: string;
};

export type DesktopE2EInteractionType = "click" | "tab" | "scroll" | "input";

export type DesktopE2EInteractionRound = {
  round: number;
  action: DesktopE2EInteractionType;
  status: "passed" | "blocked";
  detail: string;
  durationMs: number;
};

export type DesktopE2EInteractionMetrics = {
  roundsPlanned: number;
  roundsExecuted: number;
  passedRounds: number;
  failedRounds: number;
  coveredActions: DesktopE2EInteractionType[];
  coverageRequirementMet: boolean;
  byAction: Record<
    DesktopE2EInteractionType,
    {
      attempted: number;
      passed: number;
      failed: number;
    }
  >;
};

export type DesktopE2EInteractionMetadata = {
  plannerVersion: "seeded-lcg-v1";
  seed: number;
  roundsRequested: number;
  roundsPlanned: number;
  minimumActionCoverage: number;
  plan: DesktopE2EInteractionType[];
  businessInteractionRequired: boolean;
};

type DesktopActivateTarget = "tauri" | "swift";

const INTERACTION_ACTIONS: DesktopE2EInteractionType[] = ["click", "tab", "scroll", "input"];
const INTERACTION_ROUNDS = 8;
const MIN_ACTION_COVERAGE = 3;
const DEFAULT_INTERACTION_SEED = 20260220;

function isBusinessInteractionOptional(config: DesktopE2EConfig, checkId: string): boolean {
  if (config.businessInteractionRequired !== false) {
    return false;
  }
  return (
    checkId === "desktop.e2e.business.interaction" ||
    checkId === "desktop.e2e.business.state" ||
    checkId === "desktop.e2e.business.deep_interaction"
  );
}

function isBlockingCheck(config: DesktopE2EConfig, check: DesktopE2ECheck): boolean {
  return !isBusinessInteractionOptional(config, check.id);
}

function swiftInteractionReasonCode(detail: string): string {
  const normalized = detail.toLowerCase();
  if (normalized.includes("host safety policy") || normalized.includes("host-safe operator workflow")) {
    return DESKTOP_HOST_SAFETY_REASON_CODE;
  }
  if (
    normalized.includes("not allowed assistive access") ||
    normalized.includes("not authorised to send keystrokes") ||
    normalized.includes("not authorized to send keystrokes")
  ) {
    return "desktop.swift.system_events.permission_denied";
  }
  return "desktop.swift.system_events.interaction_failed";
}

function block(
  reportPath: string,
  targetType: string,
  checks: DesktopE2ECheck[],
  interactionMetadata?: DesktopE2EInteractionMetadata,
): DesktopE2EResult {
  const firstBlocked = checks.find((c) => c.status === "blocked");
  return {
    targetType,
    status: checks.every((c) => c.status === "passed") ? "passed" : "blocked",
    reasonCode: firstBlocked?.reasonCode,
    checks,
    interactionMetadata,
    reportPath,
  };
}

function runBusinessInteractionScript(): { ok: boolean; detail: string } {
  return {
    ok: false,
    detail: "desktop business interaction now requires a future host-safe operator workflow",
  };
}

export function buildActivateCheck(
  target: DesktopActivateTarget,
  activate: { ok: boolean; detail: string },
): DesktopE2ECheck {
  return {
    id: "desktop.e2e.activate",
    status: activate.ok ? "passed" : "blocked",
    detail: activate.detail,
    reasonCode: activate.ok ? undefined : `desktop.${target}.activate.failed`,
  };
}

export function buildDeepInteractionCheck(metrics: DesktopE2EInteractionMetrics): DesktopE2ECheck {
  const detail = `success_coverage=${metrics.coveredActions.join(",")}; rounds=${metrics.roundsExecuted}; failed=${metrics.failedRounds}`;
  if (metrics.coverageRequirementMet) {
    return {
      id: "desktop.e2e.business.deep_interaction",
      status: "passed",
      detail,
    };
  }
  return {
    id: "desktop.e2e.business.deep_interaction",
    status: "blocked",
    detail,
    reasonCode: "desktop.e2e.deep_interaction.success_coverage_insufficient",
  };
}

function resolveInteractionSeed(seed: number | undefined): number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    return DEFAULT_INTERACTION_SEED;
  }
  const normalized = Math.floor(seed) >>> 0;
  return normalized === 0 ? DEFAULT_INTERACTION_SEED : normalized;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffleActions(
  values: DesktopE2EInteractionType[],
  nextRandom: () => number,
): DesktopE2EInteractionType[] {
  const pool = [...values];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function buildInteractionPlan(rounds: number, seed: number): DesktopE2EInteractionType[] {
  const normalizedRounds = Math.max(MIN_ACTION_COVERAGE, rounds);
  const nextRandom = createSeededRandom(seed);
  const plan = shuffleActions(INTERACTION_ACTIONS, nextRandom).slice(0, MIN_ACTION_COVERAGE);
  while (plan.length < normalizedRounds) {
    const idx = Math.floor(nextRandom() * INTERACTION_ACTIONS.length);
    plan.push(INTERACTION_ACTIONS[idx]);
  }
  return plan;
}

export function isBusinessInteractionBlocking(config: DesktopE2EConfig): boolean {
  return config.businessInteractionRequired !== false;
}

function runRandomInteractionRound(
  action: DesktopE2EInteractionType,
  round: number,
): { ok: boolean; detail: string } {
  return {
    ok: false,
    detail: `desktop ${action} interaction round ${round} blocked by host safety policy`,
  };
}

function runDeepInteractionRounds(
  plan: DesktopE2EInteractionType[],
): { metrics: DesktopE2EInteractionMetrics; rounds: DesktopE2EInteractionRound[] } {
  const rounds: DesktopE2EInteractionRound[] = [];
  const byAction: DesktopE2EInteractionMetrics["byAction"] = {
    click: { attempted: 0, passed: 0, failed: 0 },
    tab: { attempted: 0, passed: 0, failed: 0 },
    scroll: { attempted: 0, passed: 0, failed: 0 },
    input: { attempted: 0, passed: 0, failed: 0 },
  };
  const coveredActions = new Set<DesktopE2EInteractionType>();
  for (let i = 0; i < plan.length; i += 1) {
    const action = plan[i];
    byAction[action].attempted += 1;
    const startedAt = Date.now();
    const result = runRandomInteractionRound(action, i + 1);
    const passed = result.ok;
    if (passed) {
      coveredActions.add(action);
      byAction[action].passed += 1;
    } else {
      byAction[action].failed += 1;
    }
    rounds.push({
      round: i + 1,
      action,
      status: passed ? "passed" : "blocked",
      detail: result.detail,
      durationMs: Date.now() - startedAt,
    });
  }
  const passedRounds = rounds.filter((round) => round.status === "passed").length;
  const metrics: DesktopE2EInteractionMetrics = {
    roundsPlanned: plan.length,
    roundsExecuted: rounds.length,
    passedRounds,
    failedRounds: rounds.length - passedRounds,
    coveredActions: Array.from(coveredActions),
    coverageRequirementMet: coveredActions.size >= MIN_ACTION_COVERAGE,
    byAction,
  };
  return { metrics, rounds };
}

export async function runDesktopE2E(
  baseDir: string,
  config: DesktopE2EConfig,
): Promise<DesktopE2EResult> {
  const reportPath = "metrics/desktop-e2e.json";
  const screenshotPath = `screenshots/desktop-${config.targetType}-e2e.png`;
  const screenshotAbs = resolve(baseDir, screenshotPath);
  const interactionSeed = resolveInteractionSeed(config.seed);
  const interactionPlan = buildInteractionPlan(INTERACTION_ROUNDS, interactionSeed);
  const interactionMetadata: DesktopE2EInteractionMetadata = {
    plannerVersion: "seeded-lcg-v1",
    seed: interactionSeed,
    roundsRequested: INTERACTION_ROUNDS,
    roundsPlanned: interactionPlan.length,
    minimumActionCoverage: MIN_ACTION_COVERAGE,
    plan: interactionPlan,
    businessInteractionRequired: isBusinessInteractionBlocking(config),
  };
  const checks: DesktopE2ECheck[] = [];
  let interactionMetrics: DesktopE2EInteractionMetrics | undefined;
  let interactionRounds: DesktopE2EInteractionRound[] | undefined;

  const lifecycle = createDesktopLifecycleStrategy(config);
  if (!lifecycle.ok) {
    const result =
      lifecycle.reasonCode === "desktop.tauri.app.missing"
        ? block(
            reportPath,
            config.targetType,
            [
              {
                id: "desktop.e2e.app",
                status: "blocked",
                detail: "target.app is required",
                reasonCode: lifecycle.reasonCode,
              },
            ],
            interactionMetadata,
          )
        : lifecycle.reasonCode === "desktop.swift.bundle.missing"
          ? block(
              reportPath,
              config.targetType,
              [
                {
                  id: "desktop.e2e.bundle",
                  status: "blocked",
                  detail: "target.bundleId is required",
                  reasonCode: lifecycle.reasonCode,
                },
              ],
              interactionMetadata,
            )
          : block(
              reportPath,
              config.targetType,
              [
                {
                  id: "desktop.e2e.unsupported",
                  status: "blocked",
                  detail: `unsupported target.type=${config.targetType}`,
                  reasonCode: lifecycle.reasonCode,
                },
              ],
              interactionMetadata,
            );
    writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  const guard = requireOperatorManualDesktopAutomation("desktop-e2e");
  if (!guard.ok) {
    const result = block(
      reportPath,
      config.targetType,
      [
        {
          id: "desktop.e2e.host_safety",
          status: "blocked",
          detail: guard.detail,
          reasonCode: DESKTOP_HOST_SAFETY_REASON_CODE,
        },
      ],
      interactionMetadata,
    );
    writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  const launch = lifecycle.launch();
  checks.push({
    id: "desktop.e2e.launch",
    status: launch.ok ? "passed" : "blocked",
    detail: launch.detail,
  });
  await sleep(2000);

  if (lifecycle.targetType === "tauri") {
    const bundleId = lifecycle.resolveBundleId();
    if (!bundleId) {
      checks.push({
        id: "desktop.e2e.bundle",
        status: "blocked",
        detail: `cannot resolve bundleId from ${config.app}`,
        reasonCode: "desktop.tauri.bundle.lookup_failed",
      });
    } else {
      const activate = lifecycle.activate(bundleId, 30000);
      checks.push({
        id: "desktop.e2e.activate",
        status: "passed",
        detail: activate.ok ? activate.detail : `optional_activate_failed: ${activate.detail}`,
      });
    }
    await sleep(1200);

    const appName = lifecycle.appName ?? lifecycle.resolveAppName(bundleId) ?? "unknown";
    const processRunning = isProcessRunning(appName);
    checks.push({
      id: "desktop.e2e.process",
      status: processRunning ? "passed" : "blocked",
      detail: `process ${appName} ${processRunning ? "running" : "not running"}`,
    });

    const windows = getWindowCount(appName);
    checks.push({
      id: "desktop.e2e.window",
      status: windows && windows > 0 ? "passed" : processRunning ? "passed" : "blocked",
      detail:
        windows !== undefined
          ? `window_count=${windows}`
          : processRunning
            ? "window_count unavailable (non-blocking while process is running)"
            : "window_count unavailable",
    });

    const interaction = runBusinessInteractionScript();
    checks.push({
      id: "desktop.e2e.business.interaction",
      status: interaction.ok ? "passed" : "blocked",
      detail: interaction.detail,
    });
    await sleep(800);

    const processAfterInteraction = isProcessRunning(appName);
    const windowsAfterInteraction = getWindowCount(appName);
    checks.push({
      id: "desktop.e2e.business.state",
      status:
        processAfterInteraction &&
        (windowsAfterInteraction === undefined || windowsAfterInteraction > 0)
          ? "passed"
          : "blocked",
      detail: `running=${processAfterInteraction}; window_count=${windowsAfterInteraction ?? "unknown"}`,
    });

    const deepInteraction = runDeepInteractionRounds(interactionPlan);
    interactionMetrics = deepInteraction.metrics;
    interactionRounds = deepInteraction.rounds;
    checks.push(buildDeepInteractionCheck(deepInteraction.metrics));

    const screenshot = runChecked("screencapture", ["-x", screenshotAbs]);
    checks.push({
      id: "desktop.e2e.screenshot",
      status: screenshot.ok ? "passed" : "blocked",
      detail: screenshot.detail,
    });

    let quit = lifecycle.quit({
      bundleId: bundleId ?? "",
      appName,
      timeoutMs: 30000,
    });
    checks.push({
      id: "desktop.e2e.quit",
      status: quit.ok ? "passed" : "blocked",
      detail: quit.detail,
    });
  } else {
    const bundleId = lifecycle.resolveBundleId() ?? "";
    const activate = lifecycle.activate(bundleId, 30000);
    checks.push({
      id: "desktop.e2e.activate",
      status: "passed",
      detail: activate.ok ? activate.detail : `optional_activate_failed: ${activate.detail}`,
    });
    await sleep(1200);

    const appName = lifecycle.resolveAppName(bundleId);
    if (!appName) {
      checks.push({
        id: "desktop.e2e.process",
        status: "blocked",
        detail: `cannot resolve app name from bundleId=${bundleId}`,
        reasonCode: "desktop.swift.bundle.app_name_unresolved",
      });
      checks.push({
        id: "desktop.e2e.window",
        status: "blocked",
        detail: "window check skipped due to missing app name",
      });
    } else {
      const processRunning = isProcessRunning(appName);
      checks.push({
        id: "desktop.e2e.process",
        status: processRunning ? "passed" : "blocked",
        detail: `process ${appName} ${processRunning ? "running" : "not running"}`,
      });
      const windows = getWindowCount(appName);
      checks.push({
        id: "desktop.e2e.window",
        status: windows && windows > 0 ? "passed" : processRunning ? "passed" : "blocked",
        detail:
          windows !== undefined
            ? `window_count=${windows}`
            : processRunning
              ? "window_count unavailable (non-blocking while process is running)"
              : "window_count unavailable",
      });
    }

    const interaction = runBusinessInteractionScript();
    checks.push({
      id: "desktop.e2e.business.interaction",
      status: interaction.ok ? "passed" : "blocked",
      detail: interaction.ok
        ? interaction.detail
        : `interaction_check_failed: ${interaction.detail}`,
      reasonCode: interaction.ok ? undefined : swiftInteractionReasonCode(interaction.detail),
    });
    await sleep(800);

    const processAfterInteraction = appName ? isProcessRunning(appName) : false;
    const windowsAfterInteraction = appName ? getWindowCount(appName) : undefined;
    checks.push({
      id: "desktop.e2e.business.state",
      status:
        processAfterInteraction &&
        (windowsAfterInteraction === undefined || windowsAfterInteraction > 0)
          ? "passed"
          : "blocked",
      detail: `running=${processAfterInteraction}; window_count=${windowsAfterInteraction ?? "unknown"}`,
    });

    const deepInteraction = runDeepInteractionRounds(interactionPlan);
    interactionMetrics = deepInteraction.metrics;
    interactionRounds = deepInteraction.rounds;
    checks.push(buildDeepInteractionCheck(deepInteraction.metrics));

    const screenshot = runChecked("screencapture", ["-x", screenshotAbs]);
    checks.push({
      id: "desktop.e2e.screenshot",
      status: screenshot.ok ? "passed" : "blocked",
      detail: screenshot.detail,
    });

    let quit = lifecycle.quit({
      bundleId,
      appName,
      timeoutMs: 30000,
    });
    checks.push({
      id: "desktop.e2e.quit",
      status: quit.ok ? "passed" : "blocked",
      detail: quit.detail,
    });
  }

  const screenshotCheck = checks.find((c) => c.id === "desktop.e2e.screenshot");
  const blockingChecks = checks.filter((check) => isBlockingCheck(config, check));
  const firstBlocked = blockingChecks.find((c) => c.status === "blocked");
  const result: DesktopE2EResult = {
    targetType: config.targetType,
    status: blockingChecks.every((c) => c.status === "passed") ? "passed" : "blocked",
    reasonCode: firstBlocked?.reasonCode,
    checks,
    interactionMetrics,
    interactionRounds,
    interactionMetadata,
    screenshotPath: screenshotCheck?.status === "passed" ? screenshotPath : undefined,
    reportPath,
  };
  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}
