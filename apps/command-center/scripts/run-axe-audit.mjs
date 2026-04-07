import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const targetUrl = process.argv[2];
if (!targetUrl) {
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(scriptDir, "..", "..", ".runtime-cache");
const reportPath = `${runtimeDir}/axe.report.json`;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (item) => item.impact === "critical" || item.impact === "serious",
  );

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ...results, violations }, null, 2), "utf8");

  if (violations.length > 0) {
    process.exit(1);
  }
} finally {
  await context.close();
  await browser.close();
}
