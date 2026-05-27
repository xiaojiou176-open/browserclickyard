import { expect, type Page, test } from "@playwright/test";

async function step1OpenHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-title")).toContainText("Pagestress Demo");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
}

async function step2CompleteFirstInteraction(page: Page) {
  await page.getByTestId("counter-inc").click();
  await expect(page.getByTestId("counter-value")).toHaveText("1");
}

async function step3SubmitFirstFeedback(page: Page) {
  await page.getByTestId("nav-contact").click();
  await expect(page.getByTestId("nav-contact")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("feedback-form")).toBeVisible();
  await expect(page.getByTestId("feedback-submit")).toHaveAttribute("type", "submit");
  await page.getByTestId("feedback-name").fill("Alex");
  await page.getByTestId("feedback-message").fill("This is a valid message.");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText("Feedback submitted.");
  await expect(page.getByTestId("feedback-result")).toHaveAttribute("role", "status");
}

async function step3RecoverFromInvalidFeedbackAndRerun(page: Page) {
  await page.getByTestId("nav-contact").click();
  await expect(page.getByTestId("feedback-form")).toBeVisible();
  await page.getByTestId("feedback-name").fill("A");
  await page.getByTestId("feedback-message").fill("short");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText(
    "Name must contain at least 2 characters.",
  );
  await page.getByTestId("feedback-name").fill("Alex");
  await page.getByTestId("feedback-message").fill("Recovered by correcting config.");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText("Feedback submitted.");
}

async function step3WaitForRequiredUserInput(page: Page) {
  await page.getByTestId("nav-contact").click();
  await expect(page.getByTestId("feedback-form")).toBeVisible();
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText(
    "Name must contain at least 2 characters.",
  );
  await page.getByTestId("feedback-name").fill("Alex");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText(
    "Message must contain at least 8 characters.",
  );
  await page.getByTestId("feedback-message").fill("User input is now complete.");
  await page.getByTestId("feedback-submit").click();
  await expect(page.getByTestId("feedback-result")).toHaveText("Feedback submitted.");
}

test("@smoke core routes and interactions", async ({ page }) => {
  await step1OpenHome(page);
  await step2CompleteFirstInteraction(page);
  await step3SubmitFirstFeedback(page);
});

test("@smoke first-use config error recovery rerun", async ({ page }) => {
  await step1OpenHome(page);
  await step2CompleteFirstInteraction(page);
  await step3RecoverFromInvalidFeedbackAndRerun(page);
});

test("@smoke first-use waits for required user input", async ({ page }) => {
  await step1OpenHome(page);
  await step2CompleteFirstInteraction(page);
  await step3WaitForRequiredUserInput(page);
});
