import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { waitForPageSettled } from "./page-stability.js";

export type PerfConfig = {
  baseUrl: string;
  preset: "mobile" | "desktop";
  engine?: "lhci" | "builtin";
};

export type PerfResult = {
  engine: "lhci" | "builtin-browser-perf";
  metricsCompleteness: "full_lhci" | "builtin_partial";
  preset: PerfConfig["preset"];
  url: string;
  measuredAt: string;
  metrics: {
    ttfbMs: number;
    domContentLoadedMs: number;
    loadEventMs: number;
    firstPaintMs: number;
    firstContentfulPaintMs: number;
    largestContentfulPaintMs: number;
    jsHeapUsedMb: number;
  };
  reportPath: string;
  fallbackUsed?: boolean;
  deterministic?: {
    timezone: string;
    locale: string;
    seed: number;
    animationPolicy: "disabled";
    reducedMotion: "reduce";
  };
};

type PerfMetricsRaw = {
  ttfbMs: number;
  domContentLoadedMs: number;
  loadEventMs: number;
  firstPaintMs: number;
  firstContentfulPaintMs: number;
  largestContentfulPaintMs: number;
  jsHeapUsedMb: number;
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
      window.localStorage.setItem("ab_onboarding_done", "1");
    },
    { seeded: seed },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function stabilizeAnimations(page: import("playwright").Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important;}html{scroll-behavior:auto !important;}`,
  });
}

async function runBuiltinPerf(config: PerfConfig): Promise<PerfMetricsRaw> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    config.preset === "mobile"
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          timezoneId: DETERMINISTIC_TIMEZONE,
          locale: DETERMINISTIC_LOCALE,
          reducedMotion: "reduce",
          colorScheme: "light",
        }
      : {
          viewport: { width: 1366, height: 768 },
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          timezoneId: DETERMINISTIC_TIMEZONE,
          locale: DETERMINISTIC_LOCALE,
          reducedMotion: "reduce",
          colorScheme: "light",
        },
  );

  const page = await context.newPage();
  await enableDeterministicMode(page, DETERMINISTIC_SEED);

  try {
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await stabilizeAnimations(page);
    await waitForPageSettled(page);

    return (await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const paints = performance.getEntriesByType("paint");
      const fp = paints.find((p) => p.name === "first-paint")?.startTime ?? 0;
      const fcp = paints.find((p) => p.name === "first-contentful-paint")?.startTime ?? 0;

      const lcpEntries = performance.getEntriesByType(
        "largest-contentful-paint",
      ) as PerformanceEntry[];
      const lcp = lcpEntries.length > 0 ? (lcpEntries[lcpEntries.length - 1]?.startTime ?? 0) : 0;

      const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      const usedMb = mem?.usedJSHeapSize
        ? Number((mem.usedJSHeapSize / (1024 * 1024)).toFixed(2))
        : 0;

      return {
        ttfbMs: nav ? Number((nav.responseStart - nav.requestStart).toFixed(2)) : 0,
        domContentLoadedMs: nav ? Number(nav.domContentLoadedEventEnd.toFixed(2)) : 0,
        loadEventMs: nav ? Number(nav.loadEventEnd.toFixed(2)) : 0,
        firstPaintMs: Number(fp.toFixed(2)),
        firstContentfulPaintMs: Number(fcp.toFixed(2)),
        largestContentfulPaintMs: Number(lcp.toFixed(2)),
        jsHeapUsedMb: usedMb,
      };
    })) as PerfMetricsRaw;
  } finally {
    await context.close();
    await browser.close();
  }
}

function runLhci(baseDir: string, config: PerfConfig): PerfMetricsRaw | null {
  const outputDir = resolve(baseDir, "perf/lhci");
  mkdirSync(outputDir, { recursive: true });
  const preset = config.preset === "mobile" ? "mobile" : "desktop";
  const command = spawnSync(
    "pnpm",
    [
      "exec",
      "lhci",
      "collect",
      "--url",
      config.baseUrl,
      "--numberOfRuns",
      "1",
      "--settings.preset",
      preset,
      "--outputDir",
      outputDir,
    ],
    {
      encoding: "utf8",
      timeout: 120000,
    },
  );

  if (command.status !== 0) {
    return null;
  }

  if (!existsSync(outputDir)) {
    return null;
  }

  const reportJson = readdirSync(outputDir).find(
    (file) => file.endsWith(".report.json") || file.endsWith(".json"),
  );
  if (!reportJson) {
    return null;
  }

  const reportPath = resolve(outputDir, reportJson);
  let report:
    | {
        audits?: {
          [key: string]: {
            numericValue?: number;
          };
        };
      }
    | undefined;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      audits?: {
        [key: string]: {
          numericValue?: number;
        };
      };
    };
  } catch {
    return null;
  }

  if (!report?.audits) {
    return null;
  }

  const lcpMs = report.audits?.["largest-contentful-paint"]?.numericValue ?? 0;
  const fcpMs = report.audits?.["first-contentful-paint"]?.numericValue ?? 0;
  const ttfbMs = report.audits?.["server-response-time"]?.numericValue ?? 0;

  return {
    ttfbMs: Number(ttfbMs.toFixed(2)),
    domContentLoadedMs: 0,
    loadEventMs: 0,
    firstPaintMs: Number(fcpMs.toFixed(2)),
    firstContentfulPaintMs: Number(fcpMs.toFixed(2)),
    largestContentfulPaintMs: Number(lcpMs.toFixed(2)),
    jsHeapUsedMb: 0,
  };
}

export async function runPerf(baseDir: string, config: PerfConfig): Promise<PerfResult> {
  const preferLhci = (config.engine ?? "lhci") === "lhci";
  let metrics: PerfMetricsRaw | null = null;
  let engine: PerfResult["engine"] = "builtin-browser-perf";
  let fallbackUsed = false;

  if (preferLhci) {
    metrics = runLhci(baseDir, config);
    if (metrics) {
      engine = "lhci";
    } else {
      fallbackUsed = true;
    }
  }

  if (!metrics) {
    metrics = await runBuiltinPerf(config);
    engine = "builtin-browser-perf";
  }

  const result: PerfResult = {
    engine,
    metricsCompleteness: engine === "lhci" ? "full_lhci" : "builtin_partial",
    preset: config.preset,
    url: config.baseUrl,
    measuredAt: new Date().toISOString(),
    metrics,
    reportPath: "perf/lighthouse.json",
    fallbackUsed,
    deterministic: {
      timezone: DETERMINISTIC_TIMEZONE,
      locale: DETERMINISTIC_LOCALE,
      seed: DETERMINISTIC_SEED,
      animationPolicy: "disabled",
      reducedMotion: "reduce",
    },
  };

  writeFileSync(resolve(baseDir, result.reportPath), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(
    resolve(baseDir, "perf/lighthouse.html"),
    `<pre>${JSON.stringify(result, null, 2)}</pre>\n`,
    "utf8",
  );
  return result;
}
