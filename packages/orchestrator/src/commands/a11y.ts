import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import { waitForPageSettled } from "./page-stability.js";

export type A11yConfig = {
  baseUrl: string;
  standard: "wcag2a" | "wcag2aa" | "wcag2aaa";
  maxIssues: number;
  engine?: "axe" | "builtin";
};

export type A11yIssue = {
  id: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  message: string;
  selector: string;
  evidence: string;
};

export type A11yResult = {
  engine: "axe-core-playwright" | "builtin-dom-a11y";
  standard: A11yConfig["standard"];
  url: string;
  scannedAt: string;
  counts: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  issues: A11yIssue[];
  reportPath: string;
  fallbackUsed?: boolean;
};

type AxeViolationNode = {
  target: string[];
  html: string;
};

type AxeViolation = {
  id: string;
  impact?: string | null;
  description: string;
  nodes: AxeViolationNode[];
};

type AxeAnalyzeResult = {
  violations: AxeViolation[];
};
const DETERMINISTIC_TIMEZONE = "UTC";
const DETERMINISTIC_LOCALE = "en-US";
const DETERMINISTIC_SEED = 20260218;

async function enableDeterministicMode(
  page: import("playwright").Page,
  seed: number,
): Promise<void> {
  await page.addInitScript(
    ({ seeded }) => {
      let state = seeded >>> 0 || 1;
      Math.random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
      window.localStorage.setItem("ab_onboarding_done", "1");
    },
    { seeded: seed },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function stabilizeAnimations(page: import("playwright").Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important;}html{scroll-behavior:auto !important;}`,
  });
}

const A11Y_SCAN_SCRIPT = `
(() => {
  const issues = [];

  const pushIssue = (severity, id, message, element) => {
    const selector = element && element.tagName
      ? [element.tagName.toLowerCase(), element.id ? '#' + element.id : '', element.className ? '.' + String(element.className).split(/s+/).filter(Boolean).slice(0, 2).join('.') : ''].join('')
      : 'unknown';
    const evidence = element && element.outerHTML ? element.outerHTML.slice(0, 240) : '';
    issues.push({ severity, id, message, selector, evidence });
  };

  document.querySelectorAll('img').forEach((el) => {
    const alt = el.getAttribute('alt');
    if (alt === null || alt.trim() === '') {
      pushIssue('serious', 'image-alt', 'Image missing meaningful alt text', el);
    }
  });

  const interactive = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [tabindex]'));
  interactive.forEach((el) => {
    const hidden = el.getAttribute('aria-hidden') === 'true' || (el instanceof HTMLElement && el.offsetParent === null);
    if (hidden) return;

    const name = [
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.textContent || '',
      (el instanceof HTMLInputElement && el.value) ? el.value : ''
    ].join(' ').trim();

    if (!name) {
      pushIssue('serious', 'interactive-name', 'Interactive element missing accessible name', el);
    }
  });

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    const id = el.getAttribute('id');
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    const ariaLabel = el.getAttribute('aria-label');
    const hasLabel = Boolean(
      ariaLabel ||
      ariaLabelledBy ||
      (id && document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]'))
    );
    if (!hasLabel) {
      pushIssue('moderate', 'form-label', 'Form control missing associated label', el);
    }
  });

  return issues;
})();
`;

function countIssues(issues: A11yIssue[]): A11yResult["counts"] {
  return {
    critical: issues.filter((i) => i.severity === "critical").length,
    serious: issues.filter((i) => i.severity === "serious").length,
    moderate: issues.filter((i) => i.severity === "moderate").length,
    minor: issues.filter((i) => i.severity === "minor").length,
    total: issues.length,
  };
}

async function runBuiltinScan(
  page: import("playwright").Page,
  maxIssues: number,
): Promise<A11yIssue[]> {
  const rawIssues = (await page.evaluate(A11Y_SCAN_SCRIPT)) as A11yIssue[];
  return rawIssues.slice(0, Math.max(1, maxIssues));
}

export async function runA11y(baseDir: string, config: A11yConfig): Promise<A11yResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: DETERMINISTIC_TIMEZONE,
    locale: DETERMINISTIC_LOCALE,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const page = await context.newPage();
  await enableDeterministicMode(page, DETERMINISTIC_SEED);

  try {
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await stabilizeAnimations(page);
    await waitForPageSettled(page);

    let engine: A11yResult["engine"] = "axe-core-playwright";
    let fallbackUsed = false;
    let issues: A11yIssue[] = [];

    if ((config.engine ?? "axe") === "axe") {
      try {
        const axe = (await new AxeBuilder({ page })
          .withTags([config.standard])
          .analyze()) as AxeAnalyzeResult;
        issues = axe.violations
          .flatMap((violation: AxeViolation) =>
            violation.nodes.map((node: AxeViolationNode) => ({
              id: violation.id,
              severity: (violation.impact ?? "minor") as A11yIssue["severity"],
              message: violation.description,
              selector: node.target.join(", "),
              evidence: node.html.slice(0, 240),
            })),
          )
          .slice(0, Math.max(1, config.maxIssues));
      } catch {
        fallbackUsed = true;
        engine = "builtin-dom-a11y";
        issues = await runBuiltinScan(page, config.maxIssues);
      }
    } else {
      fallbackUsed = false;
      engine = "builtin-dom-a11y";
      issues = await runBuiltinScan(page, config.maxIssues);
    }

    const result: A11yResult = {
      engine,
      standard: config.standard,
      url: page.url(),
      scannedAt: new Date().toISOString(),
      counts: countIssues(issues),
      issues,
      reportPath: "a11y/axe.json",
      fallbackUsed,
    };

    const reportAbsPath = resolve(baseDir, result.reportPath);
    mkdirSync(dirname(reportAbsPath), { recursive: true });
    writeFileSync(reportAbsPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}
