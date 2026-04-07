import { expect } from "@playwright/test";
import { CONSOLE_TAB_TASK_CENTER_TEST_ID } from "../../apps/command-center/src/constants/testIds";
import { bootstrapButtonBehaviorApp, buttonBehaviorCase } from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "terminal-clear", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();
    const terminal = page.getByRole("region", { name: "Live terminal" });

    await terminal.getByRole("button", { name: "Clear" }).click();

    await expect(terminal.getByText("Terminal log is empty")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "terminal-filter-errors", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();
    const terminal = page.getByRole("region", { name: "Live terminal" });

    await terminal.getByLabel("Log level filter").selectOption("error");

    await expect(terminal.getByText("Terminal log is empty")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "terminal-autoscroll-toggle", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();
    const checkbox = page.getByTestId("terminal-autoscroll");

    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
  },
);

buttonBehaviorCase(
  { case_id: "terminal-height-change", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();
    const slider = page.getByTestId("terminal-height");
    const before = await slider.inputValue();

    await slider.focus();
    await page.keyboard.press("ArrowRight");

    await expect(slider).not.toHaveValue(before);
  },
);
