import { expect, test } from "@playwright/test";

test("@regression story routes and safe toggles", async ({ page }) => {
  await page.goto("/stories/counter-default");
  await expect(page.getByTestId("story-title")).toContainText("Counter / Default");
  await expect(page.getByTestId("nav-stories")).toHaveAttribute("aria-current", "page");

  await page.goto("/safe");
  await expect(page.getByTestId("safe-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("safe-toggle").click();
  await expect(page.getByTestId("safe-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("safe-state")).toContainText("safe_mode=on");
  await expect(page.getByTestId("nav-safe")).toHaveAttribute("aria-current", "page");

  await page.goto("/about");
  await expect(page.getByTestId("about-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("about-toggle").click();
  await expect(page.getByTestId("about-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("about-details")).toBeVisible();
  await expect(page.getByTestId("nav-about")).toHaveAttribute("aria-current", "page");
});
