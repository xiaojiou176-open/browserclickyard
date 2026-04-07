// @ts-nocheck
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

export type VisualConfig = {
  baseUrl: string;
  targetName: string;
  mode: "diff" | "update";
  baselineDir?: string;
  maxDiffPixels?: number;
  engine?: "builtin" | "lostpixel" | "backstop";
};

export type VisualResult = {
  engine: "builtin-png-diff" | "lostpixel-bridge" | "backstop-bridge";
  engineUsed: "builtin" | "lostpixel" | "backstop";
  executionStatus: "ok" | "blocked";
  blockedReasonCode?: string;
  blockedDetail?: string;
  url: string;
  mode: VisualConfig["mode"];
  baselineCreated: boolean;
  baselinePath: string;
  currentPath: string;
  diffPath?: string;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  reportPath: string;
};

const VISUAL_REASON_DIFF_PIXELS_EXCEEDED = "gate.visual_engine.blocked.diff_pixels_exceeded";

type BaselineMeta = {
  schemaVersion: number;
  targetName: string;
  viewport: string;
  captureMode: "viewport";
  timezone: string;
  locale: string;
  reducedMotion: "reduce";
  seed: number;
  animationPolicy: "disabled";
  frontendEntry: "frontend";
};
const DETERMINISTIC_TIMEZONE = "UTC";
const DETERMINISTIC_LOCALE = "en-US";
const DETERMINISTIC_SEED = 20260218;

async function enableDeterministicMode(
  page: import("playwright").Page,
  seed: number,
): Promise<void> {
  await page.addInitScript(
    ({ seeded }) => {
      let state = seeded >>> 0 || 1;
      Math.random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
      window.localStorage.clear();
      window.localStorage.setItem("ab_onboarding_done", "1");
      window.localStorage.setItem("ab_automation_client_id", "client-visual-ci");
      document.documentElement.setAttribute("data-uiq-visual", "1");
    },
    { seeded: seed },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function stabilizeAnimations(page: import("playwright").Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important;}html{scroll-behavior:auto !important;}[data-uiq-visual="1"] .header-stats,[data-uiq-visual="1"] .toast-stack,[data-uiq-visual="1"] .tour-backdrop,[data-uiq-visual="1"] .tour-popover,[data-uiq-visual="1"] .tour-spotlight,[data-uiq-visual="1"] .log-time{visibility:hidden !important;}`,
  });
}

async function waitForVisualStability(page: import("playwright").Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    // networkidle is best-effort only; some pages keep long-lived connections.
  }
  await page.evaluate(async () => {
    const fonts = (document as Document & { fonts?: { ready: Promise<void> } }).fonts;
    if (fonts?.ready) {
      await fonts.ready;
    }
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function waitForHomeContentReady(page: import("playwright").Page): Promise<void> {
  try {
    await Promise.race([
      page.locator("text=暂无模板").first().waitFor({ state: "visible", timeout: 4000 }),
      page.locator(".template-card").first().waitFor({ state: "visible", timeout: 4000 }),
    ]);
  } catch {
    // Keep snapshot flow resilient for non-home routes or transient UI states.
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function installVisualApiMocks(page: import("playwright").Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    let pathname = "";
    try {
      pathname = new URL(requestUrl).pathname;
    } catch {
      await route.continue();
      return;
    }

    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });

    if (pathname === "/health/diagnostics") {
      await json({
        uptime_seconds: 3600,
        task_total: 0,
        task_counts: { running: 0, success: 0, failed: 0 },
      });
      return;
    }
    if (pathname === "/health/alerts") {
      await json({ state: "ok", failure_rate: 0, threshold: 0.1, completed: 0, failed: 0 });
      return;
    }
    if (pathname === "/api/automation/commands") {
      await json({
        commands: [
          {
            command_id: "script-pipeline-capture",
            title: "仅 UI 流程（manual）",
            description: "视觉基线稳定命令",
            tags: ["safe"],
          },
        ],
      });
      return;
    }
    if (pathname === "/api/automation/tasks") {
      await json({ tasks: [] });
      return;
    }
    if (pathname === "/api/command-tower/latest-flow") {
      await json({
        session_id: "visual-session",
        start_url: "http://example.local",
        generated_at: "2026-01-01T00:00:00.000Z",
        source_event_count: 0,
        step_count: 0,
        steps: [],
      });
      return;
    }
    if (pathname === "/api/command-tower/latest-flow-draft") {
      await json({ session_id: "visual-session", flow: null });
      return;
    }
    if (pathname === "/api/command-tower/evidence-timeline") {
      await json({ items: [] });
      return;
    }
    if (pathname === "/api/command-tower/overview") {
      await json({ sessions_total: 0, tasks_total: 0, success_rate: 1, latency_ms_p95: 0 });
      return;
    }
    if (pathname === "/api/command-tower/alerts") {
      await json({ state: "ok", items: [] });
      return;
    }
    if (pathname === "/api/pm/sessions") {
      await json({ sessions: [] });
      return;
    }
    if (pathname === "/api/events") {
      await json({ items: [] });
      return;
    }
    if (pathname === "/api/flows") {
      await json({ flows: [] });
      return;
    }
    if (pathname === "/api/templates") {
      await json({ templates: [] });
      return;
    }
    if (pathname === "/api/runs") {
      await json({ runs: [] });
      return;
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/health/")) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ detail: `visual mock route not configured: ${pathname}` }),
      });
      return;
    }
    await route.continue();
  });
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

function diffImages(base: PNG, curr: PNG): { diff: PNG; diffPixels: number; totalPixels: number } {
  const width = Math.max(base.width, curr.width);
  const height = Math.max(base.height, curr.height);
  const diff = new PNG({ width, height });
  const totalPixels = width * height;
  let diffPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const inBase = x < base.width && y < base.height;
      const inCurr = x < curr.width && y < curr.height;

      const bR = inBase ? base.data[(base.width * y + x) << 2] : 0;
      const bG = inBase ? base.data[((base.width * y + x) << 2) + 1] : 0;
      const bB = inBase ? base.data[((base.width * y + x) << 2) + 2] : 0;
      const bA = inBase ? base.data[((base.width * y + x) << 2) + 3] : 0;

      const cR = inCurr ? curr.data[(curr.width * y + x) << 2] : 0;
      const cG = inCurr ? curr.data[((curr.width * y + x) << 2) + 1] : 0;
      const cB = inCurr ? curr.data[((curr.width * y + x) << 2) + 2] : 0;
      const cA = inCurr ? curr.data[((curr.width * y + x) << 2) + 3] : 0;

      const isDifferent = bR !== cR || bG !== cG || bB !== cB || bA !== cA;
      if (isDifferent) {
        diffPixels += 1;
        diff.data[idx] = 255;
        diff.data[idx + 1] = 0;
        diff.data[idx + 2] = 0;
        diff.data[idx + 3] = 255;
      } else {
        diff.data[idx] = cR;
        diff.data[idx + 1] = cG;
        diff.data[idx + 2] = cB;
        diff.data[idx + 3] = 90;
      }
    }
  }

  return { diff, diffPixels, totalPixels };
}

export function deriveVisualExecutionStatus(input: {
  diffPixels: number;
  maxDiffPixels?: number;
}): Pick<VisualResult, "executionStatus" | "blockedReasonCode" | "blockedDetail"> {
  if (
    typeof input.maxDiffPixels === "number" &&
    Number.isFinite(input.maxDiffPixels) &&
    input.maxDiffPixels >= 0
  ) {
    const normalizedMax = Math.floor(input.maxDiffPixels);
    if (input.diffPixels > normalizedMax) {
      return {
        executionStatus: "blocked",
        blockedReasonCode: VISUAL_REASON_DIFF_PIXELS_EXCEEDED,
        blockedDetail: `diff pixels ${input.diffPixels} exceeded maxDiffPixels ${normalizedMax}`,
      };
    }
  }
  return {
    executionStatus: "ok",
    blockedReasonCode: undefined,
    blockedDetail: undefined,
  };
}

async function runBuiltinVisual(baseDir: string, config: VisualConfig): Promise<VisualResult> {
  const baselineRoot = resolve(
    config.baselineDir ?? `.runtime-cache/cache/visual-baselines/${config.targetName}`,
  );
  mkdirSync(baselineRoot, { recursive: true });

  const baselineAbs = resolve(baselineRoot, "home_default.png");
  const baselineMetaAbs = resolve(baselineRoot, "baseline.meta.json");
  const currentRel = "visual/current/home_default.png";
  const diffRel = "visual/diff/home_default.png";
  const reportPath = "visual/report.json";

  const currentAbs = resolve(baseDir, currentRel);
  mkdirSync(resolve(baseDir, "visual/current"), { recursive: true });
  mkdirSync(resolve(baseDir, "visual/diff"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    timezoneId: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const page = await context.newPage();
  await enableDeterministicMode(page, DETERMINISTIC_SEED);
  await installVisualApiMocks(page);

  try {
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await stabilizeAnimations(page);
    await waitForVisualStability(page);
    await waitForHomeContentReady(page);
    await page.screenshot({ path: currentAbs, fullPage: false });
  } finally {
    await context.close();
    await browser.close();
  }

  const expectedMeta: BaselineMeta = {
    schemaVersion: 6,
    targetName: config.targetName,
    viewport: "1366x768",
    captureMode: "viewport",
    timezone: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    seed: DETERMINISTIC_SEED,
    animationPolicy: "disabled",
    frontendEntry: "frontend",
  };
  let existingMeta: BaselineMeta | undefined;
  if (existsSync(baselineMetaAbs)) {
    try {
      existingMeta = JSON.parse(readFileSync(baselineMetaAbs, "utf8")) as BaselineMeta;
    } catch {
      existingMeta = undefined;
    }
  }
  const baselineMetaCompatible =
    existingMeta?.schemaVersion === expectedMeta.schemaVersion &&
    existingMeta?.targetName === expectedMeta.targetName &&
    existingMeta?.viewport === expectedMeta.viewport &&
    existingMeta?.captureMode === expectedMeta.captureMode &&
    existingMeta?.timezone === expectedMeta.timezone &&
    existingMeta?.locale === expectedMeta.locale &&
    existingMeta?.reducedMotion === expectedMeta.reducedMotion &&
    existingMeta?.seed === expectedMeta.seed &&
    existingMeta?.animationPolicy === expectedMeta.animationPolicy &&
    existingMeta?.frontendEntry === expectedMeta.frontendEntry;

  const shouldBootstrapBaseline = !existsSync(baselineAbs) || !baselineMetaCompatible;
  let baselineCreated = false;

  if (shouldBootstrapBaseline) {
    copyFileSync(currentAbs, baselineAbs);
    baselineCreated = true;
  } else if (config.mode === "update") {
    copyFileSync(currentAbs, baselineAbs);
  }
  writeFileSync(baselineMetaAbs, JSON.stringify(expectedMeta, null, 2), "utf8");

  const basePng = readPng(baselineAbs);
  const currPng = readPng(currentAbs);
  const diffResult = diffImages(basePng, currPng);
  const diffAbs = resolve(baseDir, diffRel);
  writeFileSync(diffAbs, PNG.sync.write(diffResult.diff));
  const execution = deriveVisualExecutionStatus({
    diffPixels: diffResult.diffPixels,
    maxDiffPixels: config.maxDiffPixels,
  });

  const result: VisualResult = {
    engine: "builtin-png-diff",
    engineUsed: "builtin",
    executionStatus: execution.executionStatus,
    blockedReasonCode: execution.blockedReasonCode,
    blockedDetail: execution.blockedDetail,
    url: config.baseUrl,
    mode: config.mode,
    baselineCreated,
    baselinePath: baselineAbs,
    currentPath: currentRel,
    diffPath: diffRel,
    diffPixels: diffResult.diffPixels,
    totalPixels: diffResult.totalPixels,
    diffRatio: Number((diffResult.diffPixels / Math.max(1, diffResult.totalPixels)).toFixed(6)),
    reportPath,
  };

  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}

export async function runVisual(baseDir: string, config: VisualConfig): Promise<VisualResult> {
  const engine = config.engine ?? "builtin";
  if (engine === "builtin") {
    return runBuiltinVisual(baseDir, config);
  }
  if (engine === "lostpixel") {
    const { runVisualWithLostPixelBridge } = await import(
      "../../../probes/visual-lostpixel/src/index.js"
    );
    return runVisualWithLostPixelBridge(baseDir, config, runBuiltinVisual);
  }
  const { runVisualWithBackstopBridge } = await import(
    "../../../probes/visual-backstop/src/index.js"
  );
  return runVisualWithBackstopBridge(baseDir, config, runBuiltinVisual);
}
