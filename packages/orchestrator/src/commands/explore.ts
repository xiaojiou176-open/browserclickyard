import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { type CapturedState, resolveCaptureApiMock } from "./capture.js";
import { buildDenyRegex } from "./safety-denylist.js";

export type ExploreResult = {
  discoveredStates: number;
  maxDepthReached: number;
  crashCount: number;
  consoleErrorCount: number;
  http5xxCount: number;
  dangerousActionHits: number;
  visitedStateKeys: number;
  pageErrors: string[];
  consoleErrors: string[];
  http5xxUrls: string[];
  states: CapturedState[];
  effectiveConfig: {
    budgetSeconds: number;
    maxDepth: number;
    maxStates: number;
    denylist: string[];
    denyStrategy: DangerActionPolicy;
    engine: "builtin" | "crawlee";
  };
  diagnostics: {
    replayMetadata: {
      seed: number;
      timezone: string;
      locale: string;
      animationPolicy: "disabled";
      reducedMotion: "reduce";
      replayPath: string;
    };
    flakyRiskMitigations: string[];
    adapter?: string;
  };
  executionStatus: "ok" | "blocked";
  engineUsed: "builtin" | "crawlee";
  blockedReasonCode?: string;
  blockedDetail?: string;
  reportPath: string;
};

const EXPLORE_REASON_NO_STATES_DISCOVERED = "gate.explore_engine.blocked.no_states_discovered";

export type DangerActionPolicy = {
  lexical: string[];
  roles: string[];
  selectors: string[];
  urlPatterns: string[];
};

export type ExploreOptions = {
  baseUrl: string;
  budgetSeconds: number;
  maxDepth: number;
  maxStates: number;
  denylist: string[];
  denyStrategy: DangerActionPolicy;
  seed?: number;
  engine?: "builtin" | "crawlee";
};

type ExploreQueueItem = {
  url: string;
  depth: number;
  via: string;
};
type ExploreReplayItem = {
  seq: number;
  depth: number;
  via: string;
  url: string;
  stateKey: string;
};

const CLICKABLE_SELECTOR =
  'a[href],button,[role="button"],input[type="button"],input[type="submit"]';
const DETERMINISTIC_TIMEZONE = "UTC";
const DETERMINISTIC_LOCALE = "en-US";
const DEFAULT_EXPLORE_SEED = 20260218;

export type ExploreBaseScope = {
  normalizedBaseUrl: string;
  origin: string;
  pathPrefix: string;
};

function normalizePathname(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed === "/") {
    return "/";
  }
  return collapsed.replace(/\/+$/g, "") || "/";
}

export function normalizeNavigableUrl(input: string): string {
  const parsed = new URL(input);
  const normalizedPathname = normalizePathname(parsed.pathname);
  return `${parsed.origin}${normalizedPathname}${parsed.search}`;
}

export function normalizeExploreBase(baseUrl: string): ExploreBaseScope {
  const normalizedBaseUrl = normalizeNavigableUrl(baseUrl);
  const parsed = new URL(normalizedBaseUrl);
  const pathPrefix = parsed.pathname === "/" ? "" : parsed.pathname;
  return {
    normalizedBaseUrl,
    origin: parsed.origin,
    pathPrefix,
  };
}

export function isPathInScope(pathname: string, pathPrefix: string): boolean {
  if (!pathPrefix) {
    return true;
  }
  const normalizedPathname = normalizePathname(pathname);
  const normalizedPrefix = normalizePathname(pathPrefix);
  return (
    normalizedPathname === normalizedPrefix || normalizedPathname.startsWith(`${normalizedPrefix}/`)
  );
}

export function deriveExploreExecutionStatus(input: {
  discoveredStates: number;
}): Pick<ExploreResult, "executionStatus" | "blockedReasonCode" | "blockedDetail"> {
  if (input.discoveredStates <= 0) {
    return {
      executionStatus: "blocked",
      blockedReasonCode: EXPLORE_REASON_NO_STATES_DISCOVERED,
      blockedDetail: "no states discovered during explore step",
    };
  }
  return {
    executionStatus: "ok",
    blockedReasonCode: undefined,
    blockedDetail: undefined,
  };
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

function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function stateHash(pathWithQuery: string, labels: string[], modalOpen: boolean): string {
  const payload = `${pathWithQuery}::${labels.join("|")}::modal:${modalOpen ? "1" : "0"}`;
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

async function runBuiltinExplore(baseDir: string, options: ExploreOptions): Promise<ExploreResult> {
  const started = Date.now();
  const deadline = started + options.budgetSeconds * 1000;
  const denyRegex = buildDenyRegex(options.denylist);
  const normalizedBase = normalizeExploreBase(options.baseUrl);
  const seedPath = normalizedBase.pathPrefix.length > 0 ? `${normalizedBase.pathPrefix}/` : "/";
  const seedUrl = normalizeNavigableUrl(`${normalizedBase.origin}${seedPath}`);

  const seed = options.seed ?? DEFAULT_EXPLORE_SEED;
  const queue: ExploreQueueItem[] = [{ url: seedUrl, depth: 0, via: "seed" }];
  const seenStateKeys = new Set<string>();
  const enqueuedUrls = new Set<string>([seedUrl]);
  const logs: string[] = [];
  const states: CapturedState[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const http5xxUrls = new Set<string>();
  const replay: ExploreReplayItem[] = [];

  let discoveredStates = 0;
  let maxDepthReached = 0;
  let crashCount = 0;
  let consoleErrorCount = 0;
  let http5xxCount = 0;
  let dangerousActionHits = 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordHar: { path: resolve(baseDir, "network/explore.har") },
    timezoneId: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await enableDeterministicMode(page, seed);
  if (shouldMockApis(options.baseUrl)) {
    await installApiMocks(page);
  }

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrorCount += 1;
      consoleErrors.push(msg.text());
      logs.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    crashCount += 1;
    pageErrors.push(err.message);
    logs.push(`[pageerror] ${err.message}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      http5xxCount += 1;
      http5xxUrls.add(response.url());
      logs.push(`[http5xx] ${response.status()} ${response.url()}`);
    }
  });

  try {
    while (queue.length > 0 && Date.now() < deadline && discoveredStates < options.maxStates) {
      const current = queue.shift() as ExploreQueueItem;
      maxDepthReached = Math.max(maxDepthReached, current.depth);

      try {
        await page.goto(current.url, { waitUntil: "domcontentloaded", timeout: 12000 });
        await stabilizeAnimations(page);
      } catch (error) {
        logs.push(`[goto.error] ${current.url} ${(error as Error).message}`);
        continue;
      }

      const pageMeta = await page.evaluate((clickableSelector) => {
        const labels = Array.from(document.querySelectorAll<HTMLElement>(clickableSelector))
          .slice(0, 20)
          .map((el) =>
            (
              el.innerText ||
              el.getAttribute("aria-label") ||
              el.getAttribute("value") ||
              ""
            ).trim(),
          )
          .filter(Boolean);
        const modalOpen =
          document.querySelector("dialog[open]") !== null ||
          document.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
        return {
          labels,
          modalOpen,
          title: document.title,
        };
      }, CLICKABLE_SELECTOR);

      const urlObj = new URL(page.url());
      const key = stateHash(
        `${urlObj.pathname}${urlObj.search}`,
        pageMeta.labels.map(normalizeText).sort((a, b) => a.localeCompare(b)),
        pageMeta.modalOpen,
      );
      if (seenStateKeys.has(key)) {
        logs.push(`[dedupe] skip state ${key} ${page.url()}`);
        continue;
      }

      seenStateKeys.add(key);
      discoveredStates += 1;
      const stateId = `explore_${String(discoveredStates).padStart(3, "0")}`;
      const screenshotPath = `screenshots/${stateId}.png`;
      const domPath = `logs/dom-${stateId}.html`;
      const logPath = `logs/${stateId}.log`;
      await page.screenshot({ path: resolve(baseDir, screenshotPath), fullPage: true });
      writeFileSync(resolve(baseDir, domPath), await page.content(), "utf8");
      writeFileSync(
        resolve(baseDir, logPath),
        `${[`[state] ${stateId}`, `[url] ${page.url()}`, `[title] ${pageMeta.title}`, `[via] ${current.via}`].join("\n")}\n`,
        "utf8",
      );
      states.push({
        id: stateId,
        source: "discovery",
        url: page.url(),
        steps: [
          `goto:${new URL(page.url()).pathname}${new URL(page.url()).search}`,
          `via:${current.via}`,
        ],
        artifacts: {
          screenshot: screenshotPath,
          dom: domPath,
          trace: "traces/explore.zip",
          network: "network/explore.har",
          log: logPath,
        },
      });
      replay.push({
        seq: discoveredStates,
        depth: current.depth,
        via: current.via,
        url: page.url(),
        stateKey: key,
      });

      const candidates = await page.evaluate((clickableSelector) => {
        return Array.from(document.querySelectorAll<HTMLElement>(clickableSelector))
          .slice(0, 12)
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
            const selector = id ? `#${id}` : `${tag}${name ? `[name="${name}"]` : ""}`;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return {
              index,
              text,
              href,
              ariaLabel,
              title,
              role,
              tag,
              selector,
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
      const filteredCandidates = candidates.filter(
        (candidate) => candidate.visible && candidate.inViewport && !candidate.disabled,
      );
      filteredCandidates.sort((a, b) => {
        const left = `${a.text} ${a.ariaLabel} ${a.title} ${a.href} #${a.index}`.toLowerCase();
        const right = `${b.text} ${b.ariaLabel} ${b.title} ${b.href} #${b.index}`.toLowerCase();
        return left.localeCompare(right);
      });

      for (const candidate of filteredCandidates) {
        if (current.depth + 1 > options.maxDepth) {
          break;
        }

        const candidateLabel = normalizeText(
          `${candidate.text} ${candidate.ariaLabel} ${candidate.title} ${candidate.href}`,
        );
        const selectorBlocked = options.denyStrategy.selectors.some(
          (rule) =>
            rule.trim().length > 0 && candidate.selector.toLowerCase().includes(rule.toLowerCase()),
        );
        const roleBlocked = options.denyStrategy.roles.some(
          (rule) =>
            rule.trim().length > 0 &&
            (candidate.role === rule.toLowerCase() || candidate.tag === rule.toLowerCase()),
        );
        const urlBlocked = options.denyStrategy.urlPatterns.some(
          (rule) =>
            rule.trim().length > 0 && candidate.href.toLowerCase().includes(rule.toLowerCase()),
        );
        if (denyRegex.test(candidateLabel) || selectorBlocked || roleBlocked || urlBlocked) {
          dangerousActionHits += 1;
          logs.push(
            `[danger.block] ${candidateLabel || "<empty>"} selector=${candidate.selector} role=${candidate.role || candidate.tag}`,
          );
          continue;
        }

        let nextUrl = "";
        if (candidate.href) {
          try {
            const parsed = new URL(candidate.href, page.url());
            if (
              parsed.origin === normalizedBase.origin &&
              isPathInScope(parsed.pathname, normalizedBase.pathPrefix)
            ) {
              nextUrl = normalizeNavigableUrl(`${parsed.origin}${parsed.pathname}${parsed.search}`);
            }
          } catch {
            logs.push(`[href.invalid] ${candidate.href}`);
          }
        } else {
          try {
            const before = page.url();
            await page.locator(CLICKABLE_SELECTOR).nth(candidate.index).click({ timeout: 1000 });
            await page
              .waitForLoadState("domcontentloaded", { timeout: 2000 })
              .catch(() => undefined);
            const after = page.url();
            if (after !== before) {
              nextUrl = normalizeNavigableUrl(after);
            }
            await page
              .goto(current.url, { waitUntil: "domcontentloaded", timeout: 6000 })
              .catch(() => undefined);
          } catch {
            logs.push(`[click.skip] index=${candidate.index}`);
          }
        }

        if (!nextUrl) {
          continue;
        }
        let nextParsed: URL;
        try {
          nextParsed = new URL(nextUrl);
        } catch {
          continue;
        }
        if (
          nextParsed.origin !== normalizedBase.origin ||
          !isPathInScope(nextParsed.pathname, normalizedBase.pathPrefix)
        ) {
          continue;
        }
        if (enqueuedUrls.has(nextUrl)) {
          continue;
        }

        enqueuedUrls.add(nextUrl);
        queue.push({
          url: nextUrl,
          depth: current.depth + 1,
          via: candidateLabel || "click",
        });
      }
    }
  } finally {
    await context.tracing.stop({ path: resolve(baseDir, "traces/explore.zip") });
    await context.close();
    await browser.close();
  }

  const execution = deriveExploreExecutionStatus({ discoveredStates });
  const result: ExploreResult = {
    discoveredStates,
    maxDepthReached,
    crashCount,
    consoleErrorCount,
    http5xxCount,
    dangerousActionHits,
    visitedStateKeys: seenStateKeys.size,
    pageErrors,
    consoleErrors,
    http5xxUrls: Array.from(http5xxUrls),
    states,
    effectiveConfig: {
      budgetSeconds: options.budgetSeconds,
      maxDepth: options.maxDepth,
      maxStates: options.maxStates,
      denylist: options.denylist,
      denyStrategy: options.denyStrategy,
      engine: "builtin",
    },
    diagnostics: {
      replayMetadata: {
        seed,
        timezone: DETERMINISTIC_TIMEZONE,
        locale: DETERMINISTIC_LOCALE,
        animationPolicy: "disabled",
        reducedMotion: "reduce",
        replayPath: "logs/explore-replay.json",
      },
      flakyRiskMitigations: [
        "sorted_state_labels_for_hash",
        "sorted_candidate_enqueuing",
        "fixed_timezone_locale_reduced_motion",
        "disabled_css_animation_transition",
      ],
    },
    executionStatus: execution.executionStatus,
    engineUsed: "builtin",
    blockedReasonCode: execution.blockedReasonCode,
    blockedDetail: execution.blockedDetail,
    reportPath: "reports/explore.json",
  };

  writeFileSync(resolve(baseDir, "logs/explore.log"), `${logs.join("\n")}\n`, "utf8");
  writeFileSync(
    resolve(baseDir, "logs/explore-replay.json"),
    JSON.stringify(
      {
        baseUrl: options.baseUrl,
        seed,
        timezone: DETERMINISTIC_TIMEZONE,
        locale: DETERMINISTIC_LOCALE,
        reducedMotion: "reduce",
        animationPolicy: "disabled",
        timeline: replay,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(resolve(baseDir, result.reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}

export async function runExplore(baseDir: string, options: ExploreOptions): Promise<ExploreResult> {
  const engine = options.engine ?? "builtin";
  if (engine === "builtin") {
    return runBuiltinExplore(baseDir, options);
  }
  const { runExploreWithCrawleeBridge } = await import(
    "../../../probes/explore-crawlee/src/index.js"
  );
  return runExploreWithCrawleeBridge(baseDir, options, runBuiltinExplore);
}
