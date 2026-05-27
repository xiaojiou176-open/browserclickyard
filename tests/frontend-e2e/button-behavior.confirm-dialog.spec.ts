import { expect } from "@playwright/test";
import { bootstrapButtonBehaviorApp, buttonBehaviorCase } from "./support/button-behavior-harness";

const dangerousCommands = [
  {
    command_id: "clean-cache-demo",
    title: "Clear cache",
    description: "Dangerous command confirmation flow",
    tags: ["maintenance"],
  },
];

buttonBehaviorCase(
  { case_id: "confirm-dialog-overlay-close", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, { commands: dangerousCommands });

    await page.getByRole("button", { name: "Dangerous run" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm dangerous command" })).toBeVisible();
    await page.getByTestId("confirm-dialog-overlay-close").click();
    await expect(page.getByRole("dialog", { name: "Confirm dangerous command" })).toHaveCount(0);
  },
);

buttonBehaviorCase(
  { case_id: "confirm-dialog-cancel", assertion_type: "visibility-toggle" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page, { commands: dangerousCommands });

    await page.getByRole("button", { name: "Dangerous run" }).click();
    await page.getByTestId("confirm-dialog-cancel").click();

    await expect(page.getByRole("dialog", { name: "Confirm dangerous command" })).toHaveCount(0);
    await expect.poll(() => harness.calls.runCommand).toBe(0);
  },
);

buttonBehaviorCase(
  { case_id: "confirm-dialog-confirm", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page, { commands: dangerousCommands });

    await page.getByRole("button", { name: "Dangerous run" }).click();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect.poll(() => harness.calls.runCommand).toBe(1);
    await expect(page.getByText("Submitted Clear cache")).toBeVisible();
  },
);
