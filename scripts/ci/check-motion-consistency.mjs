#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET_FILE = "apps/command-center/src/styles.css";
const TARGET_PATH = resolve(process.cwd(), TARGET_FILE);
const MAX_DURATION_MS = 500;
const MOTION_TOKEN_PATTERN = /var\(--motion-duration-[\w-]+\)|var\(--transition\)/;
const DIFF_DURATION_PATTERN = /(\d*\.?\d+)(ms|s)\b/g;

const KEY_SELECTORS = [
  ".console-root.motion-enter-page",
  ".stat-badge",
  ".view-container.motion-enter-content",
  ".toast-item",
  ".tour-dot",
  ".command-card",
  ".task-item",
  ".template-card",
];

const REDUCED_MOTION_MARKERS = [
  ".motion-enter-page",
  ".motion-enter-content",
  ".toast-item",
  ".dialog-overlay",
  ".dialog-box",
  ".tour-popover",
  ".help-panel",
  ".help-section",
];

function toMs(rawValue, unit) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return unit === "s" ? numeric * 1000 : numeric;
}

function readGitDiff(args) {
  try {
    return execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

function getAddedDiffLines() {
  const stagedDiff = readGitDiff([
    "diff",
    "--cached",
    "--unified=0",
    "--no-color",
    "--",
    TARGET_FILE,
  ]);

  if (!stagedDiff.trim()) {
    return [];
  }

  return stagedDiff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function findRuleBlock(css, selector) {
  const selectorIndex = css.indexOf(`${selector} {`);
  if (selectorIndex < 0) {
    return "";
  }
  const blockStart = css.indexOf("{", selectorIndex);
  if (blockStart < 0) {
    return "";
  }

  let depth = 0;
  for (let i = blockStart; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
      continue;
    }
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(blockStart + 1, i);
      }
    }
  }
  return "";
}

function findMediaBlock(css, mediaQuery) {
  const marker = `@media (${mediaQuery})`;
  const markerIndex = css.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  const blockStart = css.indexOf("{", markerIndex);
  if (blockStart < 0) {
    return "";
  }

  let depth = 0;
  for (let i = blockStart; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
      continue;
    }
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(blockStart + 1, i);
      }
    }
  }
  return "";
}

function main() {
  if (!existsSync(TARGET_PATH)) {
    process.stderr.write(`[motion-consistency] missing target file: ${TARGET_FILE}\n`);
    process.exit(1);
  }

  const errors = [];
  const css = readFileSync(TARGET_PATH, "utf8");

  const addedLines = getAddedDiffLines();
  for (const line of addedLines) {
    if (!/\b(animation|transition)(?:-[\w-]+)?\b/i.test(line)) {
      continue;
    }
    let match = DIFF_DURATION_PATTERN.exec(line);
    while (match) {
      const durationMs = toMs(match[1], match[2]);
      if (durationMs > MAX_DURATION_MS) {
        errors.push(
          `new duration exceeds ${MAX_DURATION_MS}ms in ${TARGET_FILE}: "${line.trim()}" (${durationMs}ms)`,
        );
      }
      match = DIFF_DURATION_PATTERN.exec(line);
    }
    DIFF_DURATION_PATTERN.lastIndex = 0;
  }

  for (const selector of KEY_SELECTORS) {
    const block = findRuleBlock(css, selector);
    if (!block) {
      errors.push(`missing key selector block: ${selector}`);
      continue;
    }

    const hasMotionDeclaration = /(animation|transition)\s*:[\s\S]*?;/.test(block);
    if (!hasMotionDeclaration) {
      errors.push(`selector has no animation/transition declaration: ${selector}`);
      continue;
    }

    if (!MOTION_TOKEN_PATTERN.test(block)) {
      errors.push(
        `selector does not reference motion token (var(--motion-duration-*) or var(--transition)): ${selector}`,
      );
    }
  }

  const reducedMotionBlock = findMediaBlock(css, "prefers-reduced-motion: reduce");
  if (!reducedMotionBlock) {
    errors.push("missing @media (prefers-reduced-motion: reduce) block");
  } else {
    for (const marker of REDUCED_MOTION_MARKERS) {
      if (!reducedMotionBlock.includes(marker)) {
        errors.push(`reduced-motion block missing required marker: ${marker}`);
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`[motion-consistency] failed with ${errors.length} issue(s)\n`);
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exit(1);
  }

  process.stdout.write("[motion-consistency] pass\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[motion-consistency] unexpected error: ${message}\n`);
  process.exit(1);
}
