import type { Page } from "playwright";

export const PAGE_SETTLE_LOAD_TIMEOUT_MS = 5000;

function isRecoverableLoadWaitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

async function waitForAnimationFrames(page: Page, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`page settle timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function waitForPageSettled(
  page: Page,
  loadTimeoutMs = PAGE_SETTLE_LOAD_TIMEOUT_MS,
): Promise<void> {
  try {
    await page.waitForLoadState("load", { timeout: loadTimeoutMs });
  } catch (error) {
    // Best-effort: some targets keep pending connections and never reach "load".
    if (!isRecoverableLoadWaitError(error)) {
      throw error;
    }
  }
  await waitForAnimationFrames(page, loadTimeoutMs);
}
