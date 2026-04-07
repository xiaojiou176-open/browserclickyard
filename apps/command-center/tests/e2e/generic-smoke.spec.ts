import { expect, test } from "@playwright/test";

test("@generic localhost generic smoke", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);

  await expect(page.locator("body")).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => document.readyState), { timeout: 10_000 })
    .toMatch(/^(interactive|complete)$/);

  await page.locator("body").click();

  const bodyText = await page.locator("body").innerText();
  expect(bodyText.trim().length).toBeGreaterThan(0);

  await page.mouse.wheel(0, 400);
  await expect
    .poll(async () => page.evaluate(() => document.readyState), { timeout: 5_000 })
    .toMatch(/^(interactive|complete)$/);
  expect(pageErrors).toEqual([]);
});
