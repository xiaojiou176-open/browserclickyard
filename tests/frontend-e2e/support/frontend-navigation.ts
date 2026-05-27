import { expect, type Page } from "@playwright/test";

type FrontendGotoOptions = {
  maxAttempts?: number;
  initialGotoTimeoutMs?: number;
  gotoTimeoutStepMs?: number;
  probeTimeoutMs?: number;
  probeWindowTimeoutMs?: number;
  appReadyTimeoutMs?: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function resolveFrontendRootUrl(): string {
  const explicitBaseUrl = (process.env.UIQ_FRONTEND_E2E_BASE_URL ?? "").trim();
  if (explicitBaseUrl) {
    return explicitBaseUrl.endsWith("/") ? explicitBaseUrl : `${explicitBaseUrl}/`;
  }
  const explicitPort = envInt("UIQ_FRONTEND_E2E_PORT", 0);
  if (explicitPort > 0) {
    return `http://127.0.0.1:${String(explicitPort)}/`;
  }
  return "/";
}

const RETRYABLE_BOOT_ERROR_TOKENS = [
  "ERR_ADDRESS_INVALID",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_ABORTED",
  "ERR_TIMED_OUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "NS_ERROR_CONNECTION_REFUSED",
  "COULD NOT CONNECT TO THE SERVER",
  "TARGET PAGE, CONTEXT OR BROWSER HAS BEEN CLOSED",
  "TARGET CLOSED",
] as const;

export function isRetryableFrontendBootErrorMessage(message: string): boolean {
  const normalized = message.toUpperCase();
  return RETRYABLE_BOOT_ERROR_TOKENS.some((token) => normalized.includes(token));
}

export function isRetryableFrontendBootError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return isRetryableFrontendBootErrorMessage(message);
}

export function isFrontendProbeReadyStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

const FRONTEND_BOOT_TEXT = "Initializing page...";

export function isFrontendAppReadySignal(input: {
  bootShellVisible: boolean;
  consoleRootVisible: boolean;
  titleVisible: boolean;
  navTabsVisible: boolean;
}): boolean {
  if (input.bootShellVisible) {
    return false;
  }
  if (!input.consoleRootVisible) {
    return false;
  }
  return input.titleVisible || input.navTabsVisible;
}

async function waitForFrontendAppReady(page: Page, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const bootShellVisible = await page
          .getByRole("status")
          .filter({ hasText: FRONTEND_BOOT_TEXT })
          .first()
          .isVisible()
          .catch(() => false);
        const consoleRootVisible = await page
          .locator(".console-root")
          .first()
          .isVisible()
          .catch(() => false);
        const titleVisible = await page
          .locator(".console-root .header-text h1")
          .first()
          .isVisible()
          .catch(() => false);
        const navTabsVisible = await page
          .locator(".console-root .nav-tabs")
          .first()
          .isVisible()
          .catch(() => false);
        return isFrontendAppReadySignal({
          bootShellVisible,
          consoleRootVisible,
          titleVisible,
          navTabsVisible,
        });
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
}

export async function gotoRootWithFrontendRetry(
  page: Page,
  options: FrontendGotoOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? envInt("UIQ_FRONTEND_BOOT_MAX_ATTEMPTS", 20);
  const initialGotoTimeoutMs = options.initialGotoTimeoutMs ?? 8_000;
  const gotoTimeoutStepMs = options.gotoTimeoutStepMs ?? 1_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const probeWindowTimeoutMs =
    options.probeWindowTimeoutMs ?? envInt("UIQ_FRONTEND_BOOT_PROBE_WINDOW_MS", 8_000);
  const appReadyTimeoutMs =
    options.appReadyTimeoutMs ?? envInt("UIQ_FRONTEND_BOOT_APP_READY_TIMEOUT_MS", 15_000);
  let lastError: Error | undefined;
  let lastProbeError: Error | undefined;
  let lastProbeTransportError: Error | undefined;
  const rootUrl = resolveFrontendRootUrl();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.goto(rootUrl, {
        waitUntil: "domcontentloaded",
        timeout: initialGotoTimeoutMs + (attempt - 1) * gotoTimeoutStepMs,
      });
      try {
        await waitForFrontendAppReady(page, appReadyTimeoutMs);
        return;
      } catch (appReadyError) {
        lastError =
          appReadyError instanceof Error
            ? new Error(
                `frontend app shell not ready on attempt ${String(attempt)}: ${appReadyError.message}`,
              )
            : new Error(`frontend app shell not ready on attempt ${String(attempt)}`);
        await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => undefined);
        continue;
      }
    } catch (error) {
      if (!isRetryableFrontendBootError(error)) {
        throw error;
      }
      lastError = error;
      try {
        await expect
          .poll(
            async () => {
              try {
                const response = await page.request.get(rootUrl, { timeout: probeTimeoutMs });
                const status = response.status();
                const ready = isFrontendProbeReadyStatus(status);
                if (!ready) {
                  lastProbeTransportError = new Error(
                    `frontend readiness probe returned non-ready status ${String(status)}`,
                  );
                } else {
                  lastProbeTransportError = undefined;
                }
                return ready;
              } catch (probeRequestError) {
                lastProbeTransportError =
                  probeRequestError instanceof Error
                    ? probeRequestError
                    : new Error(String(probeRequestError));
                return false;
              }
            },
            { timeout: probeWindowTimeoutMs },
          )
          .toBe(true);
      } catch (probeError) {
        const normalizedProbeError =
          probeError instanceof Error ? probeError : new Error(String(probeError));
        if (lastProbeTransportError) {
          lastProbeError = new Error(
            `${normalizedProbeError.message}; last probe detail: ${lastProbeTransportError.message}`,
          );
        } else {
          lastProbeError = normalizedProbeError;
        }
      }
      await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
  }

  if (lastProbeError) {
    lastError = new Error(
      `${lastError?.message ?? "frontend boot failed"}; probe: ${lastProbeError.message}`,
    );
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(
    `Unable to navigate frontend root after ${String(maxAttempts)} attempts for unknown reason.`,
  );
}
