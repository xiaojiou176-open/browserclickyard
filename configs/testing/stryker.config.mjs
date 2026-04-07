/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
// @ts-nocheck

// 

//

import path from "node:path";

function hasGlob(input) {
  return /[*?{}\[\]!()]/.test(input);
}

function toPosix(filePath) {
  return filePath.replace(/\\/g, "/");
}

function escapeGlobLiteral(input) {
  return input.replace(/([*?{}\[\]!()])/g, "[$1]");
}

function normalizeMutateTarget(raw, cwd) {
  const withoutRange = String(raw ?? "").split(":")[0];
  const absoluteTarget = path.isAbsolute(withoutRange)
    ? path.normalize(withoutRange)
    : path.resolve(cwd, withoutRange);
  const relativeTarget = toPosix(path.relative(cwd, absoluteTarget));
  const escapedWorkspaceRoot = escapeGlobLiteral(toPosix(cwd));

  if (!relativeTarget || relativeTarget.startsWith("..")) {
    throw new Error(`[mutation][ts] UIQ_TS_MUTATE_TARGET must resolve inside workspace: ${raw}`);
  }

  if (hasGlob(withoutRange)) {
    return `${escapedWorkspaceRoot}/${relativeTarget}`;
  }
  return `${escapedWorkspaceRoot}/${escapeGlobLiteral(relativeTarget)}`;
}

function normalizeMutateTargets(raw, cwd) {
  const targets = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (targets.length === 0) {
    throw new Error("[mutation][ts] UIQ_TS_MUTATE_TARGET resolved to empty target list");
  }
  return targets.map((target) => normalizeMutateTarget(target, cwd));
}

const defaultMutateTarget =
  "services/mcp-server/src/core/registry.ts,services/mcp-server/src/core/redaction.ts";
const requestedMutateTarget = process.env.UIQ_TS_MUTATE_TARGET ?? defaultMutateTarget;
const mutateTargets = normalizeMutateTargets(requestedMutateTarget, process.cwd());
const tsBreakThreshold = Number.parseFloat(process.env.UIQ_MUTATION_TS_BREAK_THRESHOLD ?? "100");
const normalizedTsBreakThreshold = Number.isFinite(tsBreakThreshold) ? tsBreakThreshold : 0;
const mutationTestCommand = [
  "pnpm",
  "exec",
  "tsx",
  "--test",
  "services/mcp-server/tests/mcp-registry.test.ts",
  "services/mcp-server/tests/mcp-redaction.test.ts",
].join(" ");

const config = {
  testRunner: "command",
  commandRunner: {
    command: mutationTestCommand,
  },
  allowEmpty: false,
  mutate: mutateTargets,
  inPlace: false,
  ignorePatterns: [
    "/.venv/**/*",
    "/.runtime-cache/**/*",
    "**/*.html",
    "tooling/automation/**/*",
    "services/api/**/*",
    "contracts/**/*",
    "docs/**/*",
    "apps/command-center/**/*",
    "scripts/**/*",
    "configs/security/**/*",
    "services/mcp-server/tmp/**/*",
    "tests/**/*",
    "tests/web-harness/**/*",
  ],
  packageManager: "pnpm",
  htmlReporter: {
    fileName: ".runtime-cache/reports/mutation/ts/html/index.html",
  },
  jsonReporter: {
    fileName: ".runtime-cache/reports/mutation/ts/summary.json",
  },
  reporters: ["clear-text", "json", "html"],
  thresholds: {
    high: 100,
    low: 95,
    break: normalizedTsBreakThreshold,
  },
  concurrency: 1,
  timeoutMS: 120000,
  tempDirName: ".runtime-cache/stryker-tmp",
  tsconfigFile: "configs/testing/tsconfig.stryker.json",
  disableTypeChecks: false,
};

export default config;
