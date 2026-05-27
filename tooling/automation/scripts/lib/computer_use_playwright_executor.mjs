#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coerceString(value, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function ensureActionName(raw) {
  const value = coerceString(raw, "manual_review");
  return value.toLowerCase();
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

async function waitForPageStability(page, timeoutMs) {
  const budget = Math.max(100, timeoutMs);
  try {
    await page.waitForLoadState("networkidle", { timeout: budget });
    return "networkidle";
  } catch {
    await page.waitForLoadState("domcontentloaded", { timeout: budget });
    return "domcontentloaded";
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function run() {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const action = payload?.action ?? {};
  const args = action?.args ?? {};
  const actionName = ensureActionName(action?.name);
  const metadata = payload?.metadata ?? {};
  const sessionId = coerceString(payload?.sessionId, "unknown_session");
  const actionId = coerceString(payload?.actionId, "unknown_action");
  const runtimeRoot = coerceString(payload?.runtimeRoot, ".runtime-cache/automation/computer-use");
  const evidenceRoot = path.resolve(runtimeRoot, "evidence");
  await fs.mkdir(evidenceRoot, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  let requestCount = 0;
  let failedRequestCount = 0;
  let status5xx = 0;
  page.on("request", () => {
    requestCount += 1;
  });
  page.on("requestfailed", () => {
    failedRequestCount += 1;
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      status5xx += 1;
    }
  });

  const traceSteps = [];
  const baseUrl =
    coerceString(args?.url) || coerceString(metadata?.baseUrl) || coerceString(metadata?.startUrl);
  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    traceSteps.push({ step: "goto", value: baseUrl });
  }

  if (actionName === "navigate") {
    const targetUrl = coerceString(args?.url) || baseUrl;
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      traceSteps.push({ step: "navigate", value: targetUrl });
    }
  } else if (actionName === "click") {
    const selector = coerceString(args?.selector);
    if (selector) {
      await page.click(selector, { timeout: 10_000 });
      traceSteps.push({ step: "click.selector", value: selector });
    } else {
      const x = toNumber(args?.x, 10);
      const y = toNumber(args?.y, 10);
      await page.mouse.click(x, y, { button: coerceString(args?.button, "left") });
      traceSteps.push({ step: "click.xy", value: { x, y } });
    }
  } else if (actionName === "type") {
    const text = coerceString(args?.text);
    const selector = coerceString(args?.selector);
    if (selector) {
      await page.fill(selector, text, { timeout: 10_000 });
      traceSteps.push({ step: "type.selector", value: selector });
    } else {
      await page.keyboard.type(text);
      traceSteps.push({ step: "type.keyboard", value: text.slice(0, 80) });
    }
  } else if (actionName === "key") {
    const key = coerceString(args?.key, "Enter");
    await page.keyboard.press(key);
    traceSteps.push({ step: "key.press", value: key });
  } else if (actionName === "scroll") {
    const deltaY = toNumber(args?.deltaY, 500);
    await page.mouse.wheel(0, deltaY);
    traceSteps.push({ step: "scroll", value: deltaY });
  } else if (actionName === "wait") {
    const ms = Math.max(
      100,
      Math.min(30_000, toNumber(args?.milliseconds, toNumber(args?.seconds, 1) * 1000)),
    );
    const waitMode = await waitForPageStability(page, ms);
    traceSteps.push({ step: "wait.stability", value: { timeout_ms: ms, mode: waitMode } });
  } else {
    traceSteps.push({ step: "manual_review", value: actionName });
  }

  const screenPath = path.resolve(evidenceRoot, `${sessionId}_${actionId}_${timestamp()}.png`);
  await page.screenshot({ path: screenPath, fullPage: true });
  const title = await page.title().catch(() => "");
  const url = page.url();

  await browser.close();

  const result = {
    ok: true,
    executor: "backend-playwright-adapter",
    evidence: {
      screens: [screenPath],
      clips: [],
      network_summary: {
        request_count: requestCount,
        request_failed_count: failedRequestCount,
        status_5xx_count: status5xx,
      },
      dom_summary: { title, url },
      replay_trace: { steps: traceSteps },
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
