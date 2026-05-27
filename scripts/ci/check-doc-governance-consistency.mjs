#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const failures = [];

const REQUIRED_ROOT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/ai/agent-guide.md",
  "docs/index.md",
  "docs/architecture.md",
  "docs/reference/ci-governance.md",
];

const REQUIRED_MODULE_READMES = [
  "apps/command-center/README.md",
  "services/api/README.md",
  "services/mcp-server/README.md",
];

const requiredAdapterSections = [
  { label: "project purpose heading", regex: /^##\s*Project Purpose\s*$/m },
  { label: "tech stack heading", regex: /^##\s*Tech Stack\s*$/m },
  { label: "navigation heading", regex: /^##\s*Navigation\s*$/m },
  { label: "gate commands heading", regex: /^##\s*Gate Commands\s*$/m },
];

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function pushFailure(message) {
  failures.push(message);
}

function ensureFileExists(relPath) {
  const target = path.join(repoRoot, relPath);
  if (!fs.existsSync(target)) {
    pushFailure(`missing required file: ${relPath}`);
  }
}

for (const relPath of REQUIRED_ROOT_FILES) {
  ensureFileExists(relPath);
}

for (const relPath of REQUIRED_MODULE_READMES) {
  ensureFileExists(relPath);
}

for (const relPath of ["AGENTS.md", "CLAUDE.md"]) {
  const target = path.join(repoRoot, relPath);
  if (!fs.existsSync(target)) {
    continue;
  }
  const content = readText(target);
  for (const section of requiredAdapterSections) {
    if (!section.regex.test(content)) {
      pushFailure(`missing ${section.label} in ${relPath}`);
    }
  }
}

const guidePath = path.join(repoRoot, "docs/ai/agent-guide.md");
if (fs.existsSync(guidePath)) {
  const guide = readText(guidePath);
  const patterns = [
    ["canonical policy heading", /^##\s*Canonical Policy\s*$/m],
    ["search before writing section", /^##\s*Search Before Writing\s*$/m],
    ["task routing section", /^##\s*Task Routing\s*$/m],
    ["delivery evidence template", /^##\s*Delivery Evidence Template\s*$/m],
    ["ci governance reference", /docs\/reference\/ci-governance\.md/],
  ];
  for (const [label, regex] of patterns) {
    if (!regex.test(guide)) {
      pushFailure(`missing ${label} in docs/ai/agent-guide.md`);
    }
  }
}

const docsIndexPath = path.join(repoRoot, "docs/index.md");
if (fs.existsSync(docsIndexPath)) {
  const index = readText(docsIndexPath);
  const patterns = [
    ["current truth section", /^##\s*Current Truth\s*$/m],
    ["task routing section", /^##\s*Task Routing\s*$/m],
    ["search before writing section", /^##\s*Search Before Writing\s*$/m],
    ["public readiness reference", /docs\/reference\/public-readiness\.md/],
    ["ci governance reference", /docs\/reference\/ci-governance\.md/],
  ];
  for (const [label, regex] of patterns) {
    if (!regex.test(index)) {
      pushFailure(`missing ${label} in docs/index.md`);
    }
  }
}

const ciGovernancePath = path.join(repoRoot, "docs/reference/ci-governance.md");
if (fs.existsSync(ciGovernancePath)) {
  const ciGovernance = readText(ciGovernancePath);
  if (!/^Generated from `configs\/governance\/ci-governance\.yaml`\./m.test(ciGovernance)) {
    pushFailure("docs/reference/ci-governance.md must declare generated source header");
  }
}

if (failures.length > 0) {
  console.error(`[doc-governance-consistency] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[doc-governance-consistency] PASS");
