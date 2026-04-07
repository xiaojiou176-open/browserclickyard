// @ts-nocheck
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";

export const CAPTURE_PROBE_ID = "capture";

export type ProbeCaptureArtifacts = {
  screenshot: string;
  dom: string;
};

export async function capturePageArtifacts(
  page: Page,
  baseDir: string,
  stateId: string,
): Promise<ProbeCaptureArtifacts> {
  const screenshot = `screenshots/${stateId}.png`;
  const dom = `logs/dom-${stateId}.html`;
  await page.screenshot({ path: resolve(baseDir, screenshot), fullPage: true });
  const html = await page.content();
  writeFileSync(resolve(baseDir, dom), html, "utf8");
  return { screenshot, dom };
}
