#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const ROOT = process.cwd();
const MANIFEST_FILE = resolve(ROOT, "apps/command-center/src/testing/button-manifest.ts");
const TEST_ROOTS = [
  resolve(ROOT, "tests/frontend-e2e"),
  resolve(ROOT, "apps/command-center/tests/e2e"),
  resolve(ROOT, "tests/web-harness/tests/e2e"),
  resolve(ROOT, "tests/web-harness/tests/ct"),
];
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
]);
const WEAK_ASSERTION_PATTERNS = [
  /\btoBeTruthy\s*\(/g,
  /\btoBe\s*\(\s*true\s*\)/g,
  /\btoBe\s*\(\s*false\s*\)/g,
  /\btoEqual\s*\(\s*true\s*\)/g,
  /\btoEqual\s*\(\s*false\s*\)/g,
];
const ALLOWED_CRITICALITY = new Set(["critical", "high", "medium"]);
const ALLOWED_COVERAGE_SCOPE = new Set(["behavior-gated", "inventory-only"]);

function collectFiles(inputPath) {
  if (!existsSync(inputPath)) {
    return [];
  }
  const info = statSync(inputPath);
  if (info.isFile()) {
    return [inputPath];
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
      if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(nextPath);
      }
    }
  }
  return files;
}

function toRelative(inputPath) {
  return inputPath.replace(`${ROOT}/`, "");
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
    throw new Error(
      "apps/command-center/src/testing/button-manifest.ts is missing the BUTTON_BEHAVIOR_MANIFEST export.",
    );
  }

  const objectPattern = /\{([\s\S]*?)\}/g;
  const entries = [];
  let objectMatch = objectPattern.exec(arrayMatch[1]);
  while (objectMatch) {
    const block = objectMatch[1];
    if (block.includes("id:")) {
      const entry = {
        id: readStringField(block, "id"),
        view: readStringField(block, "view"),
        selector: readStringField(block, "selector"),
        criticality: readStringField(block, "criticality"),
        coverage_scope: readStringField(block, "coverage_scope"),
        expected_effect: readStringField(block, "expected_effect"),
        assertion_type: readStringField(block, "assertion_type"),
        case_id: readStringField(block, "case_id"),
      };
      entries.push(entry);
    }
    objectMatch = objectPattern.exec(arrayMatch[1]);
  }

  if (entries.length === 0) {
    throw new Error("BUTTON_BEHAVIOR_MANIFEST must not be empty.");
  }
  return entries;
}

function validateManifestEntries(entries) {
  const errors = [];
  const idSeen = new Set();
  const caseSeen = new Set();

  for (const entry of entries) {
    const missingFields = [
      "id",
      "view",
      "selector",
      "criticality",
      "coverage_scope",
      "expected_effect",
    ].filter((key) => !entry[key]);
    if (missingFields.length > 0) {
      errors.push(
        `- manifest entry is missing required fields: ${missingFields.join(", ")} (id=${entry.id || "unknown"})`,
      );
      continue;
    }

    if (!ALLOWED_CRITICALITY.has(entry.criticality)) {
      errors.push(`- manifest entry has invalid criticality: ${entry.id} -> ${entry.criticality}`);
    }
    if (!ALLOWED_COVERAGE_SCOPE.has(entry.coverage_scope)) {
      errors.push(`- manifest entry has invalid coverage_scope: ${entry.id} -> ${entry.coverage_scope}`);
    }
    if (idSeen.has(entry.id)) {
      errors.push(`- manifest entry has duplicate id: ${entry.id}`);
    }
    if (entry.coverage_scope === "behavior-gated") {
      if (!entry.case_id || !entry.assertion_type) {
        errors.push(`- behavior-gated entries must define case_id and assertion_type: ${entry.id}`);
      } else if (caseSeen.has(entry.case_id)) {
        errors.push(`- manifest entry has duplicate case_id: ${entry.case_id}`);
      }
    }

    idSeen.add(entry.id);
    if (entry.case_id) {
      caseSeen.add(entry.case_id);
    }
  }

  return errors;
}

function checkWeakAssertions(testFiles) {
  const findings = [];
  for (const file of testFiles) {
    const source = readFileSync(file, "utf8");
    for (const pattern of WEAK_ASSERTION_PATTERNS) {
      const hasWeakAssertion = pattern.test(source);
      pattern.lastIndex = 0;
      if (hasWeakAssertion) {
        findings.push(`- ${toRelative(file)} contains a weak assertion: ${pattern}`);
      }
    }
  }
  return findings;
}

function isButtonCoverageSpec(file) {
  const relativePath = toRelative(file);
  return (
    relativePath.endsWith("tests/frontend-e2e/critical-buttons.spec.ts") ||
    relativePath.includes("tests/frontend-e2e/button-behavior.")
  );
}

function resolveWeakAssertionScope(testFiles) {
  const markerPattern = /\bbuttonBehaviorCase\s*\(/;
  const scopedFiles = [];
  for (const file of testFiles) {
    if (isButtonCoverageSpec(file)) {
      scopedFiles.push(file);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (markerPattern.test(source)) {
      scopedFiles.push(file);
    }
  }
  return scopedFiles.length > 0 ? scopedFiles : testFiles;
}

function collectCaseMarkers(testFiles) {
  const markerPattern =
    /buttonBehaviorCase\s*\(\s*\{\s*case_id\s*:\s*['"]([^'"]+)['"]\s*,\s*assertion_type\s*:\s*['"]([^'"]+)['"]/gs;
  const caseMap = new Map();
  const markerErrors = [];

  for (const file of testFiles) {
    const source = readFileSync(file, "utf8");
    let markerMatch = markerPattern.exec(source);
    while (markerMatch) {
      const caseId = markerMatch[1];
      const assertionType = markerMatch[2];
      if (!caseMap.has(caseId)) {
        caseMap.set(caseId, {
          assertionType,
          files: new Set([file]),
        });
      } else {
        const current = caseMap.get(caseId);
        current.files.add(file);
        if (current.assertionType !== assertionType) {
          markerErrors.push(
            `- case_id ${caseId} has inconsistent assertion_type values: ${current.assertionType} vs ${assertionType} (${toRelative(file)})`,
          );
        }
      }
      markerMatch = markerPattern.exec(source);
    }
  }

  return { caseMap, markerErrors };
}

function readArgValue(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index < 0) {
    return "";
  }
  return process.argv[index + 1] ?? "";
}

function runManifestLint() {
  if (!existsSync(MANIFEST_FILE)) {
    process.exit(2);
  }

  const source = readFileSync(MANIFEST_FILE, "utf8");
  const entries = parseManifestEntries(source);
  const manifestErrors = validateManifestEntries(entries);
  if (manifestErrors.length > 0) {
    console.error("[button-coverage] manifest-lint failed:");
    for (const error of manifestErrors) {
      console.error(error);
    }
    process.exit(1);
  }
}

function runCoverageGate() {
  const source = readFileSync(MANIFEST_FILE, "utf8");
  const entries = parseManifestEntries(source);

  const manifestErrors = validateManifestEntries(entries);
  if (manifestErrors.length > 0) {
    console.error("[button-coverage] manifest validation failed:");
    for (const error of manifestErrors) {
      console.error(error);
    }
    process.exit(1);
  }

  const testFiles = TEST_ROOTS.flatMap((dir) => collectFiles(dir));
  if (testFiles.length === 0) {
    process.exit(2);
  }

  const weakAssertionFiles = resolveWeakAssertionScope(testFiles);
  const weakAssertionFindings = checkWeakAssertions(weakAssertionFiles);
  if (weakAssertionFindings.length > 0) {
    console.error("[button-coverage] weak assertions found:");
    for (const finding of weakAssertionFindings) {
      console.error(finding);
    }
    process.exit(1);
  }

  const { caseMap, markerErrors } = collectCaseMarkers(testFiles);
  if (markerErrors.length > 0) {
    console.error("[button-coverage] case marker errors:");
    for (const error of markerErrors) {
      console.error(error);
    }
    process.exit(1);
  }

  const behaviorEntries = entries.filter((entry) => entry.coverage_scope === "behavior-gated");
  const missingCaseIds = [];
  const assertionTypeMismatch = [];
  for (const entry of behaviorEntries) {
    const marker = caseMap.get(entry.case_id);
    if (!marker) {
      missingCaseIds.push(entry);
      continue;
    }
    if (!marker.assertionType) {
      assertionTypeMismatch.push(`- ${entry.case_id}: missing assertion_type`);
      continue;
    }
    if (marker.assertionType !== entry.assertion_type) {
      assertionTypeMismatch.push(
        `- ${entry.case_id}: manifest=${entry.assertion_type}, tests=${marker.assertionType}`,
      );
    }
  }

  if (missingCaseIds.length > 0) {
    console.error("[button-coverage] missing case coverage:");
    for (const item of missingCaseIds) {
      console.error(`- missing case_id: ${item.case_id} (${item.id})`);
    }
    process.exit(1);
  }

  if (assertionTypeMismatch.length > 0) {
    console.error("[button-coverage] assertion_type mismatch:");
    for (const mismatch of assertionTypeMismatch) {
      console.error(mismatch);
    }
    process.exit(1);
  }
}

function main() {
  const mode = readArgValue("--mode") || "coverage";

  if (!existsSync(MANIFEST_FILE)) {
    process.exit(2);
  }

  if (mode === "manifest-lint") {
    runManifestLint();
    return;
  }

  runCoverageGate();
}

main();
