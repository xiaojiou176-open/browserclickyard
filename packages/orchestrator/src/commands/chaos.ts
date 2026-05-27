import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { resolveCaptureApiMock } from "./capture.js";
import type { DangerActionPolicy } from "./explore.js";
import { buildDenyRegex } from "./safety-denylist.js";

export type ChaosEventRatio = {
  click: number;
  input: number;
  scroll: number;
  keyboard: number;
};

export type ChaosConfig = {
  baseUrl: string;
  seed: number;
  budgetSeconds: number;
  eventRatio: ChaosEventRatio;
  denylist: string[];
  denyStrategy: DangerActionPolicy;
};

export type ChaosResult = {
  baseUrl: string;
  seed: number;
  budgetSeconds: number;
  eventsExecuted: number;
  pageErrorCount: number;
  consoleErrorCount: number;
  http5xxCount: number;
  dangerousActionHits: number;
  eventsByType: ChaosEventRatio;
  pageErrors: string[];
  consoleErrors: string[];
  http5xxUrls: string[];
  effectiveConfig: ChaosConfig;
  diagnostics: {
    replayMetadata: {
      seed: number;
      timezone: string;
      locale: string;
      animationPolicy: "disabled";
      reducedMotion: "reduce";
      replayPath: string;
      finalRngState: number;
    };
    flakyRiskMitigations: string[];
  };
  reportPath: string;
};

type ChaosEventType = keyof ChaosEventRatio;
type ReplayItem = {
  seq: number;
  atOffsetMs: number;
  type: ChaosEventType;
  target: string;
  status: "ok" | "skip" | "error";
  detail?: string;
};

const CLICKABLE_SELECTOR =
  'a[href],button,[role="button"],input[type="button"],input[type="submit"]';
const INPUT_SELECTOR = 'input:not([type="hidden"]):not([disabled]),textarea:not([disabled])';
const KEYBOARD_POOL = ["Tab", "ArrowDown", "ArrowUp", "Escape"];
const TEXT_LIKE_INPUT_TYPES = ["text", "email", "password", "search", "tel", "url"];
const DETERMINISTIC_TIMEZONE = "UTC";
const DETERMINISTIC_LOCALE = "en-US";

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

function shouldMockApis(baseUrl: string): boolean {
  return (
    baseUrl.includes("127.0.0.1:4173") ||
    baseUrl.includes("127.0.0.1:43173") ||
    process.env.UIQ_CAPTURE_API_MOCK === "1"
  );
}

async function installApiMocks(page: import("playwright").Page): Promise<void> {
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

async function settleAfterEvent(page: import("playwright").Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => undefined);
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    )
    .catch(() => undefined);
}

function normalizeRatios(input: ChaosEventRatio): ChaosEventRatio {
  const raw = {
    click: Math.max(0, input.click),
    input: Math.max(0, input.input),
    scroll: Math.max(0, input.scroll),
    keyboard: Math.max(0, input.keyboard),
  };
  const sum = raw.click + raw.input + raw.scroll + raw.keyboard;
  if (sum === 0) {
    return { click: 60, input: 20, scroll: 10, keyboard: 10 };
  }
  return {
    click: Number(((raw.click / sum) * 100).toFixed(2)),
    input: Number(((raw.input / sum) * 100).toFixed(2)),
    scroll: Number(((raw.scroll / sum) * 100).toFixed(2)),
    keyboard: Number(((raw.keyboard / sum) * 100).toFixed(2)),
  };
}

function weightedCount(total: number, ratioPercent: number): number {
  return Math.round((total * ratioPercent) / 100);
}

function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function createSeededRandom(seed: number): { next: () => number; getState: () => number } {
  let state = seed >>> 0 || 1;
  return {
    next: () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    },
    getState: () => state,
  };
}

function pickWeightedEvent(random: number, ratio: ChaosEventRatio): ChaosEventType {
  if (random < ratio.click / 100) {
    return "click";
  }
  if (random < (ratio.click + ratio.input) / 100) {
    return "input";
  }
  if (random < (ratio.click + ratio.input + ratio.scroll) / 100) {
    return "scroll";
  }
  return "keyboard";
}

async function pickClickable(
  page: import("playwright").Page,
  denyRegex: RegExp,
  denyStrategy: DangerActionPolicy,
  random: () => number,
): Promise<{ candidate: { index: number; label: string } | null; dangerousHits: number }> {
  const candidates = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .slice(0, 50)
      .map((el, index) => {
        const text = (
          el.innerText ||
          el.getAttribute("aria-label") ||
          el.getAttribute("value") ||
          ""
        ).trim();
        const href = el instanceof HTMLAnchorElement ? el.href : "";
        const ariaLabel = (el.getAttribute("aria-label") || "").trim();
        const title = (el.getAttribute("title") || "").trim();
        const role = (el.getAttribute("role") || "").trim().toLowerCase();
        const tag = el.tagName.toLowerCase();
        const id = (el.getAttribute("id") || "").trim();
        const name = (el.getAttribute("name") || "").trim();
        const selectorValue = id ? `#${id}` : `${tag}${name ? `[name="${name}"]` : ""}`;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          index,
          label: `${text} ${ariaLabel} ${title} ${href}`.trim(),
          href,
          role,
          tag,
          selector: selectorValue,
          disabled:
            el.hasAttribute("disabled") ||
            el.getAttribute("aria-disabled") === "true" ||
            (el as HTMLButtonElement).disabled === true,
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0,
          inViewport:
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth,
        };
      });
  }, CLICKABLE_SELECTOR);
  let dangerousHits = 0;
  const allowed = candidates.filter((item) => {
    if (item.disabled || !item.visible || !item.inViewport) {
      return false;
    }
    const lexicalBlocked = denyRegex.test(normalizeText(item.label));
    const selectorBlocked = denyStrategy.selectors.some(
      (rule) => rule.trim().length > 0 && item.selector.toLowerCase().includes(rule.toLowerCase()),
    );
    const roleBlocked = denyStrategy.roles.some(
      (rule) =>
        rule.trim().length > 0 &&
        (item.role === rule.toLowerCase() || item.tag === rule.toLowerCase()),
    );
    const urlBlocked = denyStrategy.urlPatterns.some(
      (rule) => rule.trim().length > 0 && item.href.toLowerCase().includes(rule.toLowerCase()),
    );
    if (lexicalBlocked || selectorBlocked || roleBlocked || urlBlocked) {
      dangerousHits += 1;
      return false;
    }
    return true;
  });
  if (allowed.length === 0) {
    return { candidate: null, dangerousHits };
  }
  return {
    candidate: allowed[Math.floor(random() * allowed.length)] ?? null,
    dangerousHits,
  };
}

async function pickInput(
  page: import("playwright").Page,
  random: () => number,
): Promise<{ index: number; label: string } | null> {
  const candidates = await page.evaluate(
    ({ selector, textLikeInputTypes }: { selector: string; textLikeInputTypes: string[] }) => {
      return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector))
        .slice(0, 30)
        .map((el, index) => {
          const name = el.getAttribute("name") || "";
          const id = el.getAttribute("id") || "";
          const placeholder = el.getAttribute("placeholder") || "";
          const ariaLabel = el.getAttribute("aria-label") || "";
          const type =
            el instanceof HTMLTextAreaElement ? "textarea" : (el.type || "text").toLowerCase();
          const textLike = type === "textarea" || textLikeInputTypes.includes(type);
          const structuralField = /step-\d+-id|selector-index/i.test(ariaLabel);
          return {
            index,
            label: `${type}:${name || id || placeholder || ariaLabel}`.trim(),
            readOnly: "readOnly" in el ? el.readOnly : false,
            textLike,
            structuralField,
          };
        });
    },
    { selector: INPUT_SELECTOR, textLikeInputTypes: TEXT_LIKE_INPUT_TYPES },
  );
  const editable = candidates.filter(
    (item) => !item.readOnly && item.textLike && !item.structuralField,
  );
  if (editable.length === 0) {
    return null;
  }
  return editable[Math.floor(random() * editable.length)] ?? null;
}

export async function runChaos(baseDir: string, config: ChaosConfig): Promise<ChaosResult> {
  const normalized = normalizeRatios(config.eventRatio);
  const totalEvents = Math.max(10, Math.floor(config.budgetSeconds * 3));
  const targetEventsByType: ChaosEventRatio = {
    click: weightedCount(totalEvents, normalized.click),
    input: weightedCount(totalEvents, normalized.input),
    scroll: weightedCount(totalEvents, normalized.scroll),
    keyboard: weightedCount(totalEvents, normalized.keyboard),
  };
  const random = createSeededRandom(config.seed);
  const denyRegex = buildDenyRegex(config.denylist);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const http5xxUrls = new Set<string>();
  const logs: string[] = [];
  const replay: ReplayItem[] = [];
  let dangerousActionHits = 0;
  const eventsByType: ChaosEventRatio = {
    click: 0,
    input: 0,
    scroll: 0,
    keyboard: 0,
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: resolve(baseDir, "network/chaos.har") },
    timezoneId: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await enableDeterministicMode(page, config.seed);
  if (shouldMockApis(config.baseUrl)) {
    await installApiMocks(page);
  }

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
      logs.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    logs.push(`[pageerror] ${err.message}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      http5xxUrls.add(response.url());
      logs.push(`[http5xx] ${response.status()} ${response.url()}`);
    }
  });

  let eventsExecuted = 0;
  try {
    await page.goto(`${config.baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await stabilizeAnimations(page);
    for (let seq = 1; seq <= totalEvents; seq += 1) {
      const eventType = pickWeightedEvent(random.next(), normalized);
      const replayItem: ReplayItem = {
        seq,
        atOffsetMs: seq * 80,
        type: eventType,
        target: "",
        status: "skip",
      };

      try {
        if (eventType === "click") {
          const pickResult = await pickClickable(page, denyRegex, config.denyStrategy, random.next);
          dangerousActionHits += pickResult.dangerousHits;
          const candidate = pickResult.candidate;
          if (!candidate) {
            replayItem.target = "clickable:none";
            replayItem.detail = "no_clickable_candidate";
          } else {
            replayItem.target = `clickable#${candidate.index}:${candidate.label || "<empty>"}`;
            await page.locator(CLICKABLE_SELECTOR).nth(candidate.index).click({ timeout: 1000 });
            replayItem.status = "ok";
            eventsByType.click += 1;
            eventsExecuted += 1;
          }
        } else if (eventType === "input") {
          const input = await pickInput(page, random.next);
          if (!input) {
            replayItem.target = "input:none";
            replayItem.detail = "no_input_candidate";
          } else {
            const value = `chaos-${seq}-${Math.floor(random.next() * 10000)}`;
            replayItem.target = `input#${input.index}:${input.label || "<empty>"}`;
            await page.locator(INPUT_SELECTOR).nth(input.index).fill(value, { timeout: 1000 });
            replayItem.status = "ok";
            replayItem.detail = value;
            eventsByType.input += 1;
            eventsExecuted += 1;
          }
        } else if (eventType === "scroll") {
          const deltaY = random.next() < 0.5 ? -400 : 400;
          replayItem.target = `window:${deltaY}`;
          await page.mouse.wheel(0, deltaY);
          replayItem.status = "ok";
          eventsByType.scroll += 1;
          eventsExecuted += 1;
        } else {
          const key = KEYBOARD_POOL[Math.floor(random.next() * KEYBOARD_POOL.length)] ?? "Tab";
          replayItem.target = `keyboard:${key}`;
          await page.keyboard.press(key);
          replayItem.status = "ok";
          eventsByType.keyboard += 1;
          eventsExecuted += 1;
        }
      } catch (error) {
        replayItem.status = "error";
        replayItem.detail = (error as Error).message;
        logs.push(`[event.error] seq=${seq} type=${eventType} ${(error as Error).message}`);
      }

      replay.push(replayItem);
      await settleAfterEvent(page);
    }
  } finally {
    await context.tracing.stop({ path: resolve(baseDir, "traces/chaos.zip") });
    await context.close();
    await browser.close();
  }

  const result: ChaosResult = {
    baseUrl: config.baseUrl,
    seed: config.seed,
    budgetSeconds: config.budgetSeconds,
    eventsExecuted,
    pageErrorCount: pageErrors.length,
    consoleErrorCount: consoleErrors.length,
    http5xxCount: http5xxUrls.size,
    dangerousActionHits,
    eventsByType,
    pageErrors,
    consoleErrors,
    http5xxUrls: Array.from(http5xxUrls),
    effectiveConfig: {
      baseUrl: config.baseUrl,
      seed: config.seed,
      budgetSeconds: config.budgetSeconds,
      eventRatio: normalized,
      denylist: config.denylist,
      denyStrategy: config.denyStrategy,
    },
    diagnostics: {
      replayMetadata: {
        seed: config.seed,
        timezone: DETERMINISTIC_TIMEZONE,
        locale: DETERMINISTIC_LOCALE,
        animationPolicy: "disabled",
        reducedMotion: "reduce",
        replayPath: "logs/chaos-replay.json",
        finalRngState: random.getState(),
      },
      flakyRiskMitigations: [
        "fixed_timezone_locale_reduced_motion",
        "disabled_css_animation_transition",
        "deterministic_rng_with_exported_final_state",
        "event_settle_wait_for_dom_and_raf",
      ],
    },
    reportPath: "reports/chaos.json",
  };

  writeFileSync(resolve(baseDir, result.reportPath), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(resolve(baseDir, "logs/chaos.log"), `${logs.join("\n")}\n`, "utf8");
  writeFileSync(
    resolve(baseDir, "logs/chaos-replay.json"),
    JSON.stringify(
      {
        baseUrl: config.baseUrl,
        seed: config.seed,
        timezone: DETERMINISTIC_TIMEZONE,
        locale: DETERMINISTIC_LOCALE,
        reducedMotion: "reduce",
        animationPolicy: "disabled",
        finalRngState: random.getState(),
        budgetSeconds: config.budgetSeconds,
        eventRatio: normalized,
        targetEventsByType,
        eventsByType,
        eventsExecuted,
        timeline: replay,
      },
      null,
      2,
    ),
    "utf8",
  );
  return result;
}
