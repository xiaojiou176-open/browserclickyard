import { expect, type Page } from "@playwright/test";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

async function waitForHelpTrigger(page: Page) {
  const bootStatus = page.getByRole("status").filter({ hasText: "Initializing page..." });
  await expect(bootStatus).toHaveCount(0, { timeout: 45_000 });
  const trigger = page.getByRole("button", { name: "Help" });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await expect(trigger).toBeEnabled();
  return trigger;
}

buttonBehaviorCase(
  { case_id: "helptour-open-panel", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const helpTrigger = await waitForHelpTrigger(page);
    await helpTrigger.click();

    await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
    await page.getByRole("button", { name: "Close help panel" }).click();
    await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
    await expect(helpTrigger).toBeFocused();
  },
);

buttonBehaviorCase(
  { case_id: "helptour-restart-onboarding", assertion_type: "storage-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const helpTrigger = await waitForHelpTrigger(page);
    await helpTrigger.click();
    await page.getByTestId("helptour-restart-onboarding").click();

    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")), {
        timeout: 10_000,
      })
      .toBe(null);
    await expect(page.getByText("Step 1: Start from the target, not from the room list")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "helptour-close-panel", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const helpTrigger = await waitForHelpTrigger(page);

    await helpTrigger.click();
    await page.getByTestId("help-panel-close").click();

    await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
    await expect(helpTrigger).toBeFocused();
  },
);

buttonBehaviorCase(
  { case_id: "helptour-overlay-close", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const helpTrigger = await waitForHelpTrigger(page);
    await helpTrigger.click();
    const closeOverlay = page.locator(selectorForCase("helptour-overlay-close"));
    await expect(closeOverlay).toBeVisible();
    await closeOverlay.click({ position: { x: 2, y: 2 } });

    await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
  },
);
