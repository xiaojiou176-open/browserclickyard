import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectRuntimeEnvRefs } from "./collect-runtime-refs.ts";
import {
  contractPath,
  type EnvContract,
  loadContract,
  loadEnvGovernancePolicy,
  normalizeContract,
  validateContractShape,
  validateEnvGovernancePolicy,
} from "./lib.ts";

const IGNORE_RUNTIME_REFS = new Set(["CI", "PATH", "npm_package_version"]);

type CheckOptions = {
  warnOnly: boolean;
  contractPath: string;
  reportPath: string;
  targets: string[] | null;
};

type CheckReport = {
  timestamp: string;
  contractPath: string;
  declaredCount: number;
  runtimeRefCount: number;
  undeclaredCount: number;
  undeclared: string[];
  errors: string[];
};

function parseArgs(argv: string[]): CheckOptions {
  const options: CheckOptions = {
    warnOnly: false,
    contractPath: contractPath(resolve(".")),
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
      const targets = next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      options.targets = targets.length > 0 ? targets : null;
      i += 1;
    }
  }
  return options;
}

function isAllowedUndeclared(name: string, contract: EnvContract): boolean {
  const exact = new Set((contract.allow_undeclared_exact ?? []).map((item) => String(item)));
  if (exact.has(name)) {
    return true;
  }
  const prefixes = (contract.allow_undeclared_prefixes ?? []).map((item) => String(item));
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function writeReport(reportPath: string, report: CheckReport): void {
  const abs = resolve(reportPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main(): void {
  const root = resolve(".");
  const options = parseArgs(process.argv.slice(2));
  const contract = loadContract(root, options.contractPath);
  const errors = validateContractShape(contract);
  const policy = loadEnvGovernancePolicy(root);
  errors.push(...validateEnvGovernancePolicy(policy));

  const contractKeys = new Set(normalizeContract(contract).map((item) => item.name));
  const runtimeRefs = collectRuntimeEnvRefs(root, options.targets ?? undefined).filter(
    (key) => !IGNORE_RUNTIME_REFS.has(key),
  );
  const undeclared: string[] = [];

  for (const key of runtimeRefs) {
    if (contractKeys.has(key) || isAllowedUndeclared(key, contract)) {
      continue;
    }
    undeclared.push(key);
    errors.push(`runtime env ref not declared in contract: ${key}`);
  }

  const report: CheckReport = {
    timestamp: new Date().toISOString(),
    contractPath: resolve(options.contractPath),
    declaredCount: contractKeys.size,
    runtimeRefCount: runtimeRefs.length,
    undeclaredCount: undeclared.length,
    undeclared: [...undeclared].sort(),
    errors,
  };
  writeReport(options.reportPath, report);

  if (errors.length > 0) {
    const header = options.warnOnly
      ? "env contract check warning:\n"
      : "env contract check failed:\n";
    process.stderr.write(header);
    for (const item of errors) {
      process.stderr.write(`- ${item}\n`);
    }
    if (options.warnOnly) {
      process.exit(0);
    }
    process.exit(1);
  }
  process.stdout.write(`env contract check passed (${runtimeRefs.length} runtime refs).\n`);
}

main();
