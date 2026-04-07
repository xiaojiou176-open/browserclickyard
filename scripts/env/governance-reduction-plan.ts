import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";
import { collectRuntimeEnvRefs } from "./collect-runtime-refs.ts";
import { type EnvContractVariable, loadContract, normalizeContract } from "./lib.ts";

type TierPolicy = {
  version: number;
  description?: string;
  core_keys?: string[];
  profiles?: Record<string, string[]>;
  deprecated_aliases?: Record<string, string>;
  keep_prefixes?: string[];
};

type ReductionReport = {
  timestamp: string;
  totals: {
    declared: number;
    runtimeUsed: number;
    core: number;
    deprecatedAliases: number;
    declaredButUnused: number;
    usedButUndeclared: number;
  };
  core: {
    declared: string[];
    missingInContract: string[];
    missingInRuntime: string[];
  };
  deprecatedAliases: Array<{
    alias: string;
    canonical: string;
    aliasUsedInRuntime: boolean;
    canonicalUsedInRuntime: boolean;
  }>;
  candidates: {
    lowRiskDrop: string[];
    mediumRiskReview: string[];
    highRiskKeep: string[];
  };
  profiles: Record<string, { keys: string[]; used: string[]; unused: string[] }>;
  usedButUndeclared: string[];
  declaredButUnusedTop: Array<{ name: string; section: string; defaultValue: string }>;
};

const POLICY_PATH = "configs/env/tier-policy.yaml";
const REPORT_JSON_PATH = ".runtime-cache/artifacts/config/env-reduction-report.json";
const REPORT_MD_PATH = ".runtime-cache/artifacts/config/env-reduction-report.md";

function loadTierPolicy(repoRoot: string): TierPolicy {
  const path = resolve(repoRoot, POLICY_PATH);
  const parsed = YAML.parse(readFileSync(path, "utf8")) as TierPolicy | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid env tier policy: ${path}`);
  }
  return parsed;
}

function toSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((item) => String(item).trim()).filter(Boolean));
}

function asMap(values: Record<string, string> | undefined): Map<string, string> {
  return new Map(
    Object.entries(values ?? {}).map(([k, v]) => [String(k).trim(), String(v).trim()]),
  );
}

function normalizeDefault(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function classifyCandidates(
  contractVars: EnvContractVariable[],
  usedSet: Set<string>,
  coreSet: Set<string>,
  aliasSet: Set<string>,
  keepPrefixes: string[],
): ReductionReport["candidates"] {
  const lowRiskDrop: string[] = [];
  const mediumRiskReview: string[] = [];
  const highRiskKeep: string[] = [];

  for (const item of contractVars) {
    const name = item.name;
    const used = usedSet.has(name);
    const isCore = coreSet.has(name);
    const isAlias = aliasSet.has(name);
    const keepByPrefix = keepPrefixes.some((prefix) => name.startsWith(prefix));

    if (isCore || item.required || used) {
      highRiskKeep.push(name);
      continue;
    }

    if (isAlias) {
      mediumRiskReview.push(name);
      continue;
    }

    if (keepByPrefix) {
      mediumRiskReview.push(name);
      continue;
    }

    lowRiskDrop.push(name);
  }

  return {
    lowRiskDrop: lowRiskDrop.sort(),
    mediumRiskReview: mediumRiskReview.sort(),
    highRiskKeep: highRiskKeep.sort(),
  };
}

function isAllowedUndeclared(
  name: string,
  allowExact: Set<string>,
  allowPrefixes: string[],
): boolean {
  if (allowExact.has(name)) {
    return true;
  }
  return allowPrefixes.some((prefix) => name.startsWith(prefix));
}

function renderMarkdown(report: ReductionReport): string {
  const lines: string[] = [];
  lines.push("# Env Reduction Report");
  lines.push("");
  lines.push(`Generated at: \`${report.timestamp}\``);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Declared variables: ${report.totals.declared}`);
  lines.push(`- Runtime-used variables: ${report.totals.runtimeUsed}`);
  lines.push(`- Core variables: ${report.totals.core}`);
  lines.push(`- Deprecated aliases: ${report.totals.deprecatedAliases}`);
  lines.push(`- Declared but unused: ${report.totals.declaredButUnused}`);
  lines.push(`- Used but undeclared: ${report.totals.usedButUndeclared}`);
  lines.push("");

  lines.push("## Core Coverage");
  lines.push("");
  lines.push(`- Missing in contract: ${report.core.missingInContract.length}`);
  lines.push(`- Missing in runtime: ${report.core.missingInRuntime.length}`);
  if (report.core.missingInRuntime.length > 0) {
    lines.push(`- Keys: ${report.core.missingInRuntime.join(", ")}`);
  }
  lines.push("");

  lines.push("## Candidate Buckets");
  lines.push("");
  lines.push(`- Low-risk drop: ${report.candidates.lowRiskDrop.length}`);
  lines.push(`- Medium-risk review: ${report.candidates.mediumRiskReview.length}`);
  lines.push(`- High-risk keep: ${report.candidates.highRiskKeep.length}`);
  lines.push("");

  lines.push("## Deprecated Aliases");
  lines.push("");
  if (report.deprecatedAliases.length === 0) {
    lines.push("- None");
  } else {
    for (const item of report.deprecatedAliases) {
      lines.push(
        `- ${item.alias} -> ${item.canonical} (aliasUsed=${item.aliasUsedInRuntime}, canonicalUsed=${item.canonicalUsedInRuntime})`,
      );
    }
  }
  lines.push("");

  lines.push("## Used But Undeclared");
  lines.push("");
  if (report.usedButUndeclared.length === 0) {
    lines.push("- None");
  } else {
    for (const key of report.usedButUndeclared) {
      lines.push(`- ${key}`);
    }
  }
  lines.push("");

  lines.push("## Declared But Unused (Top 40)");
  lines.push("");
  for (const item of report.declaredButUnusedTop) {
    lines.push(`- ${item.name} [${item.section}] default=${item.defaultValue || "(empty)"}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const repoRoot = resolve(".");
  const policy = loadTierPolicy(repoRoot);
  const contract = loadContract(repoRoot);
  const contractVars = normalizeContract(contract);

  const declaredSet = new Set(contractVars.map((item) => item.name));
  const used = collectRuntimeEnvRefs(repoRoot);
  const usedSet = new Set(used);
  const coreSet = toSet(policy.core_keys);
  const deprecatedAliases = asMap(policy.deprecated_aliases);
  const aliasSet = new Set(deprecatedAliases.keys());
  const keepPrefixes = (policy.keep_prefixes ?? [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const allowExact = new Set(
    (contract.allow_undeclared_exact ?? []).map((item) => String(item).trim()),
  );
  const allowPrefixes = (contract.allow_undeclared_prefixes ?? [])
    .map((item) => String(item).trim())
    .filter(Boolean);

  const declaredButUnused = [...declaredSet].filter((name) => !usedSet.has(name)).sort();
  const usedButUndeclared = [...usedSet]
    .filter((name) => !declaredSet.has(name))
    .filter((name) => !isAllowedUndeclared(name, allowExact, allowPrefixes))
    .sort();
  const coreMissingInContract = [...coreSet].filter((name) => !declaredSet.has(name)).sort();
  const coreMissingInRuntime = [...coreSet].filter((name) => !usedSet.has(name)).sort();

  const aliasReport = [...deprecatedAliases.entries()].map(([alias, canonical]) => ({
    alias,
    canonical,
    aliasUsedInRuntime: usedSet.has(alias),
    canonicalUsedInRuntime: usedSet.has(canonical),
  }));

  const candidates = classifyCandidates(contractVars, usedSet, coreSet, aliasSet, keepPrefixes);

  const varByName = new Map(contractVars.map((item) => [item.name, item]));
  const declaredButUnusedTop = declaredButUnused.slice(0, 40).map((name) => {
    const item = varByName.get(name);
    return {
      name,
      section: item?.section ?? "unknown",
      defaultValue: normalizeDefault(item?.default ?? ""),
    };
  });

  const profileReport: ReductionReport["profiles"] = {};
  for (const [profile, keys] of Object.entries(policy.profiles ?? {})) {
    const keySet = [...new Set(keys.map((item) => String(item).trim()).filter(Boolean))].sort();
    profileReport[profile] = {
      keys: keySet,
      used: keySet.filter((key) => usedSet.has(key)).sort(),
      unused: keySet.filter((key) => !usedSet.has(key)).sort(),
    };
  }

  const report: ReductionReport = {
    timestamp: new Date().toISOString(),
    totals: {
      declared: declaredSet.size,
      runtimeUsed: usedSet.size,
      core: coreSet.size,
      deprecatedAliases: deprecatedAliases.size,
      declaredButUnused: declaredButUnused.length,
      usedButUndeclared: usedButUndeclared.length,
    },
    core: {
      declared: [...coreSet].sort(),
      missingInContract: coreMissingInContract,
      missingInRuntime: coreMissingInRuntime,
    },
    deprecatedAliases: aliasReport,
    candidates,
    profiles: profileReport,
    usedButUndeclared,
    declaredButUnusedTop,
  };

  const jsonPath = resolve(repoRoot, REPORT_JSON_PATH);
  const mdPath = resolve(repoRoot, REPORT_MD_PATH);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");

  process.stdout.write(`env reduction report generated: ${jsonPath}\n`);
  process.stdout.write(`env reduction report generated: ${mdPath}\n`);
  process.stdout.write(
    `summary: declared=${report.totals.declared}, runtimeUsed=${report.totals.runtimeUsed}, declaredButUnused=${report.totals.declaredButUnused}, usedButUndeclared=${report.totals.usedButUndeclared}\n`,
  );
}

main();
