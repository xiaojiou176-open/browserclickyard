#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/logging-governance.yaml"), "utf8"),
);

const observability = readFileSync(resolve(repoRoot, "services/api/app/core/observability.py"), "utf8");
const middleware = readFileSync(resolve(repoRoot, "services/api/app/core/middleware.py"), "utf8");
const mcpIo = readFileSync(resolve(repoRoot, "services/mcp-server/src/core/io.ts"), "utf8");
const universalPlatform = readFileSync(
  resolve(repoRoot, "services/api/app/services/universal_platform_service.py"),
  "utf8",
);
const vonageInbox = readFileSync(resolve(repoRoot, "services/api/app/services/vonage_inbox.py"), "utf8");
const generatedDoc = readFileSync(resolve(repoRoot, "docs/reference/logging-governance.md"), "utf8");
const runReporting = readFileSync(
  resolve(repoRoot, "packages/orchestrator/src/commands/run/run-reporting.ts"),
  "utf8",
);
const profileFinalize = readFileSync(
  resolve(repoRoot, "packages/orchestrator/src/commands/run/profile-finalize.ts"),
  "utf8",
);
const runtimeLogFixtureRoot = resolve(repoRoot, "scripts/tests/fixtures/runtime-log-sample");

const failures = [];
const sinkById = new Map((config.log_sinks ?? []).map((sink) => [sink.sink_id, sink]));
const sinkKindToFields = {
  run_scoped: new Set(config?.correlation_contract?.default_required_fields ?? []),
  request_scoped: new Set([
    ...(config?.correlation_contract?.request_scoped_required_fields ?? []),
    "component",
    "evidenceClass",
  ]),
  gate_scoped: new Set([
    ...(config?.correlation_contract?.gate_required_fields ?? []),
    "component",
    "evidenceClass",
  ]),
  suite_scoped: new Set([
    ...(config?.correlation_contract?.suite_required_fields ?? []),
    "component",
    "evidenceClass",
  ]),
};
for (const field of [
  ...(config?.correlation_contract?.default_required_fields ?? []),
  ...(config?.correlation_contract?.request_scoped_required_fields ?? []),
  ...(config?.correlation_contract?.gate_required_fields ?? []),
  ...(config?.correlation_contract?.suite_required_fields ?? []),
]) {
  if (!generatedDoc.includes(field)) {
    failures.push(`generated logging governance doc missing correlation field: ${field}`);
  }
}

function requireOrderedTokens(source, label, tokens, detail) {
  let lastIndex = -1;
  for (const token of tokens) {
    const nextIndex = source.indexOf(token, lastIndex + 1);
    if (nextIndex === -1) {
      failures.push(`${label} missing path token '${token}'${detail ? ` (${detail})` : ""}`);
      return;
    }
    lastIndex = nextIndex;
  }
}

function requireSinkPathContract({ sinkId, source, label, expectedPathSuffix }) {
  const sink = sinkById.get(sinkId);
  if (!sink) {
    failures.push(`missing logging sink contract: ${sinkId}`);
    return;
  }
  if (sink.path_pattern !== expectedPathSuffix) {
    failures.push(
      `${sinkId} path_pattern drift: expected ${expectedPathSuffix}, found ${sink.path_pattern}`,
    );
    return;
  }
  if (
    sinkId === "automation_universal_audit" &&
    source.includes('runtime_logs_path("automation"')
  ) {
    return;
  }
  if (
    sinkId === "automation_vonage_audit" &&
    source.includes('runtime_logs_path("automation"')
  ) {
    return;
  }
  const pathTokens = [".runtime-cache", "logs", ...expectedPathSuffix.split("/").slice(3)];
  requireOrderedTokens(source, label, pathTokens, sinkId);
}

for (const sink of config.log_sinks ?? []) {
  if (!sink.sink_id || !sink.path_pattern || !sink.kind || !sink.format) {
    failures.push(`invalid logging sink contract: ${JSON.stringify(sink)}`);
    continue;
  }
  if (!sink.sink_kind || !sinkKindToFields[sink.sink_kind]) {
    failures.push(`logging sink must declare sink_kind: ${sink.sink_id}`);
  }
  if (!Array.isArray(sink.required_fields) || sink.required_fields.length === 0) {
    failures.push(`logging sink must define required_fields: ${sink.sink_id}`);
  }
  const expectedFields = sinkKindToFields[sink.sink_kind] ?? new Set();
  for (const field of expectedFields) {
    if (!(sink.required_fields ?? []).includes(field)) {
      failures.push(`logging sink ${sink.sink_id} missing ${field} for sink_kind=${sink.sink_kind}`);
    }
  }
  if (
    !sink.path_pattern.startsWith(".runtime-cache/logs/") &&
    !sink.path_pattern.startsWith(".runtime-cache/artifacts/")
  ) {
    failures.push(`logging sink path must stay under .runtime-cache/logs or .runtime-cache/artifacts: ${sink.sink_id}`);
  }
  if (
    !generatedDoc.includes(sink.sink_id) ||
    !generatedDoc.includes(sink.path_pattern) ||
    !generatedDoc.includes(sink.sink_kind ?? "")
  ) {
    failures.push(`generated logging governance doc missing sink ${sink.sink_id}`);
  }
}

if (!observability.includes('"request_id"') || !observability.includes('"trace_id"')) {
  failures.push("backend observability must expose request_id and trace_id fields");
}
for (const token of ['"component"', '"evidenceClass"', '"event"', '"severity"']) {
  if (!observability.includes(token)) {
    failures.push(`backend observability must expose canonical field token: ${token}`);
  }
}

if (!middleware.includes("x-request-id") || !middleware.includes("x-trace-id")) {
  failures.push("backend middleware must wire x-request-id and x-trace-id headers");
}
for (const token of ['"component": "backend.http"', '"evidenceClass": "log"', '"event": "http.request.completed"', '"event": "http.request.failed"']) {
  if (!middleware.includes(token)) {
    failures.push(`backend middleware must emit canonical request log token: ${token}`);
  }
}

if (!mcpIo.includes("mcp-audit.jsonl")) {
  failures.push("MCP IO layer must write mcp-audit.jsonl");
}

requireSinkPathContract({
  sinkId: "automation_universal_audit",
  source: universalPlatform,
  label: "universal platform service",
  expectedPathSuffix: ".runtime-cache/logs/automation/universal.audit.jsonl",
});
if (!universalPlatform.includes('"request_id"') || !universalPlatform.includes('"trace_id"')) {
  failures.push("universal platform service must write request-scoped audit identifiers");
}
if (!universalPlatform.includes('"component"') || !universalPlatform.includes('"evidenceClass"')) {
  failures.push("universal platform service must write canonical audit metadata fields");
}
if (!universalPlatform.includes('"event"') || !universalPlatform.includes('"status"')) {
  failures.push("universal platform service must write canonical audit event/status fields");
}

requireSinkPathContract({
  sinkId: "automation_vonage_audit",
  source: vonageInbox,
  label: "vonage inbox service",
  expectedPathSuffix: ".runtime-cache/logs/automation/vonage.callback-audit.jsonl",
});
if (!vonageInbox.includes('"request_id"') || !vonageInbox.includes('"trace_id"')) {
  failures.push("vonage inbox service must write request-scoped audit identifiers");
}
if (!vonageInbox.includes('"component"') || !vonageInbox.includes('"evidenceClass"')) {
  failures.push("vonage inbox service must write canonical audit metadata fields");
}
if (!vonageInbox.includes('"event"') || !vonageInbox.includes('"status"')) {
  failures.push("vonage inbox service must write canonical audit event/status fields");
}

if (!runReporting.includes("reports/evidence.index.json")) {
  failures.push("run-reporting must define reports/evidence.index.json materialization");
}

if (!profileFinalize.includes("evidenceIndexPath")) {
  failures.push("profile-finalize must materialize reports/evidence.index.json");
}

if (!existsSync(resolve(repoRoot, "scripts/ci/write-upstream-verification-ledger.mjs"))) {
  failures.push("missing upstream verification ledger writer");
}

const sampleLogChecks = [
  {
    label: "backend_runtime",
    fixturePath: resolve(runtimeLogFixtureRoot, "service-api.app.jsonl"),
    requiredFields: ["request_id", "trace_id", "component", "evidenceClass", "event", "severity"],
  },
  {
    label: "mcp_audit",
    fixturePath: resolve(runtimeLogFixtureRoot, "mcp-audit.jsonl"),
    requiredFields: ["runId", "component", "evidenceClass", "event", "status"],
  },
  {
    label: "automation_universal_audit",
    sinkId: "automation_universal_audit",
    declaredPath: ".runtime-cache/logs/automation/universal.audit.jsonl",
    fixturePath: resolve(runtimeLogFixtureRoot, "universal.audit.jsonl"),
    requiredFields: ["request_id", "trace_id", "component", "evidenceClass", "event", "status"],
  },
  {
    label: "automation_vonage_audit",
    sinkId: "automation_vonage_audit",
    declaredPath: ".runtime-cache/logs/automation/vonage.callback-audit.jsonl",
    fixturePath: resolve(runtimeLogFixtureRoot, "vonage.callback-audit.jsonl"),
    requiredFields: ["request_id", "trace_id", "component", "evidenceClass", "event", "status"],
  },
];

for (const fixture of sampleLogChecks) {
  if (fixture.sinkId) {
    const sink = sinkById.get(fixture.sinkId);
    if (!sink) {
      failures.push(`missing logging sink contract for runtime log fixture: ${fixture.label}`);
      continue;
    }
    if (sink.path_pattern !== fixture.declaredPath) {
      failures.push(
        `runtime log fixture path drift for ${fixture.label}: expected ${fixture.declaredPath}, found ${sink.path_pattern}`,
      );
    }
  }
  if (!existsSync(fixture.fixturePath)) {
    failures.push(`missing runtime log sample fixture: ${fixture.label}`);
    continue;
  }
  const lines = readFileSync(fixture.fixturePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    failures.push(`runtime log sample fixture is empty: ${fixture.label}`);
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    failures.push(`runtime log sample fixture is not valid JSONL: ${fixture.label}`);
    continue;
  }
  for (const field of fixture.requiredFields) {
    if (!(field in parsed)) {
      failures.push(`runtime log sample fixture missing required field '${field}': ${fixture.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-log-schema-sync] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-log-schema-sync] PASS");
