import { expect, type Page } from "@playwright/test";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

async function openOnboarding() {
  return {
    localStorage: {
      onboardingDone: false,
      firstUseDone: true,
    },
  } as const;
}

async function waitForStepOneDialog(page: Page) {
  const bootStatus = page.getByRole("status").filter({ hasText: "Initializing page..." });
  await expect(bootStatus).toHaveCount(0, { timeout: 45_000 });
  const dialog = page.getByRole("dialog", {
    name: "Step 1: Start from the target, not from the room list",
  });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

buttonBehaviorCase(
  { case_id: "onboarding-close-backdrop", assertion_type: "storage-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, await openOnboarding());

    await waitForStepOneDialog(page);
    const closeBackdrop = page.locator(selectorForCase("onboarding-close-backdrop"));
    await expect(closeBackdrop).toBeVisible();
    await page.mouse.click(8, 8);

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")))
      .toBe("1");
  },
);

buttonBehaviorCase(
  { case_id: "onboarding-skip", assertion_type: "storage-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, await openOnboarding());

    await waitForStepOneDialog(page);
    await page.locator(selectorForCase("onboarding-skip")).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")))
      .toBe("1");
  },
);

buttonBehaviorCase(
  { case_id: "onboarding-next", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, await openOnboarding());

    await waitForStepOneDialog(page);
    await page.locator(selectorForCase("onboarding-next")).click();

    await expect(page.getByRole("dialog", { name: "Step 2: Launch from Stress Lab" })).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "onboarding-prev", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, await openOnboarding());

    await waitForStepOneDialog(page);
    await page.locator(selectorForCase("onboarding-next")).click();
    await page.locator(selectorForCase("onboarding-prev")).click();

    await expect(
      page.getByRole("dialog", { name: "Step 1: Start from the target, not from the room list" }),
    ).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "onboarding-start", assertion_type: "storage-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, await openOnboarding());

    await waitForStepOneDialog(page);
    await page.locator(selectorForCase("onboarding-next")).click();
    await page.locator(selectorForCase("onboarding-next")).click();
    await page.locator(selectorForCase("onboarding-next")).click();
    await page.locator(selectorForCase("onboarding-next")).click();
    await page.locator(selectorForCase("onboarding-start")).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")))
      .toBe("1");
  },
);
