#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const ROOT = process.cwd();
const MANIFEST_FILE = resolve(ROOT, "apps/command-center/src/testing/button-manifest.ts");

const SCAN_ROOTS = {
  frontend: [
    resolve(ROOT, "apps/command-center/src/components"),
    resolve(ROOT, "apps/command-center/src/views"),
    resolve(ROOT, "apps/command-center/src/constants"),
    resolve(ROOT, "apps/command-center/src/App.tsx"),
  ],
  "tests/web-harness": [resolve(ROOT, "tests/web-harness/src/components"), resolve(ROOT, "tests/web-harness/src/pages")],
};

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".runtime-cache",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".next",
  ".turbo",
]);

const ALLOWED_COMPONENT_SOURCES = new Set(["frontend", "tests/web-harness"]);
const INTERACTIVE_SELECTOR_PREFIXES = ["data-testid=", "aria-label="];

function toRelative(inputPath) {
  return inputPath.replace(`${ROOT}/`, "");
}

function isRuntimeSourceFile(filePath) {
  const normalized = filePath.toLowerCase();
  if (
    normalized.includes(".test.") ||
    normalized.includes(".spec.") ||
    normalized.includes(".stories.")
  ) {
    return false;
  }
  return true;
}

function collectFiles(inputPath) {
  if (!existsSync(inputPath)) {
    return [];
  }
  const info = statSync(inputPath);
  if (info.isFile()) {
    return CODE_EXTENSIONS.has(extname(inputPath)) && isRuntimeSourceFile(inputPath)
      ? [inputPath]
      : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const files = [];
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        stack.push(nextPath);
        continue;
      }
      if (
        entry.isFile() &&
        CODE_EXTENSIONS.has(extname(entry.name).toLowerCase()) &&
        isRuntimeSourceFile(nextPath)
      ) {
        files.push(nextPath);
      }
    }
  }
  return files;
}

function readStringField(block, fieldName) {
  const pattern = new RegExp(`${fieldName}\\s*:\\s*(['"])(.*?)\\1`, "s");
  const match = block.match(pattern);
  return match ? match[2].trim() : "";
}

function parseManifestEntries(source) {
  const arrayMatch = source.match(
    /export const\s+BUTTON_BEHAVIOR_MANIFEST\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!arrayMatch) {
    throw new Error("BUTTON_BEHAVIOR_MANIFEST not found.");
  }

  const objectPattern = /\{([\s\S]*?)\}/g;
  const entries = [];
  let objectMatch = objectPattern.exec(arrayMatch[1]);
  while (objectMatch) {
    const block = objectMatch[1];
    if (!block.includes("id:")) {
      objectMatch = objectPattern.exec(arrayMatch[1]);
      continue;
    }
    entries.push({
      id: readStringField(block, "id"),
      component_source: readStringField(block, "component_source"),
      selector: readStringField(block, "selector"),
      coverage_scope: readStringField(block, "coverage_scope"),
    });
    objectMatch = objectPattern.exec(arrayMatch[1]);
  }

  if (entries.length === 0) {
    throw new Error("No manifest entries parsed.");
  }
  return entries;
}

function readStaticAttr(attrs, attrName) {
  const pattern = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = attrs.match(pattern);
  return String(match?.[1] ?? match?.[2] ?? "").trim();
}

function readStringLiteralsFromExpr(attrs, attrName) {
  const exprPattern = new RegExp(`${attrName}\\s*=\\s*\\{([^}]+)\\}`, "i");
  const exprMatch = attrs.match(exprPattern);
  if (!exprMatch) {
    return [];
  }
  const literals = [];
  const literalPattern = /(['"])(.*?)\1/g;
  let literalMatch = literalPattern.exec(exprMatch[1]);
  while (literalMatch) {
    const value = String(literalMatch[2] || "").trim();
    if (value) {
      literals.push(value);
    }
    literalMatch = literalPattern.exec(exprMatch[1]);
  }
  return literals;
}

function buildSelectorRecords(filePath, source) {
  const selectors = [];

  const clickablePattern = /<(button|Button|a|NavLink)\b([^>]*?)>/g;
  let clickableMatch = clickablePattern.exec(source);
  while (clickableMatch) {
    const tag = clickableMatch[1];
    const attrs = clickableMatch[2];
    const testId = readStaticAttr(attrs, "data-testid");
    const ariaLabel = readStaticAttr(attrs, "aria-label");
    const dynamicTestIds = readStringLiteralsFromExpr(attrs, "data-testid");
    const dynamicAriaLabels = readStringLiteralsFromExpr(attrs, "aria-label");
    const href = readStaticAttr(attrs, "href");
    const to = readStaticAttr(attrs, "to");
    const interactive =
      tag === "button" || tag === "Button" || tag === "NavLink" || Boolean(href || to);

    if (interactive) {
      if (testId) {
        selectors.push({ selector: `data-testid=${testId}`, file: filePath });
      }
      const hasTestId = Boolean(testId || dynamicTestIds.length > 0);
      if (!hasTestId && ariaLabel) {
        selectors.push({ selector: `aria-label=${ariaLabel}`, file: filePath });
      }
      for (const value of dynamicTestIds) {
        selectors.push({ selector: `data-testid=${value}`, file: filePath });
      }
      for (const value of hasTestId ? [] : dynamicAriaLabels) {
        selectors.push({ selector: `aria-label=${value}`, file: filePath });
      }
    }
    clickableMatch = clickablePattern.exec(source);
  }

  const inputPattern = /<input\b([^>]*?)\/?>/g;
  let inputMatch = inputPattern.exec(source);
  while (inputMatch) {
    const attrs = inputMatch[1];
    const type = readStaticAttr(attrs, "type").toLowerCase();
    if (type === "button" || type === "submit") {
      const testId = readStaticAttr(attrs, "data-testid");
      const ariaLabel = readStaticAttr(attrs, "aria-label");
      if (testId) {
        selectors.push({ selector: `data-testid=${testId}`, file: filePath });
      }
      if (ariaLabel) {
        selectors.push({ selector: `aria-label=${ariaLabel}`, file: filePath });
      }
    }
    inputMatch = inputPattern.exec(source);
  }

  return selectors;
}

function isInteractiveSelector(selector) {
  return INTERACTIVE_SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix));
}

function selectorMatches(manifestSelector, sourceSelector) {
  if (manifestSelector === sourceSelector) {
    return true;
  }
  const startsWithMatch = manifestSelector.match(/^role=([a-zA-Z-]+)\[name\^="(.+)"\]$/);
  if (!startsWithMatch) {
    return false;
  }
  const role = startsWithMatch[1];
  const prefix = startsWithMatch[2];
  const exactMatch = sourceSelector.match(new RegExp(`^role=${role}\\[name="(.+)"\\]$`));
  return Boolean(exactMatch?.[1]?.startsWith(prefix));
}

function fallbackSelectorPresence(selector, allSourceText) {
  if (selector.startsWith("role=")) {
    const roleNameMatch = selector.match(/^role=(?:button|tab)\[name(?:\^)?="(.+)"\]$/);
    if (roleNameMatch) {
      return allSourceText.includes(roleNameMatch[1]);
    }
  }
  if (selector.startsWith("data-testid=") || selector.startsWith("aria-label=")) {
    const value = selector.split("=")[1] ?? "";
    return allSourceText.includes(value);
  }
  return false;
}

function main() {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`[button-inventory] missing manifest: ${toRelative(MANIFEST_FILE)}`);
    process.exit(2);
  }

  const manifestSource = readFileSync(MANIFEST_FILE, "utf8");
  const manifestEntries = parseManifestEntries(manifestSource);

  const manifestErrors = [];
  for (const entry of manifestEntries) {
    if (!entry.id || !entry.selector || !entry.component_source || !entry.coverage_scope) {
      manifestErrors.push(
        `- invalid manifest entry: id=${entry.id || "unknown"} missing required fields`,
      );
    }
    if (!ALLOWED_COMPONENT_SOURCES.has(entry.component_source)) {
      manifestErrors.push(
        `- invalid component_source: ${entry.id || "unknown"} -> ${entry.component_source}`,
      );
    }
  }
  if (manifestErrors.length > 0) {
    console.error("[button-inventory] manifest schema errors:");
    for (const error of manifestErrors) {
      console.error(error);
    }
    process.exit(1);
  }

  const sourceSelectors = new Map();
  const mergedSourceText = new Map();

  for (const [componentSource, roots] of Object.entries(SCAN_ROOTS)) {
    const files = roots.flatMap((root) => collectFiles(root));
    const records = [];
    const merged = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      merged.push(text);
      records.push(...buildSelectorRecords(file, text));
    }
    sourceSelectors.set(componentSource, records);
    mergedSourceText.set(componentSource, merged.join("\n"));
  }

  const missingInSource = [];
  for (const entry of manifestEntries) {
    const records = sourceSelectors.get(entry.component_source) ?? [];
    const matched = records.some((record) => selectorMatches(entry.selector, record.selector));
    if (matched) {
      continue;
    }
    const sourceText = mergedSourceText.get(entry.component_source) ?? "";
    if (fallbackSelectorPresence(entry.selector, sourceText)) {
      continue;
    }
    missingInSource.push(entry);
  }

  const manifestSelectorSet = new Set(manifestEntries.map((entry) => entry.selector));
  const missingInManifest = [];
  for (const [componentSource, records] of sourceSelectors.entries()) {
    for (const record of records) {
      if (!isInteractiveSelector(record.selector)) {
        continue;
      }
      if (manifestSelectorSet.has(record.selector)) {
        continue;
      }
      missingInManifest.push({
        component_source: componentSource,
        selector: record.selector,
        file: toRelative(record.file),
      });
    }
  }

  const dedupMissingInManifest = Array.from(
    new Map(
      missingInManifest.map((item) => [`${item.component_source}::${item.selector}`, item]),
    ).values(),
  );

  if (missingInSource.length > 0) {
    console.error("[button-inventory] manifest selector missing in source:");
    for (const entry of missingInSource) {
      console.error(`- ${entry.id} (${entry.component_source}) -> ${entry.selector}`);
    }
  }

  if (dedupMissingInManifest.length > 0) {
    console.error("[button-inventory] source selector missing in manifest:");
    for (const item of dedupMissingInManifest) {
      console.error(`- ${item.component_source}: ${item.selector} (${item.file})`);
    }
  }

  if (missingInSource.length > 0 || dedupMissingInManifest.length > 0) {
    process.exit(1);
  }

  console.log("[button-inventory] passed");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[button-inventory] fatal: ${message}`);
  process.exit(2);
}
