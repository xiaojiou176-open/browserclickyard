import type { Page } from "playwright";
import { AUTOMATION_ENV } from "./lib/env.js";

type MidsceneTakeoverContext = {
  page: Page;
  startUrl: string;
  suggestedEmail: string;
  suggestedPassword: string;
  successSelector: string;
};

export async function runMidsceneTakeover(context: MidsceneTakeoverContext): Promise<void> {
  const { page, startUrl, suggestedEmail, suggestedPassword, successSelector } = context;

  const strictMidscene = AUTOMATION_ENV.MIDSCENE_STRICT !== "false";
  const allowFallback = AUTOMATION_ENV.MIDSCENE_ALLOW_FALLBACK === "true";
  const hasMidsceneModelConfig =
    Boolean(process.env.MIDSCENE_MODEL_NAME) || Boolean(process.env.GEMINI_API_KEY);

  if (hasMidsceneModelConfig) {
    try {
      // Keep runtime import path intact while avoiding compile-time hard failure
      // when automation workspace dependencies are not installed locally.
      const midsceneModule = (await import("@midscene/web" + "/playwright")) as {
        PlaywrightAgent: new (
          pageInstance: Page,
        ) => {
          aiAct: (instruction: string) => Promise<unknown>;
        };
      };

      const agent = new midsceneModule.PlaywrightAgent(page);
      await page.goto(startUrl, { waitUntil: "networkidle" });
      await agent.aiAct(`Fill the Email field with: ${suggestedEmail}`);
      await agent.aiAct(`Fill the Password field with: ${suggestedPassword}`);
      await agent.aiAct("Click the Create Account button");
      if (successSelector.trim()) {
        await page.waitForSelector(successSelector, { timeout: 30_000 });
      }
      return;
    } catch (error) {
      if (strictMidscene || !allowFallback) {
        throw error;
      }
      process.stderr.write(
        `[midscene-driver] Midscene AI action failed, fallback to deterministic Playwright. ${String(error)}\n`,
      );
    }
  } else if (strictMidscene || !allowFallback) {
    throw new Error("GEMINI_API_KEY is required");
  }

  // Fallback path keeps the pipeline executable without model credentials.
  await page.goto(startUrl, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(suggestedEmail);
  await page.getByLabel("Password").fill(suggestedPassword);
  await page.getByRole("button", { name: "Create Account" }).click();
  if (successSelector.trim()) {
    await page.waitForSelector(successSelector, { timeout: 15_000 });
  }
}
