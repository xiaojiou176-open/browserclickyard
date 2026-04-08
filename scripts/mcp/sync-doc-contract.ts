import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DocDrift = {
  docPath: string;
  issues: string[];
};

const LEGACY_RUN_OVERRIDE_FIELDS = [
  "browser",
  "platform",
  "device",
  "headless",
  "timeout",
  "env",
] as const;

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
  "Prooflane is an AI-native WebUI stress lab for localhost-first browser experiments, with governed proof and agent-ready workflows when results need deeper review.";
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
  const block =
    registrySource.match(/export const CORE_12_TOOL_NAMES = \[([\s\S]*?)\] as const;/) ??
    registrySource.match(/const CORE_8_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  if (!block) {
    throw new Error("CORE tool definition not found in registry.ts");
  }
  const names = Array.from(block[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
  return Array.from(new Set(names)).sort();
}

function extractBacktickToolNames(docText: string): Set<string> {
  const names = Array.from(docText.matchAll(/`(uiq_[a-z0-9_]+)`/g), (m) => m[1]);
  return new Set(names);
}

function extractRunOverrideKeys(typesSource: string): Set<string> {
  const block = typesSource.match(/export const runOverrideSchema = \{([\s\S]*?)\} as const;/);
  if (!block) {
    throw new Error("runOverrideSchema definition not found in core/types.ts");
  }
  const keys = Array.from(block[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm), (m) => m[1]);
  return new Set(keys);
}

function extractRunOverrideKeysFromDoc(docText: string): Set<string> {
  const lines = docText.split(/\r?\n/);
  const keys = new Set<string>();
  let inRunOverrideSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (
      /runoverrideschema/i.test(line) ||
      (/run override/i.test(line) && /fields|accepted|supported/i.test(line))
    ) {
      inRunOverrideSection = true;
      continue;
    }

    if (!inRunOverrideSection) {
      continue;
    }
    if (/^##\s+/.test(line) || /^###\s+/.test(line) || /URL\s*Policy/i.test(line)) {
      break;
    }
    if (!line.startsWith("-")) {
      continue;
    }

    const found = Array.from(line.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g), (m) => m[1]);
    for (const key of found) {
      if (!key.startsWith("uiq")) {
        keys.add(key);
      }
    }
  }

  return keys;
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

function diff(
  expected: Iterable<string>,
  actual: Iterable<string>,
): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = Array.from(expectedSet)
    .filter((item) => !actualSet.has(item))
    .sort();
  const extra = Array.from(actualSet)
    .filter((item) => !expectedSet.has(item))
    .sort();
  return { missing, extra };
}

function checkDoc(
  docPath: string,
  docText: string,
  coreTools: string[],
  registeredTools: string[],
  runOverrideKeys: Set<string>,
  options: { requireFullInventory: boolean; checkRunOverride: boolean } = {
    requireFullInventory: true,
    checkRunOverride: true,
  },
): DocDrift {
  const issues: string[] = [];
  const toolNames = extractBacktickToolNames(docText);
  const allToolNames = new Set(registeredTools);

  const missingCore = coreTools.filter((name) => !toolNames.has(name));
  const missingRegistered = options.requireFullInventory
    ? registeredTools.filter((name) => !toolNames.has(name))
    : [];
  const unknown = Array.from(toolNames)
    .filter((name) => !allToolNames.has(name))
    .sort();

  if (missingCore.length > 0) {
    issues.push(`missing core tools: ${missingCore.join(", ")}`);
  }
  if (missingRegistered.length > 0) {
    issues.push(`missing registered tools: ${missingRegistered.join(", ")}`);
  }
  if (unknown.length > 0) {
    issues.push(`contains unknown tools: ${unknown.join(", ")}`);
  }

  if (options.checkRunOverride) {
    const docRunOverrides = extractRunOverrideKeysFromDoc(docText);
    const runOverrideDiff = diff(runOverrideKeys, docRunOverrides);
    if (runOverrideDiff.missing.length > 0) {
      issues.push(`run override missing keys: ${runOverrideDiff.missing.join(", ")}`);
    }
    if (runOverrideDiff.extra.length > 0) {
      issues.push(`run override extra keys: ${runOverrideDiff.extra.join(", ")}`);
    }

    const legacyPresent = LEGACY_RUN_OVERRIDE_FIELDS.filter((key) => docRunOverrides.has(key));
    if (legacyPresent.length > 0) {
      issues.push(`run override contains legacy keys: ${legacyPresent.join(", ")}`);
    }
  }

  return { docPath, issues };
}

function checkDescriptionSource(sourcePath: string, sourceText: string): DocDrift {
  const issues: string[] = [];
  const descriptions = extractNamedDescriptions(sourceText);

  if (descriptions.size === 0) {
    issues.push("description blocks not found");
    return { docPath: sourcePath, issues };
  }

  for (const [name, description] of descriptions) {
    for (const field of REQUIRED_DESCRIPTION_FIELDS) {
      if (!description.includes(field)) {
        issues.push(`${name} missing description field: ${field}`);
      }
    }
    for (const legacyField of LEGACY_DESCRIPTION_FIELDS) {
      if (description.includes(legacyField)) {
        issues.push(`${name} still contains legacy bilingual field: ${legacyField}`);
      }
    }
    if (CJK_PATTERN.test(description)) {
      issues.push(`${name} contains CJK characters in English canonical description`);
    }
  }

  return { docPath: sourcePath, issues };
}

function checkRequiredPatterns(
  docPath: string,
  docText: string,
  patterns: Array<string | RegExp>,
): DocDrift {
  const issues = patterns
    .filter((pattern) => !matchesPattern(docText, pattern))
    .map((pattern) => `missing required truth: ${patternLabel(pattern)}`);
  return { docPath, issues };
}

function main(): void {
  const repoRoot = resolve(".");
  const registryPath = resolve(repoRoot, "services/mcp-server/src/core/registry.ts");
  const typesPath = resolve(repoRoot, "services/mcp-server/src/core/types.ts");
  const descriptionsPath = resolve(
    repoRoot,
    "services/mcp-server/src/tools/register-tools/descriptions.ts",
  );
  const runToolsPath = resolve(
    repoRoot,
    "services/mcp-server/src/tools/register-tools/register-run-tools.ts",
  );
  const closedLoopToolsPath = resolve(
    repoRoot,
    "services/mcp-server/src/tools/register-tools/register-closed-loop-tools.ts",
  );
  const apiToolsPath = resolve(
    repoRoot,
    "services/mcp-server/src/tools/register-tools/register-api-tools.ts",
  );
  const packageJsonPath = resolve(repoRoot, "services/mcp-server/package.json");
  const readmePath = resolve(repoRoot, "README.md");
  const distributionPath = resolve(repoRoot, "DISTRIBUTION.md");
  const integrationsPath = resolve(repoRoot, "INTEGRATIONS.md");
  const entrypointsPath = resolve(repoRoot, "docs/reference/integration-entrypoints.md");
  const skillPath = resolve(repoRoot, "docs/skills/prooflane-mcp/SKILL.md");
  const manifestPath = resolve(repoRoot, "docs/skills/prooflane-mcp/manifest.yaml");
  const indexHtmlPath = resolve(repoRoot, "apps/command-center/index.html");
  const docPaths = [
    resolve(repoRoot, "docs/mcp.md"),
    resolve(repoRoot, "docs/how-to/mcp-clients-setup.md"),
    resolve(repoRoot, "docs/how-to/mcp-quickstart-1pager.md"),
  ];

  const registrySource = readFileSync(registryPath, "utf8");
  const typesSource = readFileSync(typesPath, "utf8");
  const descriptionsSource = readFileSync(descriptionsPath, "utf8");
  const runToolsSource = readFileSync(runToolsPath, "utf8");
  const closedLoopToolsSource = readFileSync(closedLoopToolsPath, "utf8");
  const apiToolsSource = readFileSync(apiToolsPath, "utf8");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageName = packageJson.name;
  const binName = Object.keys(packageJson.bin ?? {})[0];
  const registeredTools = Array.from(
    new Set([
      ...extractRunTools(runToolsSource),
      ...extractRunTools(closedLoopToolsSource),
      ...extractApiTools(apiToolsSource),
    ]),
  ).sort();
  const coreTools = extractCoreTools(registrySource);
  const runOverrideKeys = extractRunOverrideKeys(typesSource);

  const drifts: DocDrift[] = [];
  const descriptionDrift = checkDescriptionSource(descriptionsPath, descriptionsSource);
  if (descriptionDrift.issues.length > 0) {
    drifts.push(descriptionDrift);
  }

  const packageMetadataIssues: string[] = [];
  if (packageName !== "@uiq/mcp-server") {
    packageMetadataIssues.push("package.json name must stay @uiq/mcp-server");
  }
  if (binName !== "prooflane-mcp") {
    packageMetadataIssues.push("package.json bin name must stay prooflane-mcp");
  }
  if (packageJson.publishConfig?.access !== "public") {
    packageMetadataIssues.push("package.json publishConfig.access must stay public");
  }
  if (packageJson.engines?.node !== ">=20") {
    packageMetadataIssues.push("package.json engines.node must stay >=20");
  }
  if (!Array.isArray(packageJson.files) || packageJson.files.join("|") !== "dist|README.md|.env.example") {
    packageMetadataIssues.push("package.json files must stay [dist, README.md, .env.example]");
  }
  if (!packageJson.scripts?.prepack) {
    packageMetadataIssues.push("package.json must define prepack");
  }
  if (!/npm pack --dry-run/.test(packageJson.scripts?.["package:smoke"] ?? "")) {
    packageMetadataIssues.push("package:smoke must verify npm pack --dry-run");
  }
  if (packageMetadataIssues.length > 0) {
    drifts.push({ docPath: packageJsonPath, issues: packageMetadataIssues });
  }

  for (const docPath of docPaths) {
    const text = readFileSync(docPath, "utf8");
    const isQuickstart = docPath.endsWith("docs/how-to/mcp-quickstart-1pager.md");
    const result = checkDoc(docPath, text, coreTools, registeredTools, runOverrideKeys, {
      requireFullInventory: !isQuickstart,
      checkRunOverride: !isQuickstart,
    });
    if (isQuickstart) {
      if (/UIQ_MCP_ENABLE_ADVANCED_TOOLS\s*=\s*true/i.test(text)) {
        result.issues.push(
          "quickstart must not present UIQ_MCP_ENABLE_ADVANCED_TOOLS=true as default env",
        );
      }
      if (!/UIQ_MCP_TOOL_GROUPS\s*=\s*advanced,register,proof,analysis/i.test(text)) {
        result.issues.push(
          "quickstart must document optional group opt-in via UIQ_MCP_TOOL_GROUPS",
        );
      }
    }
    if (result.issues.length > 0) {
      drifts.push(result);
    }
  }

  const publishTruthDocs: Array<{ path: string; patterns: Array<string | RegExp> }> = [
    {
      path: readmePath,
      patterns: [packageName, binName, /ready in repo, not published yet/i, PRODUCT_VALUE_PROPOSITION_PATTERN],
    },
    {
      path: distributionPath,
      patterns: [
        packageName,
        binName,
        /npx\s+-y\s+@uiq\/mcp-server/i,
        /pnpm dlx @uiq\/mcp-server/i,
        /Docker Truth Today/,
      ],
    },
    {
      path: integrationsPath,
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
      path: resolve(repoRoot, "docs/mcp.md"),
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
      path: resolve(repoRoot, "docs/how-to/mcp-clients-setup.md"),
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
      path: resolve(repoRoot, "docs/how-to/mcp-quickstart-1pager.md"),
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
      path: entrypointsPath,
      patterns: [
        packageName,
        binName,
        /Real MCP server with stdio transport/,
        /does \*\*not\*\* use OAuth|does not use OAuth/i,
      ],
    },
    {
      path: skillPath,
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
      path: manifestPath,
      patterns: [
        /^name:\s*prooflane-mcp$/m,
        /^protocol:\s*stdio$/m,
        packageName,
        "UIQ_MCP_API_BASE_URL",
        "UIQ_MCP_TOOL_GROUPS",
        CANONICAL_PACKAGE_TOOL_GROUPS,
      ],
    },
    {
      path: indexHtmlPath,
      patterns: [PRODUCT_VALUE_PROPOSITION, /<title>Prooflane \| AI-native WebUI stress lab<\/title>/],
    },
  ];

  for (const doc of publishTruthDocs) {
    const text = readFileSync(doc.path, "utf8");
    const result = checkRequiredPatterns(doc.path, text, doc.patterns);
    if (result.issues.length > 0) {
      drifts.push(result);
    }
  }

  if (drifts.length === 0) {
    return;
  }
  for (const drift of drifts) {
    for (const _issue of drift.issues) {
    }
  }
  process.exitCode = 1;
}

main();
