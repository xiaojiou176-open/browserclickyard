#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const outputPrefix = "uiq-test-truth-gate";
const DEFAULT_OUT_DIR = ".runtime-cache/artifacts/ci";
const DEFAULT_ROOTS = [
  "tests/web-harness",
  "services/mcp-server",
  "automation",
  "frontend",
  "playwright",
  "packages",
  "scripts",
  "tests",
  "services/mcp-server/tests",
  "packages/orchestrator/src/commands",
];
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

const REASON_CODE = {
  passed: "gate.test_truthiness.passed.no_weak_patterns",
  failed: "gate.test_truthiness.failed.weak_patterns_detected",
  blocked: "gate.test_truthiness.blocked.no_test_files",
};
const WEAK_ASSERTION_ALLOW_MARKER = "uiq-allow-weak-assertion";

const INTERACTION_KEYWORDS = [
  "click(",
  "fill(",
  "type(",
  "press(",
  "selectOption(",
  "check(",
  "uncheck(",
  "dragTo(",
];

const CONDITIONAL_ASSERTION_PATTERNS = [
  /\bif\s*\([^)]*\)\s*{[^{}]*\bexpect\s*\(/s,
  /\bif\s*\([^)]*\)\s*\bexpect\s*\(/s,
];

const PLAYWRIGHT_INTERACTION_PATTERN =
  /\.(?:click|fill|type|press|goto|waitFor|waitForURL|waitForResponse|waitForSelector|check|uncheck|hover|dblclick|tap|dragTo|selectOption)\s*\(/;
const PLAYWRIGHT_IMPORT_PATTERN =
  /from\s+['"]@playwright\/test['"]|require\(\s*['"]@playwright\/test['"]\s*\)/;

function extractAssignedIdentifier(line) {
  const match = line.match(
    /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*.*\.(?:click|fill|type|press|goto|waitFor|waitForURL|waitForResponse|waitForSelector|check|uncheck|hover|dblclick|tap|dragTo|selectOption)\s*\(/,
  );
  return match?.[1] ?? "";
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function hasDeferredAwait(lines, startIndex, identifier) {
  if (!identifier) {
    return false;
  }
  const escapedIdentifier = escapeRegExp(identifier);
  const awaitPattern = new RegExp(`\\bawait\\s+${escapedIdentifier}\\b`);
  const reassignmentPattern = new RegExp(
    `^\\s*(?:const|let|var)?\\s*${escapedIdentifier}\\s*=|^\\s*${escapedIdentifier}\\s*=`,
  );
  let statementEndIndex = startIndex;
  let parenBalance = 0;
  let sawOpeningParen = false;
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 80); index += 1) {
    const line = lines[index] ?? "";
    for (const char of line) {
      if (char === "(") {
        parenBalance += 1;
        sawOpeningParen = true;
      }
      if (char === ")") {
        parenBalance -= 1;
      }
    }
    statementEndIndex = index;
    if (sawOpeningParen && parenBalance <= 0 && /;\s*$/.test(line.trim())) {
      break;
    }
  }

  for (
    let index = statementEndIndex + 1;
    index < Math.min(lines.length, statementEndIndex + 80);
    index += 1
  ) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (awaitPattern.test(line)) {
      return true;
    }
    if (reassignmentPattern.test(line)) {
      return false;
    }
    if (/^\s*(?:return|throw)\b/.test(line)) {
      return false;
    }
  }
  return false;
}

function parseBoolean(value, key) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid ${key}, expected true|false`);
}

function parsePathsCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseArgs(argv) {
  const options = {
    profile: "pr",
    strict: false,
    outDir: DEFAULT_OUT_DIR,
    paths: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--profile" && next) {
      options.profile = next;
    }
    if (token === "--strict" && next) {
      options.strict = parseBoolean(next, "--strict");
    }
    if (token === "--out-dir" && next) {
      options.outDir = next;
    }
    if (token === "--paths" && next) {
      options.paths = parsePathsCsv(next);
    }
  }
  if (!String(options.profile || "").trim()) {
    throw new Error("invalid --profile, expected non-empty value");
  }
  if (!String(options.outDir || "").trim()) {
    throw new Error("invalid --out-dir, expected non-empty value");
  }
  return options;
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

function isCodeFile(path) {
  return [".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts", ".py"].includes(
    extname(path).toLowerCase(),
  );
}

function isPythonFile(path) {
  return extname(path).toLowerCase() === ".py";
}

function isLikelyTestFile(path) {
  if (!isCodeFile(path)) {
    return false;
  }
  const normalized = normalizePath(path);
  const name = basename(normalized);
  if (isPythonFile(path)) {
    if (/^test_.*\.py$/i.test(name) || /^.*_test\.py$/i.test(name)) {
      return true;
    }
    if (/\/tests?\//i.test(normalized)) {
      return true;
    }
    return false;
  }
  if (
    /playwright\.config(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/i.test(name) ||
    /vitest\.config(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/i.test(name)
  ) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(name)) {
    return true;
  }
  if (/\/__tests__\//i.test(normalized)) {
    return true;
  }
  if (/\/tests?\//i.test(normalized) && !/config\.[cm]?[jt]sx?$/i.test(name)) {
    return true;
  }
  return false;
}

function collectFiles(inputPath) {
  const absPath = resolve(inputPath);
  if (!existsSync(absPath)) {
    return [];
  }
  const info = statSync(absPath);
  if (info.isFile()) {
    return [absPath];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const files = [];
  const stack = [absPath];
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
      if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }
  return files;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function lineTextAt(source, index) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndCandidate = source.indexOf("\n", index);
  const lineEnd = lineEndCandidate === -1 ? source.length : lineEndCandidate;
  return source.slice(lineStart, lineEnd);
}

function isWeakAssertionAllowlisted(source, index) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndCandidate = source.indexOf("\n", index);
  const lineEnd = lineEndCandidate === -1 ? source.length : lineEndCandidate;
  const line = source.slice(lineStart, lineEnd);
  return line.includes(WEAK_ASSERTION_ALLOW_MARKER);
}

function normalizeLiteralToken(token) {
  const raw = String(token || "").trim();
  if (/^(true|false|null|none|undefined|nan|infinity|-infinity)$/i.test(raw)) {
    return raw.toLowerCase();
  }
  if (/^-?(?:0|[1-9]\d*)n$/i.test(raw)) {
    return `bigint:${BigInt(raw.slice(0, -1)).toString()}`;
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    return String(Number(raw));
  }
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("`") && raw.endsWith("`"))
  ) {
    const inner = raw.slice(1, -1);
    return `str:${inner}`;
  }
  return raw;
}

function normalizePythonLiteralToken(token) {
  return normalizeLiteralToken(String(token || "").replace(/^r(?=['"`])|^f(?=['"`])/i, ""));
}

function findLiteralAssertionFindings(source, file) {
  const findings = [];
  const literal =
    "(?:true|false|null|undefined|NaN|Infinity|-Infinity|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:e[+-]?\\d+)?|-?(?:0|[1-9]\\d*)n|'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|`(?:[^`\\\\$]|\\\\.|\\$(?!\\{))*`)";
  const wrappedLiteral = `(?:\\(\\s*)*(${literal})(?:\\s*\\))*`;
  const matcher = "(?:toBe|toEqual|toStrictEqual)";
  const pattern = new RegExp(
    `expect\\s*\\(\\s*${wrappedLiteral}\\s*\\)\\s*\\.\\s*${matcher}\\s*\\(\\s*${wrappedLiteral}\\s*\\)`,
    "gi",
  );
  let match = pattern.exec(source);
  while (match) {
    if (isWeakAssertionAllowlisted(source, match.index)) {
      match = pattern.exec(source);
      continue;
    }
    const left = normalizeLiteralToken(match[1]);
    const right = normalizeLiteralToken(match[2]);
    if (left === right) {
      findings.push({
        ruleId: "weak.literal_assertion_same_literal",
        file,
        line: lineAt(source, match.index),
        message: `Detected identical literal assertion; use behavior-level assertions or add // ${WEAK_ASSERTION_ALLOW_MARKER}: <reason>.`,
        snippet: match[0],
      });
    }
    match = pattern.exec(source);
  }
  return findings;
}

function findPythonConstantAssertionFindings(source, file) {
  const findings = [];
  const patterns = [
    { regex: /^\s*assert\s+True(?:\s*(?:#.*)?)?$/gm, ruleId: "weak.py_assert_true_constant" },
    { regex: /^\s*assert\s+False(?:\s*(?:#.*)?)?$/gm, ruleId: "weak.py_assert_false_constant" },
    {
      regex: /\bself\s*\.\s*assertTrue\s*\(\s*True\s*\)/g,
      ruleId: "weak.py_unittest_assert_true_constant",
    },
    {
      regex: /\bself\s*\.\s*assertFalse\s*\(\s*False\s*\)/g,
      ruleId: "weak.py_unittest_assert_false_constant",
    },
  ];
  for (const pattern of patterns) {
    let match = pattern.regex.exec(source);
    while (match) {
      findings.push({
        ruleId: pattern.ruleId,
        file,
        line: lineAt(source, match.index),
        message: `Detected constant Python assertion; replace with behavior assertions or add // ${WEAK_ASSERTION_ALLOW_MARKER}: <reason>.`,
        snippet: match[0],
      });
      match = pattern.regex.exec(source);
    }
  }
  return findings;
}

function findPythonLiteralSelfComparisonFindings(source, file) {
  const findings = [];
  const literal =
    "(?:True|False|None|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?|'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\")";
  const pattern = new RegExp(`\\bassert\\s+(${literal})\\s*==\\s*(${literal})`, "g");
  let match = pattern.exec(source);
  while (match) {
    const left = normalizePythonLiteralToken(match[1]);
    const right = normalizePythonLiteralToken(match[2]);
    if (left === right) {
      findings.push({
        ruleId: "weak.py_assert_same_literal",
        file,
        line: lineAt(source, match.index),
        message: `Detected identical literal comparison in Python assert; replace with behavior assertions or add // ${WEAK_ASSERTION_ALLOW_MARKER}: <reason>.`,
        snippet: match[0],
      });
    }
    match = pattern.exec(source);
  }
  return findings;
}

function findPythonSkipFindings(source, file) {
  const findings = [];
  const patterns = [
    { regex: /@pytest\.mark\.skip(?:if)?\b/g, ruleId: "weak.pytest_skip_marker" },
    { regex: /\bpytest\.skip\s*\(/g, ruleId: "weak.pytest_skip_call" },
    { regex: /@pytest\.mark\.xfail\b/g, ruleId: "weak.pytest_xfail_marker" },
    { regex: /\bpytest\.xfail\s*\(/g, ruleId: "weak.pytest_xfail_call" },
    { regex: /\bself\s*\.\s*skipTest\s*\(/g, ruleId: "weak.unittest_skip_call" },
  ];
  for (const pattern of patterns) {
    let match = pattern.regex.exec(source);
    while (match) {
      findings.push({
        ruleId: pattern.ruleId,
        file,
        line: lineAt(source, match.index),
        message: "Detected Python skip marker/call; skipped tests are forbidden in this gate.",
        snippet: match[0],
      });
      match = pattern.regex.exec(source);
    }
  }
  return findings;
}

function findToBeDefinedFindings(source, file) {
  const findings = [];
  const pattern = /\.\s*toBeDefined\s*\(\s*\)/g;
  let match = pattern.exec(source);
  while (match) {
    if (isWeakAssertionAllowlisted(source, match.index)) {
      match = pattern.exec(source);
      continue;
    }
    findings.push({
      ruleId: "weak.to_be_defined",
      file,
      line: lineAt(source, match.index),
      message: `Detected weak matcher toBeDefined(). Replace with exact assertions or add // ${WEAK_ASSERTION_ALLOW_MARKER}: <reason>.`,
      snippet: match[0],
    });
    match = pattern.exec(source);
  }
  return findings;
}

function findSkipFindings(source, file) {
  const findings = [];
  const patterns = [
    { regex: /\b(?:test|it|describe)\s*\.\s*skip\s*\(/g, ruleId: "weak.skip_usage" },
    { regex: /\bt\s*\.\s*skip\s*\(/g, ruleId: "weak.skip_usage" },
    { regex: /\b(?:test|it|describe)\s*\.\s*only\s*\(/g, ruleId: "weak.only_usage" },
  ];
  for (const pattern of patterns) {
    let match = pattern.regex.exec(source);
    while (match) {
      findings.push({
        ruleId: pattern.ruleId,
        file,
        line: lineAt(source, match.index),
        message:
          pattern.ruleId === "weak.only_usage"
            ? "Detected only marker; test/it/describe.only() is forbidden in this gate."
            : "Detected skip marker; test/it/describe.skip() and node:test t.skip() are forbidden in this gate.",
        snippet: match[0],
      });
      match = pattern.regex.exec(source);
    }
  }
  return findings;
}

function findHardWaitFindings(source, file) {
  const findings = [];
  const pattern = /\bwaitForTimeout\s*\(\s*\d+\s*\)/g;
  let match = pattern.exec(source);
  while (match) {
    const lineText = lineTextAt(source, match.index);
    if (lineText.includes(".toContain(") || lineText.includes(".not.toContain(")) {
      match = pattern.exec(source);
      continue;
    }
    findings.push({
      ruleId: "weak.hard_wait_timeout",
      file,
      line: lineAt(source, match.index),
      message: "Detected hard wait via waitForTimeout(N); use deterministic waits instead.",
      snippet: match[0],
    });
    match = pattern.exec(source);
  }
  return findings;
}

function findWeakAssertionsControlFindings(source, file) {
  const findings = [];
  const pattern = /\bexpect\s*\.\s*assertions\s*\(\s*0\s*\)/g;
  let match = pattern.exec(source);
  while (match) {
    findings.push({
      ruleId: "weak.assertions_zero",
      file,
      line: lineAt(source, match.index),
      message: "Detected expect.assertions(0); this weakens test validity and is forbidden.",
      snippet: match[0],
    });
    match = pattern.exec(source);
  }
  return findings;
}

function findConditionalAssertionFindings(source, file) {
  if (normalizePath(file).endsWith("/scripts/ci/uiq-test-truth-gate.test.mjs")) {
    return [];
  }
  const findings = [];
  for (const pattern of CONDITIONAL_ASSERTION_PATTERNS) {
    const match = pattern.exec(source);
    if (match) {
      if (isWeakAssertionAllowlisted(source, match.index)) {
        continue;
      }
      findings.push({
        ruleId: "weak.conditional_assertion",
        file,
        line: lineAt(source, match.index),
        message:
          "Detected conditional assertion (if/ternary + expect/assert). Use unconditional assertions with explicit setup.",
        snippet: match[0].slice(0, 120),
      });
    }
  }
  return findings;
}

function findMissingAwaitInteractionFindings(source, file) {
  const normalizedFile = normalizePath(file).toLowerCase();
  const looksLikePlaywrightTest =
    normalizedFile.includes("/e2e/") || PLAYWRIGHT_IMPORT_PATTERN.test(source);
  if (!looksLikePlaywrightTest) {
    return [];
  }
  const findings = [];
  const lines = source.split("\n");
  let inPromiseAllBlock = false;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const lineOffset = offset;
    offset += line.length + 1;
    if (/\bPromise\.all\s*\(/.test(line)) {
      inPromiseAllBlock = true;
    }
    if (inPromiseAllBlock && /\]\s*\)\s*;?\s*$/.test(trimmed)) {
      inPromiseAllBlock = false;
    }
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
      continue;
    }
    if (trimmed.startsWith("//")) {
      continue;
    }
    if (/\b(?:fireEvent|userEvent)\s*\./.test(line)) {
      continue;
    }
    if (!PLAYWRIGHT_INTERACTION_PATTERN.test(line)) {
      continue;
    }
    if (trimmed.startsWith(".")) {
      let chainAwaited = false;
      for (let back = 1; back <= 6; back += 1) {
        const prev = lines[index - back];
        if (typeof prev !== "string") {
          break;
        }
        const prevTrimmed = prev.trim();
        if (!prevTrimmed) {
          continue;
        }
        if (/\bawait\b/.test(prevTrimmed)) {
          chainAwaited = true;
          break;
        }
        if (/[;{}]$/.test(prevTrimmed)) {
          break;
        }
      }
      if (chainAwaited) {
        continue;
      }
    }
    if (/\bawait\b/.test(line)) {
      continue;
    }
    if (/\bPromise\.all\s*\(/.test(line) || inPromiseAllBlock) {
      continue;
    }
    const assignedIdentifier = extractAssignedIdentifier(line);
    if (hasDeferredAwait(lines, index, assignedIdentifier)) {
      continue;
    }
    if (isWeakAssertionAllowlisted(source, lineOffset)) {
      continue;
    }
    findings.push({
      ruleId: "weak.missing_await_interaction",
      file,
      line: index + 1,
      message:
        "Detected Playwright interaction without await. Add await (or explicit Promise handling) to avoid false-green async races.",
      snippet: trimmed,
    });
  }
  return findings;
}

function findE2ERealismFindings(source, file) {
  const normalized = normalizePath(file).toLowerCase();
  if (!normalized.includes("/e2e/")) {
    return [];
  }
  const name = basename(file);
  if (
    /playwright\.config(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/i.test(name) ||
    /vitest\.config(?:\.(?:test|spec))?\.[cm]?[jt]sx?$/i.test(name)
  ) {
    return [];
  }
  if (/(?:^|\/)(?:playwright|vitest)\.config(?:\.test)?\.[cm]?[jt]sx?$/.test(normalized)) {
    return [];
  }
  const lower = source.toLowerCase();
  const hasInteraction = INTERACTION_KEYWORDS.some((keyword) =>
    lower.includes(keyword.toLowerCase()),
  );
  const hasExpect = /\bexpect\s*\(/.test(source);
  const findings = [];
  if (!hasInteraction) {
    findings.push({
      ruleId: "weak.e2e_missing_interaction",
      file,
      line: 1,
      message: "E2E realism violation: missing required user interaction keyword.",
      snippet: INTERACTION_KEYWORDS.join(" | "),
    });
  }
  if (!hasExpect) {
    findings.push({
      ruleId: "weak.e2e_missing_expect",
      file,
      line: 1,
      message: "E2E realism violation: missing at least one expect(...) assertion.",
      snippet: "expect(...)",
    });
  }
  return findings;
}

function buildGate(testFileCount, findingCount) {
  if (testFileCount === 0) {
    return {
      status: "blocked",
      reasonCode: REASON_CODE.blocked,
    };
  }
  if (findingCount > 0) {
    return {
      status: "failed",
      reasonCode: REASON_CODE.failed,
    };
  }
  return {
    status: "passed",
    reasonCode: REASON_CODE.passed,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("## UIQ Test Truthiness Gate");
  lines.push(`- Profile: \`${report.profile}\``);
  lines.push(`- Strict Mode: ${report.strict ? "true" : "false"}`);
  lines.push(`- Gate Status: **${report.gate.status}**`);
  lines.push(`- reasonCode: \`${report.gate.reasonCode}\``);
  lines.push(
    `- Scan Roots: ${report.scan.roots.map((root) => `\`${root}\``).join(", ") || "(none)"}`,
  );
  lines.push(`- Candidate Files: ${report.scan.candidateFiles}`);
  lines.push(`- Test Files: ${report.scan.testFiles}`);
  lines.push(`- Findings: ${report.findings.length}`);
  lines.push("");
  lines.push("| # | Rule | File | Line | Message |");
  lines.push("|---:|---|---|---:|---|");
  if (report.findings.length === 0) {
    lines.push("| 1 | `none` | `n/a` | 0 | No weak patterns detected. |");
  } else {
    for (let i = 0; i < report.findings.length; i += 1) {
      const finding = report.findings[i];
      lines.push(
        `| ${i + 1} | \`${finding.ruleId}\` | \`${finding.file}\` | ${finding.line} | ${String(finding.message).replaceAll("|", "\\|")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const roots = options.paths.length > 0 ? options.paths : DEFAULT_ROOTS;
  const resolvedRoots = Array.from(new Set(roots.map((root) => resolve(root))));
  const candidateFiles = [];
  for (const root of resolvedRoots) {
    candidateFiles.push(...collectFiles(root));
  }
  const dedupedCandidates = Array.from(new Set(candidateFiles));
  const testFiles = dedupedCandidates.filter(isLikelyTestFile);
  const findings = [];

  for (const file of testFiles) {
    const source = readFileSync(file, "utf8");
    const normalizedFile = normalizePath(file);
    if (normalizedFile.endsWith("/scripts/ci/uiq-test-truth-gate.test.mjs")) {
      continue;
    }
    if (isPythonFile(file)) {
      findings.push(...findPythonConstantAssertionFindings(source, file));
      findings.push(...findPythonLiteralSelfComparisonFindings(source, file));
      findings.push(...findPythonSkipFindings(source, file));
      continue;
    }
    findings.push(...findLiteralAssertionFindings(source, file));
    findings.push(...findToBeDefinedFindings(source, file));
    findings.push(...findSkipFindings(source, file));
    findings.push(...findConditionalAssertionFindings(source, file));
    findings.push(...findWeakAssertionsControlFindings(source, file));
    findings.push(...findHardWaitFindings(source, file));
    findings.push(...findMissingAwaitInteractionFindings(source, file));
    findings.push(...findE2ERealismFindings(source, file));
  }

  const gate = buildGate(testFiles.length, findings.length);
  const report = {
    generatedAt: new Date().toISOString(),
    profile: options.profile,
    strict: options.strict,
    scan: {
      roots: resolvedRoots,
      candidateFiles: dedupedCandidates.length,
      testFiles: testFiles.length,
    },
    gate,
    findings,
  };

  mkdirSync(resolve(options.outDir), { recursive: true });
  const outJson = resolve(options.outDir, `${outputPrefix}-${options.profile}.json`);
  const outMd = resolve(options.outDir, `${outputPrefix}-${options.profile}.md`);
  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(outMd, renderMarkdown(report), "utf8");

  if (options.strict && gate.status !== "passed") {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[uiq-test-truth-gate] ${message}\n`);
  process.exit(2);
}
