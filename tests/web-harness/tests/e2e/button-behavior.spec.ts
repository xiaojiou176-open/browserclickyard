import { expect, type Page, test } from "@playwright/test";

function buttonBehaviorCase(
  meta: { case_id: string; assertion_type: string },
  body: Parameters<typeof test>[1],
) {
  test(meta.case_id, body);
}

async function open(page: Page, path: string) {
  await page.goto(path);
}

buttonBehaviorCase(
  { case_id: "appsweb-nav-home", assertion_type: "aria-current" },
  async ({ page }) => {
    await open(page, "/about");
    await page.getByTestId("nav-home").click();
    await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/\/$/);
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-nav-about", assertion_type: "aria-current" },
  async ({ page }) => {
    await open(page, "/");
    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("nav-about")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("about-page")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-nav-contact", assertion_type: "aria-current" },
  async ({ page }) => {
    await open(page, "/");
    await page.getByTestId("nav-contact").click();
    await expect(page.getByTestId("nav-contact")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("feedback-form")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-nav-safe", assertion_type: "aria-current" },
  async ({ page }) => {
    await open(page, "/");
    await page.getByTestId("nav-safe").click();
    await expect(page.getByTestId("nav-safe")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("safe-page")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-nav-stories", assertion_type: "aria-current" },
  async ({ page }) => {
    await open(page, "/");
    await page.getByTestId("nav-stories").click();
    await expect(page.getByTestId("nav-stories")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("story-page")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-feedback-submit", assertion_type: "text-visible" },
  async ({ page }) => {
    await open(page, "/contact");
    await page.getByTestId("feedback-name").fill("Alex");
    await page.getByTestId("feedback-message").fill("This is a valid message.");
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-result")).toHaveText("Feedback submitted.");
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-safe-toggle", assertion_type: "attribute-change" },
  async ({ page }) => {
    await open(page, "/safe");
    const toggle = page.getByTestId("safe-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("safe-state")).toHaveText("safe_mode=on");
  },
);

buttonBehaviorCase(
  { case_id: "appsweb-about-toggle", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await open(page, "/about");
    const toggle = page.getByTestId("about-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("about-details")).toBeVisible();
  },
);
