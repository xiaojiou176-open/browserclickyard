import { expect } from "@playwright/test";
import {
  bootstrapButtonBehaviorApp,
  buttonBehaviorCase,
  selectorForCase,
} from "./support/button-behavior-harness";

buttonBehaviorCase(
  { case_id: "params-toggle-register-password-visibility", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const toggleSelector = selectorForCase("params-toggle-register-password-visibility");
    const registerPasswordInput = page.locator("#register-password");
    const toggleButton = page.locator(toggleSelector);

    await expect(registerPasswordInput).toHaveAttribute("type", "password");
    await expect(toggleButton).toHaveCount(1);
    await expect(toggleButton).toHaveAttribute("aria-controls", "register-password");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    await toggleButton.click();
    await expect(registerPasswordInput).toHaveAttribute("type", "text");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "true");
  },
);

buttonBehaviorCase(
  { case_id: "params-toggle-token-visibility", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const toggleSelector = selectorForCase("params-toggle-token-visibility");
    const tokenInput = page.locator("#automation-token");
    const toggleButton = page.locator(toggleSelector);

    await expect(tokenInput).toHaveAttribute("type", "password");
    await expect(toggleButton).toHaveCount(1);
    await expect(toggleButton).toHaveAttribute("aria-controls", "automation-token");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    await toggleButton.click();
    await expect(tokenInput).toHaveAttribute("type", "text");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "true");
  },
);

buttonBehaviorCase(
  { case_id: "params-toggle-api-key-visibility", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const toggleSelector = selectorForCase("params-toggle-api-key-visibility");
    const apiKeyInput = page.locator("#api-key");
    const toggleButton = page.locator(toggleSelector);

    await expect(apiKeyInput).toHaveAttribute("type", "password");
    await expect(toggleButton).toHaveCount(1);
    await expect(toggleButton).toHaveAttribute("aria-controls", "api-key");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    await toggleButton.click();
    await expect(apiKeyInput).toHaveAttribute("type", "text");
    await expect(toggleButton).toHaveAttribute("aria-pressed", "true");
  },
);

buttonBehaviorCase(
  { case_id: "params-toggle-headless", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const toggleSelector = selectorForCase("params-toggle-headless");
    const checkbox = page.getByLabel("Run browser headlessly");

    await expect(page.locator(toggleSelector)).toHaveCount(1);
    await checkbox.scrollIntoViewIfNeeded();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  },
);

buttonBehaviorCase(
  { case_id: "params-toggle-midscene-strict", assertion_type: "attribute-change" },
  async ({ page }) => {
    await bootstrapButtonBehaviorApp(page);
    const toggleSelector = selectorForCase("params-toggle-midscene-strict");
    const checkbox = page.getByLabel("Use strict page element matching (Midscene Strict)");

    await expect(page.locator(toggleSelector)).toHaveCount(1);
    await checkbox.scrollIntoViewIfNeeded();
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  },
);
