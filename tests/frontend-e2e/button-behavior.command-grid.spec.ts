import { expect } from "@playwright/test";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "commandgrid-filter-pipeline", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const pipelineTab = page.getByRole("tab", { name: /Pipeline/ });
    await pipelineTab.click();

    await expect(page.getByRole("heading", { name: "Run pipeline task" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Initialize environment" })).toHaveCount(0);
  },
);

buttonBehaviorCase(
  { case_id: "commandgrid-filter-pipeline-tab", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const tablist = page.getByRole("tablist", { name: "Command categories" });
    const pipelineTab = tablist.getByRole("tab", { name: /Pipeline/ });
    const allTab = tablist.getByRole("tab", { name: /All/ });

    await expect(tablist).toBeVisible();
    await expect(allTab).toHaveAttribute("aria-selected", "true");
    await expect(pipelineTab).toHaveAttribute("aria-selected", "false");
    await pipelineTab.click();
    await expect(pipelineTab).toHaveAttribute("aria-selected", "true");
    await expect(allTab).toHaveAttribute("aria-selected", "false");
  },
);

buttonBehaviorCase(
  { case_id: "commandgrid-run-command-success", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);
    const commandCard = page.locator("article.command-card", { hasText: "Run pipeline task" });

    await commandCard.getByRole("button", { name: "Run" }).click();

    await expect.poll(() => harness.calls.runCommand).toBe(1);
    await expect(page.getByText("Submitted Run pipeline task")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "commandgrid-run-command-testid", assertion_type: "toast-visible" },
  async ({ page }) => {
    const harness = await bootstrapButtonBehaviorApp(page);

    await page.locator(selectorForCase("commandgrid-run-command-testid")).first().click();

    await expect.poll(() => harness.calls.runCommand).toBe(1);
    await expect(page.getByText("Submitted Run pipeline task")).toBeVisible();
  },
);

buttonBehaviorCase(
  { case_id: "commandgrid-filter-all", assertion_type: "text-visible" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);

    await page.getByRole("tab", { name: /Pipeline/ }).click();
    await page.getByRole("tab", { name: /All/ }).click();

    await expect(page.getByRole("heading", { name: "Run pipeline task" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Initialize environment" })).toBeVisible();
  },
);
