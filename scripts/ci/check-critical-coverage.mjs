#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function readArgValues(flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

function readArgValue(flag, fallback) {
  const values = readArgValues(flag);
  return values.length > 0 ? values.at(-1) : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.isAbsolute(normalized)) {
    return path.relative(process.cwd(), normalized).replace(/\\/g, "/");
  }
  return normalized;
}

function toPercent(covered, total) {
  if (!total) {
    return 100;
  }
  return (covered / total) * 100;
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(filePath, pattern) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return filePath === pattern || filePath.endsWith(`/${pattern}`);
  }
  return globToRegExp(pattern).test(filePath);
}

function parseLcov(lcovPath) {
  const raw = fs.readFileSync(lcovPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const fileMap = new Map();
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith("SF:")) {
      currentFile = normalizeFile(line.slice(3).trim());
      if (!fileMap.has(currentFile)) {
        fileMap.set(currentFile, {
          lineCovered: 0,
          lineTotal: 0,
          branchCovered: 0,
          branchTotal: 0,
        });
      }
      continue;
    }
    if (!currentFile) {
      continue;
    }
    if (line.startsWith("DA:")) {
      const payload = line.slice(3).trim().split(",");
      if (payload.length < 2) {
        continue;
      }
      const hits = Number(payload[1]);
      const item = fileMap.get(currentFile);
      item.lineTotal += 1;
      if (Number.isFinite(hits) && hits > 0) {
        item.lineCovered += 1;
      }
      continue;
    }
    if (line.startsWith("BRDA:")) {
      const payload = line.slice(5).trim().split(",");
      if (payload.length < 4) {
        continue;
      }
      const taken = payload[3];
      const item = fileMap.get(currentFile);
      item.branchTotal += 1;
      if (taken !== "-" && Number.isFinite(Number(taken)) && Number(taken) > 0) {
        item.branchCovered += 1;
      }
      continue;
    }
    if (line === "end_of_record") {
      currentFile = null;
    }
  }

  let lineCovered = 0;
  let lineTotal = 0;
  let branchCovered = 0;
  let branchTotal = 0;
  for (const value of fileMap.values()) {
    lineCovered += value.lineCovered;
    lineTotal += value.lineTotal;
    branchCovered += value.branchCovered;
    branchTotal += value.branchTotal;
  }

  return {
    type: "lcov",
    path: lcovPath,
    lineCovered,
    lineTotal,
    branchCovered,
    branchTotal,
    files: fileMap,
  };
}

function readCoverageAttribute(xml, name) {
  const match = xml.match(new RegExp(`${name}="([0-9]+(?:\\.[0-9]+)?)"`));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCobertura(xmlPath) {
  const raw = fs.readFileSync(xmlPath, "utf8");
  const linesValid = readCoverageAttribute(raw, "lines-valid");
  const linesCovered = readCoverageAttribute(raw, "lines-covered");
  const branchesValid = readCoverageAttribute(raw, "branches-valid");
  const branchesCovered = readCoverageAttribute(raw, "branches-covered");

  const classMatches = Array.from(
    raw.matchAll(
      /<class[^>]*filename="([^"]+)"[^>]*line-rate="([0-9.]+)"(?:[^>]*branch-rate="([0-9.]+)")?[^>]*>/g,
    ),
  );
  const files = new Map();

  for (const match of classMatches) {
    const fileName = normalizeFile(match[1]);
    const lineRate = Number(match[2]);
    const branchRate = Number(match[3]);
    const lineTotal = 100;
    const branchTotal = 100;
    files.set(fileName, {
      lineCovered: Math.round((Number.isFinite(lineRate) ? lineRate : 0) * lineTotal),
      lineTotal,
      branchCovered: Math.round((Number.isFinite(branchRate) ? branchRate : 1) * branchTotal),
      branchTotal,
    });
  }

  return {
    type: "cobertura",
    path: xmlPath,
    lineCovered: linesCovered ?? 0,
    lineTotal: linesValid ?? 0,
    branchCovered: branchesCovered ?? 0,
    branchTotal: branchesValid ?? 0,
    files,
  };
}

function fail(message) {
  console.error(`[critical-coverage-gate] ${message}`);
  process.exit(1);
}

const lcovPaths = readArgValues("--lcov");
const coberturaPaths = readArgValues("--cobertura");
const criticalPatterns = readArgValues("--critical");
const globalThresholdLegacy = readArgValue("--global-threshold", undefined);
const criticalThresholdLegacy = readArgValue("--critical-threshold", undefined);

if (lcovPaths.length === 0 && coberturaPaths.length === 0) {
  fail("missing coverage input. Provide at least one --lcov or --cobertura file.");
}

if (criticalPatterns.length === 0) {
  fail("missing --critical patterns. Provide at least one critical module pattern.");
}

const globalLineThreshold = parseNumber(
  readArgValue("--global-line-threshold", globalThresholdLegacy ?? "85"),
  85,
);
const criticalLineThreshold = parseNumber(
  readArgValue("--critical-line-threshold", criticalThresholdLegacy ?? "95"),
  95,
);
const globalBranchThreshold = parseNumber(readArgValue("--global-branch-threshold", "70"), 70);
const criticalBranchThreshold = parseNumber(readArgValue("--critical-branch-threshold", "90"), 90);

const reports = [];
for (const filePath of lcovPaths) {
  if (!fs.existsSync(filePath)) {
    fail(`lcov file not found: ${filePath}`);
  }
  reports.push(parseLcov(filePath));
}
for (const filePath of coberturaPaths) {
  if (!fs.existsSync(filePath)) {
    fail(`cobertura file not found: ${filePath}`);
  }
  reports.push(parseCobertura(filePath));
}

let totalLineCovered = 0;
let totalLineCount = 0;
let totalBranchCovered = 0;
let totalBranchCount = 0;
for (const report of reports) {
  totalLineCovered += report.lineCovered;
  totalLineCount += report.lineTotal;
  totalBranchCovered += report.branchCovered;
  totalBranchCount += report.branchTotal;
}

const globalLinePercent = toPercent(totalLineCovered, totalLineCount);
const globalBranchPercent = toPercent(totalBranchCovered, totalBranchCount);

const allFiles = new Map();
for (const report of reports) {
  for (const [filePath, metrics] of report.files.entries()) {
    if (!allFiles.has(filePath)) {
      allFiles.set(filePath, {
        lineCovered: 0,
        lineTotal: 0,
        branchCovered: 0,
        branchTotal: 0,
      });
    }
    const aggregate = allFiles.get(filePath);
    aggregate.lineCovered += metrics.lineCovered;
    aggregate.lineTotal += metrics.lineTotal;
    aggregate.branchCovered += metrics.branchCovered;
    aggregate.branchTotal += metrics.branchTotal;
  }
}

const failures = [];
const criticalResults = [];
for (const pattern of criticalPatterns) {
  const matches = Array.from(allFiles.entries()).filter(([filePath]) =>
    matchesPattern(filePath, pattern),
  );
  if (matches.length === 0) {
    failures.push(`critical pattern unmatched: ${pattern}`);
    continue;
  }
  for (const [filePath, metrics] of matches) {
    const linePercent = toPercent(metrics.lineCovered, metrics.lineTotal);
    const branchPercent = toPercent(metrics.branchCovered, metrics.branchTotal);
    criticalResults.push({ pattern, filePath, linePercent, branchPercent });
    if (linePercent + 1e-9 < criticalLineThreshold) {
      failures.push(
        `critical line coverage below threshold: ${filePath} (${linePercent.toFixed(2)}% < ${criticalLineThreshold.toFixed(2)}%)`,
      );
    }
    if (branchPercent + 1e-9 < criticalBranchThreshold) {
      failures.push(
        `critical branch coverage below threshold: ${filePath} (${branchPercent.toFixed(2)}% < ${criticalBranchThreshold.toFixed(2)}%)`,
      );
    }
  }
}
for (const result of criticalResults.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
  console.log(
    `[critical-coverage-gate] critical ${result.filePath}: line ${result.linePercent.toFixed(2)}% / branch ${result.branchPercent.toFixed(2)}% [pattern: ${result.pattern}]`,
  );
}

if (globalLinePercent + 1e-9 < globalLineThreshold) {
  failures.push(
    `global line coverage below threshold: ${globalLinePercent.toFixed(2)}% < ${globalLineThreshold.toFixed(2)}%`,
  );
}
if (globalBranchPercent + 1e-9 < globalBranchThreshold) {
  failures.push(
    `global branch coverage below threshold: ${globalBranchPercent.toFixed(2)}% < ${globalBranchThreshold.toFixed(2)}%`,
  );
}

console.log(
  `[critical-coverage-gate] global line ${globalLinePercent.toFixed(2)}% (threshold ${globalLineThreshold.toFixed(2)}%)`,
);
console.log(
  `[critical-coverage-gate] global branch ${globalBranchPercent.toFixed(2)}% (threshold ${globalBranchThreshold.toFixed(2)}%)`,
);

if (failures.length > 0) {
  console.error("[critical-coverage-gate] FAILED");
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log("[critical-coverage-gate] PASSED");
