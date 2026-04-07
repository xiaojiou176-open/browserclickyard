import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { capturePageArtifacts } from "../../../probes/capture/src/index.js";
import { waitForPageSettled } from "./page-stability.js";

export type CapturedState = {
  id: string;
  source: "routes" | "discovery" | "stories" | "manual";
  url: string;
  steps: string[];
  artifacts: {
    screenshot: string;
    dom: string;
    trace: string;
    network: string;
    log: string;
  };
};

export type CaptureResult = {
  states: CapturedState[];
  summary: {
    consoleError: number;
    pageError: number;
    http5xx: number;
  };
  diagnostics: {
    consoleErrors: string[];
    pageErrors: string[];
    http5xxUrls: string[];
    replayMetadata?: {
      timezone: string;
      locale: string;
      seed: number;
      animationPolicy: "disabled";
      reducedMotion: "reduce";
    };
  };
};

export type CaptureStateInput = {
  id: string;
  path: string;
  source: CapturedState["source"];
  steps?: string[];
};

export type CaptureOptions = {
  states?: CaptureStateInput[];
  mockApis?: boolean;
};

const DEFAULT_STATES: CaptureStateInput[] = [
  {
    id: "home_default",
    path: "/",
    source: "routes",
    steps: ["goto:/", "wait:domcontentloaded"],
  },
];
const DETERMINISTIC_TIMEZONE = "UTC";
const DETERMINISTIC_LOCALE = "en-US";
const DETERMINISTIC_SEED = 20260218;

type CaptureMockResponse = {
  status: number;
  body: unknown;
};

export function resolveCaptureApiMock(pathname: string): CaptureMockResponse | null {
  if (pathname === "/health/diagnostics") {
    return {
      status: 200,
      body: {
        uptime_seconds: 3600,
        task_total: 0,
        task_counts: { running: 0, success: 0, failed: 0 },
      },
    };
  }
  if (pathname === "/health/alerts") {
    return {
      status: 200,
      body: { state: "ok", failure_rate: 0, threshold: 0.1, completed: 0, failed: 0 },
    };
  }
  if (pathname === "/api/automation/commands") {
    return {
      status: 200,
      body: {
        commands: [
          {
            command_id: "script-pipeline-capture",
            title: "仅 UI 流程（manual）",
            description: "CI capture API mock command",
            tags: ["safe"],
          },
        ],
      },
    };
  }
  if (pathname === "/api/automation/tasks") {
    return { status: 200, body: { tasks: [] } };
  }
  if (pathname === "/api/flows") {
    return { status: 200, body: { flows: [] } };
  }
  if (pathname === "/api/templates") {
    return { status: 200, body: { templates: [] } };
  }
  if (pathname === "/api/runs") {
    return { status: 200, body: { runs: [] } };
  }
  if (pathname === "/api/command-tower/latest-flow") {
    return {
      status: 200,
      body: {
        session_id: "capture-session",
        start_url: "http://example.local",
        generated_at: "2026-01-01T00:00:00.000Z",
        source_event_count: 0,
        step_count: 0,
        steps: [],
      },
    };
  }
  if (pathname === "/api/command-tower/latest-flow-draft") {
    return { status: 200, body: { session_id: "capture-session", flow: null } };
  }
  if (pathname === "/api/command-tower/evidence-timeline") {
    return { status: 200, body: { items: [] } };
  }
  if (pathname.startsWith("/api/") || pathname.startsWith("/health/")) {
    return { status: 404, body: { detail: `capture mock route not configured: ${pathname}` } };
  }
  return null;
}

async function installCaptureApiMocks(page: import("playwright").Page): Promise<void> {
  await page.route("**/*", async (route) => {
    let pathname = "";
    try {
      pathname = new URL(route.request().url()).pathname;
    } catch {
      await route.continue();
      return;
    }
    const mocked = resolveCaptureApiMock(pathname);
    if (!mocked) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: mocked.status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(mocked.body),
    });
  });
}

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

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
}

export async function runCapture(
  baseDir: string,
  baseUrl: string,
  options?: CaptureOptions,
): Promise<CaptureResult> {
  const stateInputs =
    options?.states && options.states.length > 0 ? options.states : DEFAULT_STATES;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const http5xxUrls = new Set<string>();
  let http5xx = 0;
  const states: CapturedState[] = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: resolve(baseDir, "network/capture.har") },
    timezoneId: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await enableDeterministicMode(page, DETERMINISTIC_SEED);
  if (options?.mockApis) {
    await installCaptureApiMocks(page);
  }

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      http5xx += 1;
      http5xxUrls.add(response.url());
    }
  });

  try {
    for (const stateInput of stateInputs) {
      const stateId = stateInput.id;
      const targetUrl = joinUrl(baseUrl, stateInput.path);
      const artifacts = {
        screenshot: `screenshots/${stateId}.png`,
        dom: `logs/dom-${stateId}.html`,
        trace: "traces/capture.zip",
        network: "network/capture.har",
        log: `logs/${stateId}.log`,
      };

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await stabilizeAnimations(page);
      await waitForPageSettled(page);
      await capturePageArtifacts(page, baseDir, stateId);

      writeFileSync(
        resolve(baseDir, artifacts.log),
        `${[
          "[capture] completed",
          `[state.id] ${stateId}`,
          `[state.source] ${stateInput.source}`,
          `[url] ${targetUrl}`,
          `[console.error] ${consoleErrors.length}`,
          `[pageerror] ${pageErrors.length}`,
          `[http5xx] ${http5xx}`,
        ].join("\n")}\n`,
        "utf8",
      );

      states.push({
        id: stateId,
        source: stateInput.source,
        url: targetUrl,
        steps: stateInput.steps ?? [`goto:${stateInput.path}`, "wait:domcontentloaded"],
        artifacts,
      });
    }
  } finally {
    await context.tracing.stop({ path: resolve(baseDir, "traces/capture.zip") });
    await context.close();
    await browser.close();
  }

  return {
    states,
    summary: {
      consoleError: consoleErrors.length,
      pageError: pageErrors.length,
      http5xx,
    },
    diagnostics: {
      consoleErrors,
      pageErrors,
      http5xxUrls: Array.from(http5xxUrls),
      replayMetadata: {
        timezone: DETERMINISTIC_TIMEZONE,
        locale: DETERMINISTIC_LOCALE,
        seed: DETERMINISTIC_SEED,
        animationPolicy: "disabled",
        reducedMotion: "reduce",
      },
    },
  };
}
