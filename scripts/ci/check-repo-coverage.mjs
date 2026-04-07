#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function readArg(flag, fallback = "") {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) {
    return fallback;
  }
  return args[index + 1];
}

function parseThreshold(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fail(message) {
  console.error(`[repo-coverage-gate] ${message}`);
  process.exit(1);
}

function sleepMs(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function parseLcovCoverage(lcovPath) {
  const raw = fs.readFileSync(lcovPath, "utf8");
  let linesTotal = 0;
  let linesCovered = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("DA:")) {
      continue;
    }
    const payload = line.slice(3).split(",");
    if (payload.length < 2) {
      continue;
    }
    linesTotal += 1;
    const hits = Number(payload[1]);
    if (Number.isFinite(hits) && hits > 0) {
      linesCovered += 1;
    }
  }
  return { linesCovered, linesTotal };
}

function readCoberturaAttribute(xml, name) {
  const match = xml.match(new RegExp(`${name}="([0-9]+(?:\\.[0-9]+)?)"`));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCoberturaCoverage(xmlPath) {
  const raw = fs.readFileSync(xmlPath, "utf8");
  const linesCovered = readCoberturaAttribute(raw, "lines-covered");
  const linesTotal = readCoberturaAttribute(raw, "lines-valid");
  if (linesCovered === null || linesTotal === null) {
    fail(`unable to parse cobertura lines from ${xmlPath}`);
  }
  return {
    linesCovered,
    linesTotal,
  };
}

function toPercent(covered, total) {
  if (!total) {
    return 100;
  }
  return (covered / total) * 100;
}

function mustReadFile(label, filePath) {
  const resolved = path.resolve(filePath);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(resolved) && Date.now() < deadline) {
    sleepMs(100);
  }
  if (!fs.existsSync(resolved)) {
    fail(`${label} coverage artifact missing: ${resolved}`);
  }
  return resolved;
}

const frontendLcov = mustReadFile(
  "frontend",
  readArg("--frontend", ".runtime-cache/coverage/apps/command-center/lcov.info"),
);
const appsWebLcov = mustReadFile(
  "apps-web",
  readArg("--apps-web", ".runtime-cache/coverage/apps-web/lcov.info"),
);
const backendCobertura = mustReadFile(
  "backend",
  readArg("--backend", ".runtime-cache/coverage/backend-coverage.xml"),
);

const perThreshold = parseThreshold(readArg("--per-threshold", "95"), 95);
const aggregateThreshold = parseThreshold(readArg("--aggregate-threshold", "95"), 95);

const frontend = parseLcovCoverage(frontendLcov);
const appsWeb = parseLcovCoverage(appsWebLcov);
const backend = parseCoberturaCoverage(backendCobertura);

const checks = [
  { name: "frontend", ...frontend },
  { name: "apps-web", ...appsWeb },
  { name: "backend", ...backend },
];

let totalLinesCovered = 0;
let totalLines = 0;
const failures = [];
for (const item of checks) {
  totalLinesCovered += item.linesCovered;
  totalLines += item.linesTotal;
  const percent = toPercent(item.linesCovered, item.linesTotal);
  console.log(
    `[repo-coverage-gate] ${item.name}: ${percent.toFixed(2)}% (${item.linesCovered}/${item.linesTotal}) threshold=${perThreshold.toFixed(2)}%`,
  );
  if (percent + 1e-9 < perThreshold) {
    failures.push(
      `${item.name} line coverage below threshold: ${percent.toFixed(2)}% < ${perThreshold.toFixed(2)}%`,
    );
  }
}

const aggregatePercent = toPercent(totalLinesCovered, totalLines);
console.log(
  `[repo-coverage-gate] aggregate: ${aggregatePercent.toFixed(2)}% (${totalLinesCovered}/${totalLines}) threshold=${aggregateThreshold.toFixed(2)}%`,
);
if (aggregatePercent + 1e-9 < aggregateThreshold) {
  failures.push(
    `aggregate line coverage below threshold: ${aggregatePercent.toFixed(2)}% < ${aggregateThreshold.toFixed(2)}%`,
  );
}

if (failures.length > 0) {
  console.error("[repo-coverage-gate] FAILED");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[repo-coverage-gate] PASSED");
