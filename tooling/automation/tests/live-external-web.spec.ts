import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

function isEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.UIQ_LIVE_EXTERNAL_ENABLED ?? "");
}

const enabled = isEnabled();

const targetUrl = (process.env.UIQ_LIVE_EXTERNAL_URL ?? "https://example.com").trim();
const allowlistRaw = (process.env.UIQ_LIVE_EXTERNAL_ALLOWLIST ?? "example.com").trim();
const allowlistPatterns = allowlistRaw
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function matchesAllowPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function isAllowedExternalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return allowlistPatterns.some((pattern) => matchesAllowPattern(normalized, pattern));
}

const MAX_RETRIES = 2;

type LiveErrorClass = "network_or_timeout" | "certificate" | "logic";

function classifyLiveError(error: unknown): LiveErrorClass {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/(err_cert_|certificate|ssl|tls|x509|authority_invalid|self[- ]signed)/i.test(reason)) {
    return "certificate";
  }
  if (
    /(timeout|timed out|net::|network|econn|eai_|enotfound|reset|unavailable|temporary|dns|socket|503|504|502)/i.test(
      reason,
    )
  ) {
    return "network_or_timeout";
  }
  return "logic";
}

function shouldRetry(errorClass: LiveErrorClass): boolean {
  return errorClass === "network_or_timeout" || errorClass === "certificate";
}

async function cleanupLiveContext(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      try {
        window.localStorage.clear();
      } catch {
        // Best-effort cleanup for cross-origin pages.
      }
      try {
        window.sessionStorage.clear();
      } catch {
        // Best-effort cleanup for cross-origin pages.
      }
    });
  } catch {
    // Best-effort cleanup for pages that block evaluate.
  }
  try {
    await page.context().clearCookies();
  } catch {
    // Best-effort cleanup; context may already be closing.
  }
}

test("live external web smoke: reachability and baseline interaction", async ({ page }) => {
  test.setTimeout(90_000);
  expect(
    enabled,
    "Set UIQ_LIVE_EXTERNAL_ENABLED=true to run real external website smoke test",
  ).toBe(true);
  const parsed = new URL(targetUrl);
  expect(["http:", "https:"], `unsupported protocol for ${targetUrl}`).toContain(parsed.protocol);
  expect(
    isLoopbackHost(parsed.hostname),
    "live external web test requires non-loopback website",
  ).toBeFalsy();
  expect(
    allowlistPatterns.length,
    "UIQ_LIVE_EXTERNAL_ALLOWLIST must contain at least one host pattern",
  ).toBeGreaterThan(0);
  expect(
    isAllowedExternalHost(parsed.hostname),
    `target host '${parsed.hostname}' is not in UIQ_LIVE_EXTERNAL_ALLOWLIST (${allowlistPatterns.join(", ")})`,
  ).toBe(true);

  let lastError: unknown = null;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        test.info().annotations.push({
          type: "live-attempt",
          description: `${attempt + 1}/${MAX_RETRIES + 1}`,
        });
        const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        expect(response, `navigation failed for ${targetUrl}`).not.toBeNull();
        expect(response?.status(), `unexpected HTTP status from ${targetUrl}`).toBeLessThan(400);

        await expect(page.locator("body")).toBeVisible();
        await expect.poll(async () => page.title(), { timeout: 20_000 }).not.toEqual("");

        const interactiveCount = await page.locator("a, button, input, textarea, select").count();
        expect(interactiveCount).toBeGreaterThan(0);

        await page.mouse.wheel(0, 300);
        await expect
          .poll(async () => page.evaluate(() => document.readyState), { timeout: 10_000 })
          .toMatch(/^(interactive|complete)$/);
        return;
      } catch (error) {
        lastError = error;
        const errorClass = classifyLiveError(error);
        const hint = `[live-web][${errorClass}] attempt=${attempt + 1}/${MAX_RETRIES + 1}`;

        const certToggleHint =
          errorClass === "certificate"
            ? " (for controlled environments only, set UIQ_LIVE_ALLOW_INSECURE_CERTS=true)"
            : "";
        if (!shouldRetry(errorClass) || attempt >= MAX_RETRIES) {
          throw new Error(
            `${hint} final-failure${certToggleHint}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } finally {
    await cleanupLiveContext(page);
  }

  throw new Error(
    `unreachable retry state: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
});
