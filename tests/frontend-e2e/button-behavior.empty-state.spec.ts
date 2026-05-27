import { expect } from "@playwright/test";
import {
  CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
  TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID,
  TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID,
} from "../../apps/command-center/src/constants/testIds";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "taskcenter-empty-state-action", assertion_type: "aria-selected" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, { runs: [] });
    await page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID).click();
    await page.getByTestId(TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID).click();

    await expect(page.getByTestId(TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID)).toBeVisible();
    await page.locator(selectorForCase("taskcenter-empty-state-action")).click();

    await expect(page.getByTestId(CONSOLE_TAB_QUICK_LAUNCH_TEST_ID)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);
