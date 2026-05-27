// @ts-nocheck
// 
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const REQUIRED_DESCRIPTION_FIELDS = [
  "Goal:",
  "Use When:",
  "Required Inputs:",
  "Call Order:",
  "Success Output:",
  "If Failed:",
  "Do Not:",
] as const;

const LEGACY_DESCRIPTION_FIELDS = [
  "Goal / 目标:",
  "Use When / 何时使用:",
  "Required Inputs / 必填输入:",
  "Call Order / 调用顺序:",
  "Success Output / 成功输出:",
  "If Failed / 失败处理:",
  "Do Not / 禁止事项:",
] as const;

const CJK_PATTERN = /[\u3400-\u9fff]/u;
const PRODUCT_VALUE_PROPOSITION =
  "Browserclickyard is an AI-native WebUI stress lab for localhost-first browser experiments, with governed proof and agent-ready workflows when results need deeper review.";
const CANONICAL_PACKAGE_TOOL_GROUPS = "advanced,analysis,proof";
const PRODUCT_VALUE_PROPOSITION_PATTERN = new RegExp(
  PRODUCT_VALUE_PROPOSITION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s>]+"),
  "i",
);

function extractRunTools(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/registerTool\(\s*"([^"]+)"/g)) {
    if (match[1]?.startsWith("uiq_")) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

function extractApiTools(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/registerApiTool\(\s*mcpServer,\s*"([^"]+)"/g)) {
    if (match[1]?.startsWith("uiq_")) {
      names.add(match[1]);
    }
  }
  return Array.from(names);
}

function extractCoreTools(registrySource: string): string[] {
  const setBlock = registrySource.match(
    /export const CORE_12_TOOL_NAMES = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(setBlock, "CORE_12_TOOL_NAMES definition must exist");
  const names = Array.from(setBlock[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
  return Array.from(new Set(names)).sort();
}

function extractBacktickToolNames(docText: string): Set<string> {
  const names = Array.from(docText.matchAll(/`(uiq_[a-z0-9_]+)`/g), (m) => m[1]);
  return new Set(names);
}

function extractRunOverrideKeys(typesSource: string): Set<string> {
  const block = typesSource.match(/export const runOverrideSchema = \{([\s\S]*?)\} as const;/);
  assert.ok(block, "runOverrideSchema definition must exist");
  const keys = Array.from(block[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm), (m) => m[1]);
  return new Set(keys);
}

function extractRunOverrideKeysFromDoc(docText: string): Set<string> {
  const lines = docText.split(/\r?\n/);
  const keys = new Set<string>();
  let inRunOverrideSection = false;

  for (const line of lines) {
    const normalized = line.trim();

    if (
      /runoverrideschema/i.test(normalized) ||
      (/run override/i.test(normalized) && /fields|accepted|supported/i.test(normalized))
    ) {
      inRunOverrideSection = true;
      continue;
    }

    if (!inRunOverrideSection) {
      continue;
    }

    if (/^##\s+/.test(normalized) || /^###\s+/.test(normalized) || /URL\s*Policy/i.test(normalized)) {
      break;
    }

    if (!normalized.startsWith("-")) {
      continue;
    }

    const found = Array.from(normalized.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g), (m) => m[1]);
    for (const key of found) {
      if (!key.startsWith("uiq")) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function toSortedArray(values: Iterable<string>): string[] {
  return Array.from(values).sort();
}

function extractNamedDescriptions(source: string): Map<string, string> {
  return new Map(
    Array.from(
      source.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*`([\s\S]*?)`/gm),
      (match) => [match[1], match[2]] as const,
    ),
  );
}

function matchesPattern(source: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
}

function patternLabel(pattern: string | RegExp): string {
  return typeof pattern === "string" ? pattern : pattern.toString();
}

test("docs tool lists are bidirectionally aligned with mcp registration", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const registrySource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/core/registry.ts"),
    "utf8",
  );
  const runToolsSource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/tools/register-tools/register-run-tools.ts"),
    "utf8",
  );
  const closedLoopSource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/tools/register-tools/register-closed-loop-tools.ts"),
    "utf8",
  );
  const apiToolsSource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/tools/register-tools/register-api-tools.ts"),
    "utf8",
  );
  const mcpDoc = readFileSync(resolve(repoRoot, "docs/mcp.md"), "utf8");
  const setupDoc = readFileSync(resolve(repoRoot, "docs/how-to/mcp-clients-setup.md"), "utf8");

  const registeredTools = Array.from(
    new Set([
      ...extractRunTools(runToolsSource),
      ...extractRunTools(closedLoopSource),
      ...extractApiTools(apiToolsSource),
    ]),
  ).sort();
  const coreTools = extractCoreTools(registrySource);
  const registeredSet = new Set(registeredTools);

  const docs = [
    { path: "docs/mcp.md", names: extractBacktickToolNames(mcpDoc) },
    { path: "docs/how-to/mcp-clients-setup.md", names: extractBacktickToolNames(setupDoc) },
  ];

  for (const doc of docs) {
    for (const tool of coreTools) {
      assert.ok(doc.names.has(tool), `${doc.path} missing core tool: ${tool}`);
    }

    for (const tool of doc.names) {
      assert.ok(registeredSet.has(tool), `${doc.path} contains unknown/unregistered tool: ${tool}`);
    }
  }

  for (const tool of registeredTools) {
    assert.ok(docs[0].names.has(tool), `docs/mcp.md missing registered tool: ${tool}`);
    assert.ok(
      docs[1].names.has(tool),
      `docs/how-to/mcp-clients-setup.md missing registered tool: ${tool}`,
    );
  }
});

test("run override fields in docs match runOverrideSchema and avoid legacy drift", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const registrySource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/core/registry.ts"),
    "utf8",
  );
  const typesSource = readFileSync(resolve(repoRoot, "services/mcp-server/src/core/types.ts"), "utf8");
  const mcpDoc = readFileSync(resolve(repoRoot, "docs/mcp.md"), "utf8");
  const setupDoc = readFileSync(resolve(repoRoot, "docs/how-to/mcp-clients-setup.md"), "utf8");
  const quickstartDoc = readFileSync(
    resolve(repoRoot, "docs/how-to/mcp-quickstart-1pager.md"),
    "utf8",
  );
  const architectureDoc = readFileSync(resolve(repoRoot, "docs/architecture.md"), "utf8");
  const qualityDoc = readFileSync(resolve(repoRoot, "docs/quality-gates.md"), "utf8");

  const schemaKeys = extractRunOverrideKeys(typesSource);
  const mcpKeys = extractRunOverrideKeysFromDoc(mcpDoc);
  const setupKeys = extractRunOverrideKeysFromDoc(setupDoc);

  assert.deepEqual(
    toSortedArray(mcpKeys),
    toSortedArray(schemaKeys),
    "docs/mcp.md run override fields drift from runOverrideSchema",
  );
  assert.deepEqual(
    toSortedArray(setupKeys),
    toSortedArray(schemaKeys),
    "docs/how-to/mcp-clients-setup.md run override fields drift from runOverrideSchema",
  );

  const forbiddenLegacyFields = ["browser", "platform", "device", "headless", "timeout", "env"];
  for (const legacy of forbiddenLegacyFields) {
    assert.ok(
      !mcpKeys.has(legacy),
      `docs/mcp.md run override section contains legacy unsupported field: ${legacy}`,
    );
    assert.ok(
      !setupKeys.has(legacy),
      `docs/how-to/mcp-clients-setup.md run override section contains legacy unsupported field: ${legacy}`,
    );
  }

  assert.ok(
    /manifest\.gateResults\.status/.test(architectureDoc) &&
      /manifest\.gateResults\.checks\[\]/.test(architectureDoc),
    "docs/architecture.md must declare manifest gate source of truth",
  );
  assert.ok(
    /manifest\.gateResults\.checks\[\]/.test(qualityDoc),
    "docs/quality-gates.md must declare manifest checks source",
  );
  assert.ok(
    /allowAllUrls=true/.test(mcpDoc) &&
      /MCP run override input does not expose\s*`allowAllUrls`\s*to callers\./i.test(mcpDoc),
    "docs/mcp.md must clarify allowAllUrls explicit opt-in and MCP exposure boundary in English",
  );

  const coreTools = extractCoreTools(registrySource);
  const quickstartTools = extractBacktickToolNames(quickstartDoc);
  for (const tool of coreTools) {
    assert.ok(
      quickstartTools.has(tool),
      `docs/how-to/mcp-quickstart-1pager.md missing core tool: ${tool}`,
    );
  }
  assert.ok(
    !/UIQ_MCP_ENABLE_ADVANCED_TOOLS\s*=\s*true/i.test(quickstartDoc),
    "docs/how-to/mcp-quickstart-1pager.md must not present advanced tools as default env",
  );
  assert.ok(
    /UIQ_MCP_TOOL_GROUPS\s*=\s*advanced,register,proof,analysis/i.test(quickstartDoc),
    "docs/how-to/mcp-quickstart-1pager.md must document optional group opt-in for advanced capabilities",
  );
});

test("publish-ready package truth stays aligned across docs, skill scaffold, and metadata", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "services/mcp-server/package.json"), "utf8"),
  );
  const packageName = packageJson.name;
  const binName = Object.keys(packageJson.bin ?? {})[0];
  const docs = [
    {
      path: "README.md",
      patterns: [packageName, binName, /ready in repo, not published yet/i],
    },
    {
      path: "DISTRIBUTION.md",
      patterns: [
        packageName,
        binName,
        /npx\s+-y\s+@uiq\/mcp-server/i,
        /pnpm dlx @uiq\/mcp-server/i,
        /Docker Truth Today/,
      ],
    },
    {
      path: "INTEGRATIONS.md",
      patterns: [
        packageName,
        binName,
        /stdio only/i,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
      ],
    },
    {
      path: "docs/mcp.md",
      patterns: [
        packageName,
        binName,
        /stdio only/i,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
      ],
    },
    {
      path: "docs/how-to/mcp-clients-setup.md",
      patterns: [
        packageName,
        binName,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
        "\"cwd\": \"/ABSOLUTE/PATH/TO/REPO\"",
      ],
    },
    {
      path: "docs/how-to/mcp-quickstart-1pager.md",
      patterns: [
        packageName,
        binName,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
      ],
    },
    {
      path: "docs/reference/integration-entrypoints.md",
      patterns: [
        packageName,
        binName,
        /Real MCP server with stdio transport/,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
      ],
    },
    {
      path: "docs/skills/browserclickyard-mcp/SKILL.md",
      patterns: [
        packageName,
        binName,
        /generic in-repo scaffold/i,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
        /not published yet/i,
      ],
    },
    {
      path: "docs/skills/browserclickyard-mcp/manifest.yaml",
      patterns: [
        /^name:\s*browserclickyard-mcp$/m,
        /^protocol:\s*stdio$/m,
        packageName,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
      ],
    },
  ];

  assert.equal(packageName, "@uiq/mcp-server");
  assert.equal(binName, "browserclickyard-mcp");
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.deepEqual(packageJson.files, ["dist", "README.md", ".env.example"]);
  assert.equal(packageJson.engines?.node, ">=20");
  assert.ok(packageJson.scripts?.prepack, "package.json must define a prepack build hook");
  assert.match(
    packageJson.scripts?.["package:smoke"] ?? "",
    /pnpm-safe\.sh pack --pack-destination \.runtime-cache\/package-smoke/,
    "package:smoke must verify the pack path",
  );

  for (const doc of docs) {
    const text = readFileSync(resolve(repoRoot, doc.path), "utf8");
    for (const pattern of doc.patterns) {
      assert.ok(
        matchesPattern(text, pattern),
        `${doc.path} missing publish-ready truth: ${patternLabel(pattern)}`,
      );
    }
  }
});

test("front door value proposition stays aligned with command-center metadata", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
  const indexHtml = readFileSync(resolve(repoRoot, "apps/command-center/index.html"), "utf8");

  assert.ok(
    PRODUCT_VALUE_PROPOSITION_PATTERN.test(readme),
    "README.md must contain the canonical product value proposition",
  );
  assert.ok(
    indexHtml.includes(PRODUCT_VALUE_PROPOSITION),
    "apps/command-center/index.html must reuse the canonical product value proposition",
  );
  assert.match(
    indexHtml,
    /<title>Browserclickyard \| AI-native WebUI stress lab<\/title>/,
    "apps/command-center/index.html title must stay product-first and aligned",
  );
});

test("description source keeps English canonical navigation headings", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const descriptionsSource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/tools/register-tools/descriptions.ts"),
    "utf8",
  );
  const descriptions = extractNamedDescriptions(descriptionsSource);

  assert.ok(descriptions.size > 0, "descriptions.ts must expose named description blocks");

  for (const [name, description] of descriptions) {
    for (const field of REQUIRED_DESCRIPTION_FIELDS) {
      assert.ok(description.includes(field), `${name} description missing field: ${field}`);
    }
    for (const legacyField of LEGACY_DESCRIPTION_FIELDS) {
      assert.ok(
        !description.includes(legacyField),
        `${name} description still contains legacy bilingual field: ${legacyField}`,
      );
    }
    assert.ok(
      !CJK_PATTERN.test(description),
      `${name} description must stay English canonical without CJK characters`,
    );
  }
});
