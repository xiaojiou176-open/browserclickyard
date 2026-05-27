import { expect, test } from "@playwright/test";
import { bootstrapButtonBehaviorApp } from "./support/button-behavior-harness";

test("@frontend-e2e-side-effect command run mutates task state", async ({ page }) => {
  const harness = await bootstrapButtonBehaviorApp(page);
  const commandCard = page.locator("article.command-card", { hasText: "Run pipeline task" });

  await commandCard.getByRole("button", { name: "Run" }).click();

  await expect.poll(() => harness.calls.runCommand).toBe(1);
  await expect(page.getByText("Submitted Run pipeline task")).toBeVisible();
});
