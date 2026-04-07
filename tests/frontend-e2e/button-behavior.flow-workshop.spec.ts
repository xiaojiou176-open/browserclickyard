import { expect, type Locator, type Page } from "@playwright/test";
import { CONSOLE_TAB_FLOW_DRAFT_TEST_ID } from "../../apps/command-center/src/constants/testIds";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

async function openAdvancedWorkshop(page: Page) {
  const workshopTab = page.getByTestId(CONSOLE_TAB_FLOW_DRAFT_TEST_ID);
  await clickWhenReady(workshopTab);
  await expect(page.getByRole("heading", { name: "Lab result and next experiment" })).toBeVisible();
  await clickWhenReady(
    page.getByText(
      "Advanced studio (optional): diagnostics, flow editing, and debugging evidence",
      { exact: true },
    ),
  );
  await expect(page.getByRole("list", { name: "flow-editor-steps" })).toBeVisible();
}

async function clickWhenReady(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ trial: true });
  await locator.click();
}

buttonBehaviorCase(
  { case_id: "nav-flow-workshop-selected", assertion_type: "aria-selected" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const workshopTab = page.getByTestId(CONSOLE_TAB_FLOW_DRAFT_TEST_ID);

    await clickWhenReady(workshopTab);

    await expect(workshopTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Lab result and next experiment" })).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-save-draft-success", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    await clickWhenReady(page.getByTestId(CONSOLE_TAB_FLOW_DRAFT_TEST_ID));

    await clickWhenReady(page.getByRole("button", { name: "Save draft" }).first());

    await expect.poll(() => harness.calls.saveFlowDraft).toBe(1);
    await expect(page.getByText("Flow draft saved successfully")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-replay-latest-success", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    await clickWhenReady(page.getByTestId(CONSOLE_TAB_FLOW_DRAFT_TEST_ID));

    await clickWhenReady(page.getByRole("button", { name: "Replay latest flow" }).first());

    await expect.poll(() => harness.calls.replayLatestFlow).toBe(1);
    await expect(page.getByText("Flow replay triggered")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-add-step", assertion_type: "list-count-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);

    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");
    await expect(stepList).toHaveCount(2);
    await clickWhenReady(page.locator(selectorForCase("flowworkshop-add-step")));
    await expect(stepList).toHaveCount(3);
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-run-step", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);
    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");

    await clickWhenReady(stepList.first().locator(selectorForCase("flowworkshop-run-step")));

    await expect.poll(() => harness.calls.replayStep).toBe(1);
    await expect(page.getByText("Single-step replay triggered for step-1")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-resume-step", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);
    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");

    await clickWhenReady(stepList.first().locator(selectorForCase("flowworkshop-resume-step")));

    await expect.poll(() => harness.calls.replayFromStep).toBe(1);
    await expect(page.getByText("Resume triggered from step step-1")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-move-step-up", assertion_type: "text-order-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);

    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");
    await expect(stepList.first()).toContainText("step-1");
    const secondStep = stepList.nth(1);
    await clickWhenReady(secondStep.getByText("Advanced settings (step_id / selector / order)"));
    await clickWhenReady(secondStep.locator(selectorForCase("flowworkshop-move-step-up")));
    await expect(stepList.first()).toContainText("step-2");
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-move-step-down", assertion_type: "text-order-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);

    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");
    await expect(stepList.first()).toContainText("step-1");
    const firstStep = stepList.first();
    await clickWhenReady(firstStep.getByText("Advanced settings (step_id / selector / order)"));
    await clickWhenReady(firstStep.locator(selectorForCase("flowworkshop-move-step-down")));
    await expect(stepList.first()).toContainText("step-2");
  },
);

buttonBehaviorCase(
  { case_id: "flowworkshop-delete-step", assertion_type: "list-count-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    await openAdvancedWorkshop(page);

    const stepList = page.getByRole("list", { name: "flow-editor-steps" }).getByRole("listitem");
    await expect(stepList).toHaveCount(2);
    page.once("dialog", (dialog) => dialog.accept());
    const firstStep = stepList.first();
    await clickWhenReady(firstStep.getByText("Advanced settings (step_id / selector / order)"));
    await clickWhenReady(firstStep.locator(selectorForCase("flowworkshop-delete-step")));
    await expect(stepList).toHaveCount(1);
  },
);
