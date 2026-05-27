import { resolve } from "node:path";
import { chromium } from "playwright";

export const WEB_PLAYWRIGHT_DRIVER_ID = "web-playwright";

export type WebNavigateResult = {
  finalUrl: string;
  title: string;
  screenshotPath: string;
};

export async function navigateAndScreenshot(
  baseDir: string,
  baseUrl: string,
  outputRelativePath = "screenshots/driver-web-home.png",
): Promise<WebNavigateResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 20000 });
    await page.screenshot({ path: resolve(baseDir, outputRelativePath), fullPage: true });
    return {
      finalUrl: page.url(),
      title: await page.title(),
      screenshotPath: outputRelativePath,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
