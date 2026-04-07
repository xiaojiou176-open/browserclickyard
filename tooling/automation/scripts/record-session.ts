import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { AUTOMATION_ENV } from "./lib/env.js";

type RecordMode = "manual" | "midscene";

type MidsceneTakeoverContext = {
  page: Page;
  startUrl: string;
  suggestedEmail: string;
  suggestedPassword: string;
  successSelector: string;
};

type MidsceneDriverModule = {
  runMidsceneTakeover: (context: MidsceneTakeoverContext) => Promise<void>;
};

type SessionMeta = {
  sessionId: string;
  mode: RecordMode;
  baseUrl: string;
  startUrl: string;
  suggestedEmail: string;
  outputDir: string;
  harPath: string | null;
  tracePath: string | null;
  htmlPath: string | null;
  eventLogPath: string;
  flowDraftPath: string;
  storageStatePath: string | null;
  videoDir: string | null;
  midsceneDriverPath: string | null;
  capturePolicy: {
    allowSensitiveCapture: boolean;
    allowSensitiveTrace: boolean;
    allowSensitiveStorage: boolean;
    allowSensitiveInputValues: boolean;
    captureHar: boolean;
    captureVideo: boolean;
    captureHtml: boolean;
  };
  createdAt: string;
};

type CapturedEvent = {
  ts: string;
  type: "navigate" | "click" | "type" | "change" | "submit" | "keydown";
  url: string;
  target: {
    tag: string;
    id: string | null;
    name: string | null;
    type: string | null;
    role: string | null;
    text: string | null;
    classes: string[];
    cssPath: string;
  };
  value?: string;
  key?: string;
};

type FlowStep = {
  step_id: string;
  action: "navigate" | "click" | "type";
  url?: string;
  value_ref?: string;
  gate_policy?: "auto" | "force_manual" | "forbid_manual";
  gate_reason?: string;
  target?: {
    selectors: Array<{
      kind: "role" | "css" | "id" | "name";
      value: string;
      score: number;
    }>;
  };
};

type SelectorCandidate = NonNullable<FlowStep["target"]>["selectors"][number];

type FlowDraft = {
  flow_id: string;
  session_id: string;
  start_url: string;
  generated_at: string;
  source_event_count: number;
  steps: FlowStep[];
};

type ProtectedProviderConfig = {
  protectedProviderDomains: string[];
  protectedProviderGatePolicy: "auto" | "force_manual" | "forbid_manual";
};

const DEFAULT_PROTECTED_PROVIDER_DOMAINS = ["stripe.com", "js.stripe.com"];
const DEFAULT_PROTECTED_PROVIDER_GATE_POLICY = "force_manual";
const PROVIDER_PROTECTED_PAYMENT_REASON = "provider_protected_payment_step";
const SESSION_DIR_PREFIX = "session-";
const LEGACY_SESSION_DIR_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}(?:-\d{3})?z?$/i;

function resolveRepoRoot(): string {
  let cursor = path.resolve(process.cwd());
  for (let depth = 0; depth < 10; depth += 1) {
    if (
      existsSync(path.join(cursor, ".git")) ||
      existsSync(path.join(cursor, "pnpm-workspace.yaml"))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "..");
}

function resolveRuntimeCacheRoot(repoRoot: string): string {
  const envRoot =
    (process.env.UIQ_RUNTIME_CACHE_ROOT ?? "").trim() ||
    (process.env.UIQ_MCP_RUNTIME_CACHE_ROOT ?? "").trim();
  if (!envRoot) {
    return path.resolve(repoRoot, ".runtime-cache");
  }
  return path.isAbsolute(envRoot) ? path.resolve(envRoot) : path.resolve(repoRoot, envRoot);
}

function resolveRuntimeRoot(repoRoot: string): string {
  const runtimeOverride = (process.env.UNIVERSAL_AUTOMATION_RUNTIME_DIR ?? "").trim();
  if (runtimeOverride) {
    return path.resolve(runtimeOverride);
  }
  return path.resolve(resolveRuntimeCacheRoot(repoRoot), "automation");
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function directorySizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(fullPath);
      continue;
    }
    if (entry.isFile()) {
      total += (await stat(fullPath)).size;
    }
  }
  return total;
}

async function triggerWorkspaceCleanup(repoRoot: string): Promise<void> {
  if (envEnabled("FLOW_DISABLE_AUTO_RUNTIME_CLEANUP")) {
    return;
  }
  const runtimeCacheRoot = resolveRuntimeCacheRoot(repoRoot);
  const markerPath = path.join(runtimeCacheRoot, "cache", "record-session-cleanup-marker.json");
  const cleanupIntervalMinutes = 60;
  try {
    const markerStat = await stat(markerPath);
    const elapsedMs = Date.now() - markerStat.mtimeMs;
    if (elapsedMs < cleanupIntervalMinutes * 60 * 1000) {
      return;
    }
  } catch {
    // marker missing is expected on first run
  }

  const scriptPath = path.join(repoRoot, "scripts", "cleanup-runtime.sh");
  if (!existsSync(scriptPath)) {
    return;
  }
  const ttlHours = "72";
  const maxSizeGb = "2";
  const result = spawnSync(
    "bash",
    [scriptPath, "--apply", "--confirm-apply", "--ttl-hours", ttlHours, "--max-size-gb", maxSizeGb],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
    },
  );
  await ensureDirs([path.dirname(markerPath)]);
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        status: result.status,
        signal: result.signal ?? null,
        stdout: result.stdout?.trim() ? result.stdout.trim().slice(0, 500) : null,
        stderr: result.stderr?.trim() ? result.stderr.trim().slice(0, 500) : null,
      },
      null,
      2,
    ),
    "utf-8",
  );
  if (result.status !== 0) {
    process.stderr.write(
      `[record-session] cleanup-runtime failed with status=${String(result.status)}\n`,
    );
  }
}

function envEnabled(name: string): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function hasOtpHint(text: string): boolean {
  return /(otp|mfa|2fa|two[-_\s]?factor|one[-_\s]?time|verification(?:[-_\s]?code)?|auth(?:entication)?[-_\s]?code)/i.test(
    text,
  );
}

function parseProtectedProviderDomains(rawValue: string | undefined): string[] {
  const raw = (rawValue ?? "").trim();
  if (!raw) {
    return DEFAULT_PROTECTED_PROVIDER_DOMAINS;
  }
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.replace(/^https?:\/\//, "").split("/")[0] ?? item)
    .filter(Boolean);
}

function extractHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function resolveProtectedProviderDomain(
  event: CapturedEvent,
  protectedDomains: string[],
): string | null {
  const hostname = extractHostname(event.url);
  if (!hostname) {
    return null;
  }
  for (const domain of protectedDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return domain;
    }
  }
  return null;
}

function eventLooksStripeField(event: CapturedEvent): boolean {
  const blob =
    `${event.target.name ?? ""} ${event.target.type ?? ""} ${event.target.id ?? ""} ${event.target.cssPath ?? ""} ${event.target.text ?? ""}`.toLowerCase();
  return /(stripe|card.?number|cc-number|cardholder|name.?on.?card|cvc|cvv|security.?code|cc-csc|cc-exp|exp(?:iry|iration)?|postal|zip)/i.test(
    blob,
  );
}

function applyProviderProtection(
  step: FlowStep,
  event: CapturedEvent,
  config: ProtectedProviderConfig,
): FlowStep {
  const protectedDomain = resolveProtectedProviderDomain(event, config.protectedProviderDomains);
  if (!protectedDomain && !eventLooksStripeField(event)) {
    return step;
  }
  return {
    ...step,
    gate_policy: config.protectedProviderGatePolicy,
    gate_reason: PROVIDER_PROTECTED_PAYMENT_REASON,
  };
}

function eventLooksSensitive(event: CapturedEvent): boolean {
  const blob =
    `${event.target.name ?? ""} ${event.target.type ?? ""} ${event.target.id ?? ""} ${event.target.cssPath ?? ""}`.toLowerCase();
  return /(password|passwd|secret|token|otp|verification|auth|code|cvc|cvv|card|cc-|exp|postal|zip)/i.test(
    blob,
  );
}

function redactEventsForPersist(
  events: CapturedEvent[],
  allowSensitiveInputValues: boolean,
): CapturedEvent[] {
  return events.map((event) => {
    const sensitive = eventLooksSensitive(event);
    return {
      ...event,
      target: {
        ...event.target,
        text: sensitive ? "__redacted__" : event.target.text,
      },
      value:
        event.value === undefined
          ? undefined
          : allowSensitiveInputValues && !sensitive
            ? event.value
            : "__redacted__",
    };
  });
}

function createSessionId(): string {
  return `${SESSION_DIR_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function ensureDirs(paths: string[]): Promise<void> {
  await Promise.all(paths.map((target) => mkdir(target, { recursive: true })));
}

function isSessionDirectoryName(entryName: string): boolean {
  return (
    entryName.startsWith(SESSION_DIR_PREFIX) || LEGACY_SESSION_DIR_NAME_PATTERN.test(entryName)
  );
}

async function isSessionDirectory(fullPath: string, entryName: string): Promise<boolean> {
  if (isSessionDirectoryName(entryName)) {
    return true;
  }
  try {
    const metadata = await stat(path.join(fullPath, "session-meta.json"));
    return metadata.isFile();
  } catch {
    return false;
  }
}

export async function cleanupExpiredSessions(runtimeRoot: string): Promise<void> {
  const retentionHours = Math.max(
    1,
    parsePositiveNumber(
      AUTOMATION_ENV.AUTOMATION_RETENTION_HOURS ?? process.env.AUTOMATION_RETENTION_HOURS,
      24,
    ),
  );
  const runtimeMaxBytes = Math.max(
    50 * 1024 * 1024,
    parsePositiveNumber(process.env.AUTOMATION_RUNTIME_MAX_BYTES, 1024 * 1024 * 1024),
  );
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  const survivors: Array<{ fullPath: string; mtimeMs: number; sizeBytes: number }> = [];
  let retainedSize = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(runtimeRoot, entry.name);
    if (!(await isSessionDirectory(fullPath, entry.name))) {
      continue;
    }
    const stats = await stat(fullPath);
    if (stats.mtimeMs < cutoff) {
      await rm(fullPath, { recursive: true, force: true });
      continue;
    }
    const sizeBytes = await directorySizeBytes(fullPath);
    retainedSize += sizeBytes;
    survivors.push({ fullPath, mtimeMs: stats.mtimeMs, sizeBytes });
  }
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const survivor of survivors) {
    if (retainedSize <= runtimeMaxBytes) {
      break;
    }
    await rm(survivor.fullPath, { recursive: true, force: true });
    retainedSize -= survivor.sizeBytes;
  }
}

function getOption(name: string): string | null {
  const prefix = `--${name}=`;
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : null;
}

function getBooleanOption(name: string): boolean | null {
  if (process.argv.includes(`--${name}`)) {
    return true;
  }
  const value = getOption(name);
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return null;
}

function resolveMode(): RecordMode {
  const modeCandidate = getOption("mode") ?? "manual";
  if (modeCandidate === "manual" || modeCandidate === "midscene") {
    return modeCandidate;
  }
  throw new Error(`unsupported record mode: ${modeCandidate}`);
}

function resolveMidsceneDriverPath(): string {
  const optionPath = getOption("driver");
  const configuredPath = optionPath ?? "./scripts/midscene-driver.ts";
  return path.resolve(process.cwd(), configuredPath);
}

async function waitForManualConfirmation(page: Page, successSelector: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const selectorLabel = successSelector.trim()
      ? successSelector
      : "(skip success selector check)";
    process.stdout.write(
      `${[
        "[manual] Browser opened for hand recording.",
        "[manual] Please complete the flow manually in the opened browser window.",
        `[manual] Success selector: ${selectorLabel}`,
        "[manual] Press Enter here after you complete your flow.",
      ].join("\n")}\n`,
    );
    await rl.question("");
  } finally {
    rl.close();
  }

  if (successSelector.trim()) {
    await page.waitForSelector(successSelector, { timeout: 30_000 });
  }
}

function buildFlowDraft(
  sessionId: string,
  startUrl: string,
  events: CapturedEvent[],
  protectedProviderConfig: ProtectedProviderConfig,
): FlowDraft {
  const steps: FlowStep[] = [];
  steps.push({
    step_id: "s1",
    action: "navigate",
    url: startUrl,
  });

  let counter = 2;
  for (const event of events) {
    if (event.type === "navigate") {
      continue;
    }
    if (event.type === "click") {
      const selectors: SelectorCandidate[] = [];
      if (event.target.role && event.target.text) {
        selectors.push({
          kind: "role",
          value: `${event.target.role}[name='${event.target.text}']`,
          score: 90,
        });
      }
      if (event.target.id) {
        selectors.push({
          kind: "id",
          value: `#${event.target.id}`,
          score: 80,
        });
      }
      if (event.target.name) {
        selectors.push({
          kind: "name",
          value: `[name='${event.target.name}']`,
          score: 75,
        });
      }
      selectors.push({
        kind: "css",
        value: event.target.cssPath,
        score: 65,
      });
      const step: FlowStep = {
        step_id: `s${counter++}`,
        action: "click",
        target: { selectors },
      };
      steps.push(applyProviderProtection(step, event, protectedProviderConfig));
      continue;
    }
    if ((event.type === "type" || event.type === "change") && event.value !== undefined) {
      const selectors: SelectorCandidate[] = [];
      if (event.target.id) {
        selectors.push({ kind: "id", value: `#${event.target.id}`, score: 88 });
      }
      if (event.target.name) {
        selectors.push({
          kind: "name",
          value: `[name='${event.target.name}']`,
          score: 84,
        });
      }
      selectors.push({ kind: "css", value: event.target.cssPath, score: 68 });
      const lowerName = (event.target.name ?? "").toLowerCase();
      const lowerType = (event.target.type ?? "").toLowerCase();
      const lowerId = (event.target.id ?? "").toLowerCase();
      const lowerCss = (event.target.cssPath ?? "").toLowerCase();
      const otpLike = hasOtpHint(`${lowerName} ${lowerType} ${lowerId} ${lowerCss}`);
      const isSensitive =
        lowerType === "password" ||
        lowerName.includes("password") ||
        lowerName.includes("secret") ||
        lowerName.includes("token") ||
        lowerName.includes("code") ||
        otpLike;
      const step: FlowStep = {
        step_id: `s${counter++}`,
        action: "type",
        target: { selectors },
        value_ref: otpLike ? "${params.otp}" : isSensitive ? "${secrets.input}" : "${params.input}",
      };
      steps.push(applyProviderProtection(step, event, protectedProviderConfig));
    }
  }

  return {
    flow_id: `flow-${sessionId}`,
    session_id: sessionId,
    start_url: startUrl,
    generated_at: new Date().toISOString(),
    source_event_count: events.length,
    steps,
  };
}

async function runMidsceneTakeover(
  page: Page,
  context: Omit<MidsceneTakeoverContext, "page">,
  driverPath: string,
): Promise<void> {
  const moduleUrl = pathToFileURL(driverPath).href;
  const loaded = (await import(moduleUrl)) as Partial<MidsceneDriverModule>;
  if (typeof loaded.runMidsceneTakeover !== "function") {
    throw new Error(`midscene driver must export async runMidsceneTakeover(): ${driverPath}`);
  }

  await loaded.runMidsceneTakeover({
    page,
    ...context,
  });
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const mode = resolveMode();
  const baseUrl = AUTOMATION_ENV.BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:17380";
  const startUrl =
    AUTOMATION_ENV.START_URL?.trim() ||
    process.env.START_URL?.trim() ||
    `${baseUrl.replace(/\/$/, "")}/register`;
  const successSelector = AUTOMATION_ENV.SUCCESS_SELECTOR ?? process.env.SUCCESS_SELECTOR ?? "";
  const runtimeRoot = resolveRuntimeRoot(repoRoot);
  const sessionId = getOption("session-id") ?? createSessionId();
  const sessionDir = path.join(runtimeRoot, sessionId);
  const videoDir = path.join(sessionDir, "video");
  const harPath = path.join(sessionDir, "register.har");
  const tracePath = path.join(sessionDir, "trace.zip");
  const htmlPath = path.join(sessionDir, "final.register.html");
  const eventLogPath = path.join(sessionDir, "event-log.json");
  const flowDraftPath = path.join(sessionDir, "flow-draft.json");
  const storageStatePath = path.join(sessionDir, "storage-state.json");
  const latestPointerPath = path.join(runtimeRoot, "latest-session.json");

  const allowSensitiveCapture = envEnabled("FLOW_ALLOW_SENSITIVE_CAPTURE");
  const allowSensitiveTrace = allowSensitiveCapture && envEnabled("FLOW_ALLOW_SENSITIVE_TRACE");
  const allowSensitiveStorage = allowSensitiveCapture && envEnabled("FLOW_ALLOW_SENSITIVE_STORAGE");
  const allowSensitiveInputValues =
    allowSensitiveCapture &&
    (envEnabled("FLOW_ALLOW_SENSITIVE_INPUT_VALUES") ||
      envEnabled("RECORD_CAPTURE_INPUT_PLAINTEXT"));
  const captureHar = allowSensitiveCapture && envEnabled("FLOW_ALLOW_SENSITIVE_HAR");
  const captureVideo = allowSensitiveCapture && envEnabled("FLOW_ALLOW_SENSITIVE_VIDEO");
  const captureHtml = !envEnabled("FLOW_DISABLE_HTML_CAPTURE");
  const protectedProviderDomains = parseProtectedProviderDomains(
    process.env.FLOW_PROTECTED_PROVIDER_DOMAINS,
  );
  const protectedProviderGatePolicy = DEFAULT_PROTECTED_PROVIDER_GATE_POLICY;

  await ensureDirs([runtimeRoot, sessionDir, ...(captureVideo ? [videoDir] : [])]);
  await triggerWorkspaceCleanup(repoRoot);
  await cleanupExpiredSessions(runtimeRoot);

  const captureInputPlaintext = allowSensitiveInputValues;
  const explicitHeadless = AUTOMATION_ENV.HEADLESS ?? process.env.HEADLESS;
  const headless = explicitHeadless ? explicitHeadless !== "false" : mode !== "manual";
  if (mode === "manual" && headless) {
    throw new Error("manual mode requires headed browser. Set HEADLESS=false.");
  }

  const useSystemChrome = getBooleanOption("use-system-chrome") ?? false;

  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless,
    ...(useSystemChrome && {
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    }),
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    ...(captureHar
      ? {
          recordHar: {
            mode: "minimal",
            path: harPath,
          },
        }
      : {}),
    ...(captureVideo
      ? {
          recordVideo: {
            dir: videoDir,
            size: { width: 1280, height: 720 },
          },
        }
      : {}),
    viewport: { width: 1280, height: 720 },
    ...(useSystemChrome && {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }),
  });

  if (allowSensitiveTrace) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  }

  const page = await context.newPage();
  await page.addInitScript(`
    (() => {
      const capturePlaintextInput = ${captureInputPlaintext ? "true" : "false"};
      const recorder = { events: [] };
      const toCssPath = (el) => {
        if (!(el instanceof Element)) return "unknown";
        const segments = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 6) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            selector += "#" + current.id;
            segments.unshift(selector);
            break;
          }
          const className = String(current.className || "").trim();
          if (className) {
            selector += "." + className.split(/\\s+/).slice(0, 2).join(".");
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((node) => node.tagName === current.tagName);
            if (siblings.length > 1) {
              selector += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
            }
          }
          segments.unshift(selector);
          current = parent;
        }
        return segments.join(" > ");
      };
      const targetMeta = (target) => {
        const element = target instanceof Element ? target : null;
        if (!element) {
          return {
            tag: "unknown",
            id: null,
            name: null,
            type: null,
            role: null,
            text: null,
            classes: [],
            cssPath: "unknown"
          };
        }
        const textContent = (element.textContent || "").trim();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          name: element.getAttribute("name"),
          type: element.getAttribute("type"),
          role: element.getAttribute("role"),
          text: textContent ? textContent.slice(0, 120) : null,
          classes: Array.from(element.classList).slice(0, 5),
          cssPath: toCssPath(element),
        };
      };
      const push = (type, event, extra = {}) => {
        recorder.events.push({
          ts: new Date().toISOString(),
          type,
          url: window.location.href,
          target: targetMeta(event.target),
          ...extra,
        });
      };
      document.addEventListener("click", (event) => push("click", event), true);
      document.addEventListener("input", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          push("type", event, { value: capturePlaintextInput ? target.value.slice(0, 256) : "__redacted__" });
        }
      }, true);
      document.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
          push("change", event, { value: capturePlaintextInput ? String(target.value).slice(0, 256) : "__redacted__" });
        }
      }, true);
      document.addEventListener("submit", (event) => push("submit", event), true);
      document.addEventListener("keydown", (event) => push("keydown", event, { key: event.key }), true);
      window.addEventListener("beforeunload", () => {
        recorder.events.push({
          ts: new Date().toISOString(),
          type: "navigate",
          url: window.location.href,
          target: {
            tag: "window",
            id: null,
            name: null,
            type: null,
            role: null,
            text: null,
            classes: [],
            cssPath: "window"
          },
        });
      });
      window.__automationRecorder = recorder;
    })();
  `);

  const suggestedEmail = `demo+${Date.now()}@example.com`;
  const suggestedPassword = (process.env.REGISTER_PASSWORD ?? "").trim();
  const midsceneDriverPath = mode === "midscene" ? resolveMidsceneDriverPath() : null;

  if (mode === "manual") {
    await page.goto(startUrl, { waitUntil: "networkidle" });
    await waitForManualConfirmation(page, successSelector);
  } else {
    if (!midsceneDriverPath) {
      throw new Error("midscene mode requires driver path");
    }
    await runMidsceneTakeover(
      page,
      {
        startUrl,
        suggestedEmail,
        suggestedPassword,
        successSelector,
      },
      midsceneDriverPath,
    );
    if (successSelector.trim()) {
      await page.waitForSelector(successSelector, { timeout: 30_000 });
    }
  }

  const capturedEvents = await page.evaluate(() => {
    const recorder = (window as unknown as { __automationRecorder?: { events?: unknown[] } })
      .__automationRecorder;
    if (!recorder || !Array.isArray(recorder.events)) {
      return [];
    }
    return recorder.events;
  });
  const events = redactEventsForPersist(
    capturedEvents as CapturedEvent[],
    allowSensitiveInputValues,
  );
  const flowDraft = buildFlowDraft(sessionId, startUrl, events, {
    protectedProviderDomains,
    protectedProviderGatePolicy,
  });

  if (captureHtml) {
    const html = await page.content();
    await writeFile(htmlPath, html, "utf-8");
  }
  await writeFile(eventLogPath, JSON.stringify(events, null, 2), "utf-8");
  await writeFile(flowDraftPath, JSON.stringify(flowDraft, null, 2), "utf-8");
  if (allowSensitiveStorage) {
    await context.storageState({ path: storageStatePath });
  }
  if (allowSensitiveTrace) {
    await context.tracing.stop({ path: tracePath });
  }
  await context.close();
  await browser.close();

  const metadata: SessionMeta = {
    sessionId,
    mode,
    baseUrl,
    startUrl,
    suggestedEmail,
    outputDir: sessionDir,
    harPath: captureHar ? harPath : null,
    tracePath: allowSensitiveTrace ? tracePath : null,
    htmlPath: captureHtml ? htmlPath : null,
    eventLogPath,
    flowDraftPath,
    storageStatePath: allowSensitiveStorage ? storageStatePath : null,
    videoDir: captureVideo ? videoDir : null,
    midsceneDriverPath,
    capturePolicy: {
      allowSensitiveCapture,
      allowSensitiveTrace,
      allowSensitiveStorage,
      allowSensitiveInputValues,
      captureHar,
      captureVideo,
      captureHtml,
    },
    createdAt: new Date().toISOString(),
  };

  await writeFile(
    path.join(sessionDir, "session-meta.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
  await writeFile(latestPointerPath, JSON.stringify({ sessionId, sessionDir }, null, 2), "utf-8");

  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

function isExecutedAsScript(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return pathToFileURL(path.resolve(scriptPath)).href === import.meta.url;
}

if (isExecutedAsScript()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`record-session failed: ${message}\n`);
    process.exitCode = 1;
  });
}
