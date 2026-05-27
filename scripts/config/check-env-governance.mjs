#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import YAML from "../lib/yaml-loader.mjs";

const FORBIDDEN_CONTRACT_PREFIXES = ["OPENAI_"];
const BUILTIN_ALLOW_UNDECLARED_PREFIXES = [];

export function defaultTargets() {
  return [
    "backend",
    "frontend",
    "apps",
    "packages",
    "automation",
    "scripts",
    "config",
    "tests",
    ".github/workflows",
    "README.md",
    "docs",
  ];
}

export function parseArgs(argv) {
  const options = {
    warnOnly: false,
    contractPath: "configs/env/contract.yaml",
    reportPath: ".runtime-cache/artifacts/config/env-governance-report.json",
    targets: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--warn-only") {
      options.warnOnly = true;
      continue;
    }
    if (token === "--strict-references") {
      options.warnOnly = false;
      continue;
    }
    if (token === "--contract" && next) {
      options.contractPath = next;
      i += 1;
      continue;
    }
    if (token === "--report" && next) {
      options.reportPath = next;
      i += 1;
      continue;
    }
    if (token === "--targets" && next) {
      const items = next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      options.targets = items.length > 0 ? items : null;
      i += 1;
    }
  }

  return options;
}

export function loadContract(contractPathInput) {
  const contractPath = resolve(contractPathInput);
  const contract = YAML.parse(readFileSync(contractPath, "utf8"));
  if (!contract || typeof contract !== "object" || !Array.isArray(contract.variables)) {
    throw new Error("invalid env contract");
  }
  validateContractVariables(contract);
  return contract;
}

function validateContractVariables(contract) {
  const seen = new Set();
  for (const item of contract.variables) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid env contract variable entry");
    }
    const name = String(item.name || "").trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid env variable name in contract: '${item.name ?? ""}'`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate variable name in contract: ${name}`);
    }
    if (FORBIDDEN_CONTRACT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`forbidden env variable prefix in contract: ${name}`);
    }
    seen.add(name);
  }
}

function shouldIgnorePath(name) {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".runtime-cache" ||
    name === "dist" ||
    name === "coverage" ||
    name === "playwright-report" ||
    name === "test-results"
  );
}

function isTextCandidate(path) {
  const ext = extname(path);
  if (
    ext === ".py" ||
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".mjs" ||
    ext === ".cjs" ||
    ext === ".sh" ||
    ext === ".md" ||
    ext === ".yaml" ||
    ext === ".yml" ||
    ext === ".json" ||
    ext === ".toml"
  ) {
    return true;
  }
  return path.endsWith("Makefile") || path.endsWith("justfile") || path.endsWith("Dockerfile");
}

function walkFiles(root, acc) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name !== ".github") {
        continue;
      }
    }
    if (shouldIgnorePath(entry.name)) {
      continue;
    }
    const full = resolve(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, acc);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isTextCandidate(full)) {
      continue;
    }
    acc.push(full);
  }
}

export function collectReferencedEnvNames(files) {
  const referenced = new Set();
  const literalPatterns = [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
    /import\.meta\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /os\.(?:getenv|environ\.get)\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
    /os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /\$\{([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}/g,
  ];
  const dynamicPatterns = [
    /process\.env\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]/g,
    /import\.meta\.env\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]/g,
    /os\.(?:getenv|environ\.get)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,[^)]+)?\)/g,
    /os\.environ\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g,
  ];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const constants = collectEnvNameConstants(content);
    for (const pattern of literalPatterns) {
      for (const match of content.matchAll(pattern)) {
        referenced.add(match[1]);
      }
    }
    for (const pattern of dynamicPatterns) {
      for (const match of content.matchAll(pattern)) {
        const identifier = match[1];
        const resolvedName = constants.get(identifier);
        if (resolvedName) {
          referenced.add(resolvedName);
        }
      }
    }
    for (const name of collectEnvNamesFromEnvContainerLiterals(content)) {
      referenced.add(name);
    }
  }

  return referenced;
}

function collectEnvNamesFromEnvContainerLiterals(content) {
  const referenced = new Set();
  const envContainerPattern =
    /\b[A-Za-z_$][A-Za-z0-9_$]*env[A-Za-z0-9_$]*\b\s*=\s*(?:new\s+Set\s*\(\s*)?[[{]([\s\S]*?)[\]}]\s*\)?/gi;
  const envNamePattern = /["']([A-Z][A-Z0-9_]+)["']/g;

  for (const containerMatch of content.matchAll(envContainerPattern)) {
    const block = containerMatch[1] || "";
    for (const nameMatch of block.matchAll(envNamePattern)) {
      referenced.add(nameMatch[1]);
    }
  }

  return referenced;
}

function collectEnvNameConstants(content) {
  const constants = new Map();
  const jsConstantPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["']([A-Z][A-Z0-9_]*)["']\s*;?/g;
  const pyConstantPattern = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([A-Z][A-Z0-9_]*)["']\s*$/gm;
  for (const match of content.matchAll(jsConstantPattern)) {
    constants.set(match[1], match[2]);
  }
  for (const match of content.matchAll(pyConstantPattern)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

function isAllowedUndeclared(name, contract) {
  const exact = new Set((contract.allow_undeclared_exact || []).map((item) => String(item)));
  if (exact.has(name)) {
    return true;
  }
  const prefixes = [
    ...BUILTIN_ALLOW_UNDECLARED_PREFIXES,
    ...(contract.allow_undeclared_prefixes || []),
  ].map((item) => String(item));
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function resolveScanFiles(targets) {
  const files = [];
  for (const target of targets) {
    const full = resolve(target);
    try {
      if (statSync(full).isDirectory()) {
        walkFiles(full, files);
      } else {
        files.push(full);
      }
    } catch {
      // ignore missing target
    }
  }
  return files;
}

function _ensureExampleSync() {
  execFileSync(process.execPath, ["scripts/config/generate-env-example.mjs", "--check"], {
    stdio: "inherit",
  });
}

export function runGovernance({ contract, targets, reportPath }) {
  const files = resolveScanFiles(targets);
  const referenced = collectReferencedEnvNames(files);
  const declared = new Set(contract.variables.map((item) => String(item.name)));
  const undeclared = Array.from(referenced)
    .filter((name) => !declared.has(name))
    .filter((name) => !isAllowedUndeclared(name, contract))
    .sort();

  const report = {
    timestamp: new Date().toISOString(),
    scannedFileCount: files.length,
    referencedCount: referenced.size,
    declaredCount: declared.size,
    undeclaredCount: undeclared.length,
    undeclared,
  };

  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const args = [
    "--import",
    "tsx",
    "scripts/env/check-contract.ts",
    "--contract",
    options.contractPath,
    "--report",
    options.reportPath,
  ];
  if (options.warnOnly) {
    args.push("--warn-only");
  }
  if (options.targets && options.targets.length > 0) {
    args.push("--targets", options.targets.join(","));
  }

  const result = spawnSync(process.execPath, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status === 0) {
    return;
  }
  if (options.warnOnly) {
    return;
  }
  process.exit(3);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isDirectRun) {
  runCli();
}
