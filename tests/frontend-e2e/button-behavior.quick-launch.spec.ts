import { expect } from "@playwright/test";
import {
  CONSOLE_TAB_QUICK_LAUNCH_TEST_ID,
  CONSOLE_TAB_TASK_CENTER_TEST_ID,
} from "../../apps/command-center/src/constants/testIds";
import { bootstrapButtonBehaviorApp, buttonBehaviorCase } from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "nav-quick-launch-selected", assertion_type: "aria-selected" },
  async ({ page }, testInfo) => {
    await bootstrapButtonBehaviorApp(page);
    const quickLaunchTab = page.getByTestId(CONSOLE_TAB_QUICK_LAUNCH_TEST_ID);
    const taskCenterTab = page.getByTestId(CONSOLE_TAB_TASK_CENTER_TEST_ID);

    await taskCenterTab.click();
    await quickLaunchTab.click();

    await expect(quickLaunchTab).toHaveAttribute("aria-selected", "true");
    if (testInfo.project.name.includes("mobile")) {
      await expect(page.getByRole("heading", { name: "Start with a URL" })).toHaveCount(1);
    } else {
      await expect(page.getByRole("heading", { name: "Start with a URL" })).toBeVisible();
    }
  },
);

buttonBehaviorCase(
  { case_id: "quicklaunch-first-use-start-stage", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, {
      localStorage: {
        onboardingDone: true,
        firstUseDone: false,
      },
      tasks: [],
      runs: [],
    });

    await page.getByRole("button", { name: "Start step 1" }).click();
    await expect(
      page.getByText(
        /Step 1: Configure the target URL, optional start page, and success checkpoint so the lab knows what page to test\./,
      ),
    ).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "quicklaunch-enter-run-stage", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page, {
      localStorage: {
        onboardingDone: true,
        firstUseDone: false,
        firstUseStage: "configure",
        firstUseProgress: {
          configValid: true,
          runTriggered: false,
          resultSeen: false,
        },
      },
      tasks: [],
      runs: [],
    });

    await page.getByRole("button", { name: "Configuration complete, continue to run" }).click();
    await expect(
      page.getByText(
        /Step 2: Choose a lab mode or a saved template and start the run\. Once a run is detected, continue into Runs & Blocks to inspect the result\./,
      ),
    ).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "quicklaunch-sidebar-toggle-panel", assertion_type: "visibility-toggle" },
  async ({ page }, testInfo) => {
    await bootstrapButtonBehaviorApp(page);
    const collapseButton = page.getByRole("button", { name: "Collapse parameter panel" });
    const expandButton = page.getByRole("button", { name: "Expand parameter panel" });

    if (testInfo.project.name.includes("mobile")) {
      await expect(collapseButton).toHaveCount(0);
      await expect(expandButton).toHaveCount(0);
      return;
    }

    await collapseButton.click();
    await expect(page.getByText("Run parameters")).toHaveCount(0);
    await expect(expandButton).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "console-restart-tour", assertion_type: "storage-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);

    await page.getByRole("button", { name: "Restart onboarding" }).click();

    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("ab_onboarding_done")), {
        timeout: 10_000,
      })
      .toBe(null);
    await expect(page.getByText("Step 1: Start from the target, not from the room list")).toBeVisible();
  },
);
