#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const reportDir = resolve(repoRoot, ".runtime-cache/artifacts/ci");
const reportJsonPath = resolve(reportDir, "log-quality-report.json");
const reportMdPath = resolve(reportDir, "log-quality-report.md");

const files = {
  observability: "services/api/app/core/observability.py",
  middleware: "services/api/app/core/middleware.py",
  precommit: ".pre-commit-config.yaml",
  ci: ".github/workflows/ci.yml",
  pr: ".github/workflows/pr.yml",
};

const bannedMessages = new Set([
  "request completed",
  "request failed",
  "error",
  "failed",
  "unexpected error",
  "something went wrong",
]);

const failures = [];
const notes = [];
const samples = [];

function addFailure(message) {
  failures.push(message);
}

function readFile(relPath) {
  const absPath = resolve(repoRoot, relPath);
  if (!existsSync(absPath)) {
    addFailure(`missing file: ${relPath}`);
    return "";
  }
  return readFileSync(absPath, "utf8");
}

function requireTokens(source, file, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) {
      addFailure(`${file}: missing required token: ${token}`);
    }
  }
}

function collectPythonFiles(dirPath) {
  const absDir = resolve(repoRoot, dirPath);
  const result = [];
  if (!existsSync(absDir)) {
    return result;
  }
  for (const entry of readdirSync(absDir)) {
    const fullPath = resolve(absDir, entry);
    const fileStats = statSync(fullPath);
    if (fileStats.isDirectory()) {
      result.push(...collectPythonFiles(fullPath.replace(`${repoRoot}/`, "")));
      continue;
    }
    if (entry.endsWith(".py")) {
      result.push(fullPath.replace(`${repoRoot}/`, ""));
    }
  }
  return result;
}

function findGenericLogFindings(source, file) {
  const pattern = /logger\.(?:debug|info|warning|error|exception|critical)\(\s*["']([^"']+)["']/g;
  let match = pattern.exec(source);
  while (match) {
    const message = String(match[1] || "")
      .trim()
      .toLowerCase();
    if (bannedMessages.has(message)) {
      addFailure(`${file}: generic log message is blocked: "${match[1]}"`);
    }
    match = pattern.exec(source);
  }
}

function parseJsonLines(relPath, maxLines = 5) {
  const absPath = resolve(repoRoot, relPath);
  if (!existsSync(absPath)) {
    notes.push(`sample missing (non-blocking): ${relPath}`);
    return [];
  }
  const lines = readFileSync(absPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      addFailure(`${relPath}: invalid JSONL sample (${String(error)})`);
    }
  }
  return parsed;
}

function validateSamples(relPath, requiredFields, anyOf = []) {
  const parsed = parseJsonLines(relPath);
  for (const payload of parsed) {
    const missing = requiredFields.filter((field) => payload[field] === undefined || payload[field] === null);
    if (missing.length > 0) {
      addFailure(`${relPath}: sample is missing fields: ${missing.join(", ")}`);
    }
    if (anyOf.length > 0 && !anyOf.some((field) => payload[field] !== undefined && payload[field] !== null)) {
      addFailure(`${relPath}: sample must contain at least one of: ${anyOf.join(", ")}`);
    }
    samples.push({ filePath: relPath, keys: Object.keys(payload).sort() });
  }
}

const observability = readFile(files.observability);
const middleware = readFile(files.middleware);
const precommit = readFile(files.precommit);
const ciWorkflow = readFile(files.ci);
const prWorkflow = readFile(files.pr);

requireTokens(observability, files.observability, [
  '"component"',
  '"evidenceClass"',
  '"event"',
  '"severity"',
  '"request_id"',
  '"trace_id"',
  '"error_type"',
  '"error_stack"',
  '"error_context"',
]);
requireTokens(middleware, files.middleware, [
  '"component": "backend.http"',
  '"evidenceClass": "log"',
  '"event": "http.request.completed"',
  '"event": "http.request.failed"',
  '"status": "ok"',
  '"status": "error"',
  '"request_id": request_id',
  '"trace_id": trace_id',
  '"user_id": user_id',
  '"path": request.url.path',
  '"method": request.method',
  '"client_ip": client_ip',
  '"user_agent": user_agent',
  '"status_code": status_code',
  '"duration_ms": elapsed_ms',
]);
requireTokens(precommit, files.precommit, ["node scripts/ci/check-log-quality.mjs"]);
requireTokens(ciWorkflow, files.ci, ["node scripts/ci/check-log-quality.mjs"]);
requireTokens(prWorkflow, files.pr, ["node scripts/ci/check-log-quality.mjs"]);

for (const pythonFile of collectPythonFiles("services/api/app")) {
  findGenericLogFindings(readFile(pythonFile), pythonFile);
}

validateSamples(".runtime-cache/logs/runtime/service-api.app.jsonl", [
  "ts",
  "component",
  "evidenceClass",
  "event",
  "request_id",
  "trace_id",
], ["severity", "status"]);
validateSamples(".runtime-cache/logs/automation/universal.audit.jsonl", [
  "ts",
  "component",
  "evidenceClass",
  "event",
  "request_id",
  "trace_id",
  "status",
]);
validateSamples(".runtime-cache/logs/automation/vonage.callback-audit.jsonl", [
  "ts",
  "component",
  "evidenceClass",
  "event",
  "request_id",
  "trace_id",
  "status",
]);
validateSamples(".runtime-cache/logs/mcp-audit.jsonl", [
  "ts",
  "component",
  "evidenceClass",
  "event",
], ["runId", "status"]);

mkdirSync(reportDir, { recursive: true });

const payload = {
  generatedAt: new Date().toISOString(),
  ok: failures.length === 0,
  failures,
  notes,
  samples,
};
writeFileSync(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const mdLines = [
  "# Log Quality Report",
  "",
  `- generated_at: ${payload.generatedAt}`,
  `- status: ${payload.ok ? "PASS" : "FAIL"}`,
  "",
  "## Failures",
  "",
];
if (failures.length === 0) {
  mdLines.push("- _none_");
} else {
  for (const failure of failures) {
    mdLines.push(`- ${failure}`);
  }
}
mdLines.push("");
mdLines.push("## Notes");
mdLines.push("");
if (notes.length === 0) {
  mdLines.push("- _none_");
} else {
  for (const note of notes) {
    mdLines.push(`- ${note}`);
  }
}
mdLines.push("");
writeFileSync(reportMdPath, `${mdLines.join("\n")}\n`, "utf8");

if (failures.length > 0) {
  console.error(`[check-log-quality] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(`- report: ${reportJsonPath}`);
  process.exit(1);
}

console.log(`[check-log-quality] PASS (${reportJsonPath})`);
