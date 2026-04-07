import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PY_MUTATION_RESULTS_CMD = "uv run --with mutmut mutmut results --all true";
const PY_MUTATION_RUN_META_PATH = resolve(".runtime-cache/reports/mutation/py/run-meta.json");
const DEFAULT_PY_MUTMUT_STATS_PATH = resolve(".runtime-cache/reports/mutation/py/mutmut-stats.json");

function scoreFromCounts(counts) {
  const killed = counts.killed ?? 0;
  const survived = counts.survived ?? 0;
  const denominator = killed + survived;
  if (denominator === 0) {
    return null;
  }
  return Number(((killed / denominator) * 100).toFixed(2));
}

function normalizeStatus(value) {
  if (!value) {
    return "unknown";
  }
  return String(value).trim().toLowerCase();
}

function incrementCounter(counters, key) {
  counters[key] = (counters[key] ?? 0) + 1;
}

function createNotRunSummary(source, reason, extras = {}) {
  return {
    source,
    status: "not_run",
    reason,
    totalMutants: 0,
    counters: {},
    score: null,
    effective: false,
    ...extras,
  };
}

function createBlockedSummary(source, reason, extras = {}) {
  return {
    source,
    status: "blocked",
    reason,
    totalMutants: 0,
    counters: {},
    score: null,
    effective: false,
    ...extras,
  };
}

function parseMutationResultsText(raw) {
  const counters = {};
  for (const line of String(raw ?? "").split("\n")) {
    const match = line.match(/:\s*([A-Za-z_-]+)\s*$/);
    if (!match) {
      continue;
    }
    incrementCounter(counters, normalizeStatus(match[1]));
  }
  const total = Object.values(counters).reduce((sum, value) => sum + value, 0);
  return { counters, total };
}

function readJsonFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildTsSurvivorList(raw, limit = 20) {
  const survivors = [];
  for (const [filePath, file] of Object.entries(raw.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      if (String(mutant.status) !== "Survived") {
        continue;
      }
      survivors.push({
        file: filePath,
        mutator: mutant.mutatorName ?? "unknown",
        replacement: mutant.replacement ?? "",
        line: mutant.location?.start?.line ?? 0,
      });
    }
  }
  survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return survivors.slice(0, limit);
}

function buildTsMutatorStats(raw) {
  const stats = {};
  for (const file of Object.values(raw.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      const name = mutant.mutatorName ?? "unknown";
      if (!stats[name]) {
        stats[name] = {
          total: 0,
          killed: 0,
          survived: 0,
          timeout: 0,
          noCoverage: 0,
          runtimeError: 0,
        };
      }
      const bucket = stats[name];
      bucket.total += 1;
      const status = normalizeStatus(mutant.status);
      if (status === "killed") bucket.killed += 1;
      if (status === "survived") bucket.survived += 1;
      if (status === "timeout") bucket.timeout += 1;
      if (status === "nocoverage") bucket.noCoverage += 1;
      if (status === "runtimeerror") bucket.runtimeError += 1;
    }
  }
  return Object.fromEntries(Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)));
}

function summarizeTs() {
  const summaryPath = resolve(".runtime-cache/reports/mutation/ts/summary.json");
  if (!existsSync(summaryPath)) {
    return createNotRunSummary(summaryPath, "missing_summary_artifact", {
      topSurvivors: [],
      mutatorStats: {},
    });
  }
  const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
  const counters = {};
  const files = Object.values(raw.files ?? {});
  for (const file of files) {
    for (const mutant of file.mutants ?? []) {
      incrementCounter(counters, normalizeStatus(mutant.status));
    }
  }

  const total = Object.values(counters).reduce((sum, value) => sum + value, 0);
  return {
    source: summaryPath,
    status: "ready",
    totalMutants: total,
    counters,
    score: scoreFromCounts(counters),
    effective: total > 0 && (counters.killed ?? 0) + (counters.survived ?? 0) > 0,
    topSurvivors: buildTsSurvivorList(raw),
    mutatorStats: buildTsMutatorStats(raw),
  };
}

function summarizePy() {
  const runMeta = readJsonFile(PY_MUTATION_RUN_META_PATH);
  const mutmutStatsPath = runMeta?.mutmutStatsPath
    ? resolve(runMeta.mutmutStatsPath)
    : DEFAULT_PY_MUTMUT_STATS_PATH;
  const resultsPath = runMeta?.resultsPath ? resolve(runMeta.resultsPath) : null;

  if (runMeta?.status === "failed") {
    return createBlockedSummary(runMeta.command ?? PY_MUTATION_RESULTS_CMD, "mutation_run_failed", {
      exitCode: runMeta.exitCode ?? null,
      logPath: runMeta.logPath ?? null,
      actionItems: Array.isArray(runMeta.nextActions) ? runMeta.nextActions : [],
    });
  }

  if (runMeta?.resultsExitCode === 0 && resultsPath && existsSync(resultsPath)) {
    const parsedResults = parseMutationResultsText(readFileSync(resultsPath, "utf8"));
    if (parsedResults.total > 0) {
      return {
        source: runMeta.command ?? PY_MUTATION_RESULTS_CMD,
        status: "ready",
        totalMutants: parsedResults.total,
        counters: parsedResults.counters,
        score: scoreFromCounts(parsedResults.counters),
        effective:
          (parsedResults.counters.killed ?? 0) + (parsedResults.counters.survived ?? 0) > 0,
        logPath: runMeta.logPath ?? null,
        resultsPath,
        runtimeWorkspaceDir: runMeta.runtimeWorkspaceDir ?? null,
      };
    }
  }

  if (!existsSync(mutmutStatsPath)) {
    if (runMeta?.status === "succeeded" && runMeta?.resultsExitCode === 0 && resultsPath && existsSync(resultsPath)) {
      const parsedResults = parseMutationResultsText(readFileSync(resultsPath, "utf8"));
      if (parsedResults.total > 0) {
        return {
          source: runMeta.command ?? PY_MUTATION_RESULTS_CMD,
          status: "ready",
          totalMutants: parsedResults.total,
          counters: parsedResults.counters,
          score: scoreFromCounts(parsedResults.counters),
          effective:
            (parsedResults.counters.killed ?? 0) + (parsedResults.counters.survived ?? 0) > 0,
          logPath: runMeta.logPath ?? null,
          resultsPath,
          runtimeWorkspaceDir: runMeta.runtimeWorkspaceDir ?? null,
        };
      }
    }
    if (runMeta?.status === "succeeded") {
      return createBlockedSummary(PY_MUTATION_RESULTS_CMD, "missing_mutmut_state_after_success", {
        logPath: runMeta.logPath ?? null,
        resultsPath,
        actionItems: [
          "Inspect the py mutation run log to confirm mutmut completed successfully.",
          "Re-run 'pnpm mutation:py:strict' to regenerate mutmut state.",
          "Run 'pnpm mutation:summary' after Python mutation artifacts are restored.",
        ],
      });
    }
    return createNotRunSummary(PY_MUTATION_RESULTS_CMD, "missing_mutmut_state", {
      actionItems: [
        "Run 'pnpm mutation:py:strict' to generate fresh Python mutation artifacts.",
        "If py mutation was intentionally skipped, keep this summary as not_run for audit traceability.",
      ],
    });
  }

  const result = spawnSync(
    "uv",
    ["run", "--with", "mutmut", "mutmut", "results", "--all", "true"],
    {
      encoding: "utf8",
      cwd: process.cwd(),
    },
  );
  if (result.status !== 0) {
    return createBlockedSummary(PY_MUTATION_RESULTS_CMD, "mutmut_results_failed", {
      exitCode: result.status,
      stderr: (result.stderr || result.stdout || "").trim(),
      logPath: runMeta?.logPath ?? null,
      actionItems: [
        "Inspect the stderr attached in latest-summary.json for mutmut results failure details.",
        "Check py mutation run log and fix upstream test/runtime errors first.",
        "Re-run 'pnpm mutation:py:strict' followed by 'pnpm mutation:summary'.",
      ],
    });
  }

  const counters = {};
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/:\s*([A-Za-z_-]+)\s*$/);
    if (!match) {
      continue;
    }
    incrementCounter(counters, normalizeStatus(match[1]));
  }

  const total = Object.values(counters).reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return createBlockedSummary(PY_MUTATION_RESULTS_CMD, "no_mutation_results", {
      logPath: runMeta?.logPath ?? null,
      actionItems: [
        "Verify mutmut target paths and exclude rules in Python configuration.",
        "Ensure at least one Python mutant is generated and evaluated before enforcing effective gate.",
      ],
    });
  }

  return {
    source: PY_MUTATION_RESULTS_CMD,
    status: "ready",
    totalMutants: total,
    counters,
    score: scoreFromCounts(counters),
    effective: total > 0 && (counters.killed ?? 0) + (counters.survived ?? 0) > 0,
  };
}

function cleanupPyMutationRuntimeState(runMeta) {
  const paths = Array.isArray(runMeta?.legacyRuntimePaths)
    ? runMeta.legacyRuntimePaths
    : [".mutmut-cache", "mutants"];
  for (const relPath of paths) {
    if (typeof relPath !== "string" || !relPath.trim()) {
      continue;
    }
    const absPath = resolve(relPath);
    if (!existsSync(absPath)) {
      continue;
    }
    rmSync(absPath, { recursive: true, force: true });
  }
}

function printSummary(_name, summary) {
  const scoreLabel = summary.score === null ? "n/a" : `${summary.score}%`;
  const suffix = summary.reason ? `, reason=${summary.reason}` : "";
  const actionHint = Array.isArray(summary.actionItems) && summary.actionItems.length > 0;
  console.log(
    `[mutation][${_name}] status=${summary.status}, score=${scoreLabel}, total=${summary.totalMutants}, ` +
      `killed=${summary.counters.killed ?? 0}, survived=${summary.counters.survived ?? 0}, ` +
      `effective=${summary.effective}${suffix}${actionHint ? ", actionable=true" : ""}`,
  );
}

function assertMinimumScore(name, summary, minScore) {
  const score = summary.score;
  if (score === null) {
    throw new Error(`[mutation][${name}] hard gate failed: score is n/a`);
  }
  if (score < minScore) {
    throw new Error(
      `[mutation][${name}] hard gate failed: score=${score}% below minimum ${minScore}%`,
    );
  }
}

const ts = summarizeTs();
const py = summarizePy();
const strictSummary = process.env.UIQ_MUTATION_SUMMARY_STRICT === "1";
const pyRunMeta = readJsonFile(PY_MUTATION_RUN_META_PATH);

printSummary("ts", ts);
printSummary("py", py);

const overallStatus =
  ts.status === "blocked" || py.status === "blocked"
    ? "blocked"
    : ts.status === "ready" && py.status === "ready"
      ? "ready"
      : ts.status === "not_run" && py.status === "not_run"
        ? "not_run"
        : "partial";

const report = {
  generatedAt: new Date().toISOString(),
  overallStatus,
  strictSummary,
  ts,
  py,
};

const outputPath = resolve(".runtime-cache/reports/mutation/latest-summary.json");
mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const markdownPath = resolve(".runtime-cache/reports/mutation/latest-summary.md");
const markdownLines = [
  "# Mutation Summary",
  "",
  `- generatedAt: \`${report.generatedAt}\``,
  `- overall status: \`${report.overallStatus}\``,
  `- strict summary: \`${report.strictSummary}\``,
  `- ts status: \`${ts.status}\`${ts.reason ? ` (${ts.reason})` : ""}`,
  `- py status: \`${py.status}\`${py.reason ? ` (${py.reason})` : ""}`,
  `- ts score: \`${ts.score ?? "n/a"}%\``,
  `- py score: \`${py.score ?? "n/a"}%\``,
  "",
  "## TypeScript",
  `- total mutants: ${ts.totalMutants}`,
  `- killed: ${ts.counters.killed ?? 0}`,
  `- survived: ${ts.counters.survived ?? 0}`,
  `- timeout: ${ts.counters.timeout ?? 0}`,
  `- noCoverage: ${ts.counters.nocoverage ?? 0}`,
  `- runtimeError: ${ts.counters.runtimeerror ?? 0}`,
  `- effective: ${ts.effective}`,
  "",
  "### Mutator Stats",
  "| mutator | total | killed | survived | timeout | noCoverage | runtimeError |",
  "|---|---:|---:|---:|---:|---:|---:|",
];
const mutatorEntries = Object.entries(ts.mutatorStats ?? {});
if (mutatorEntries.length === 0) {
  markdownLines.push("| n/a | 0 | 0 | 0 | 0 | 0 | 0 |");
} else {
  for (const [mutatorName, stat] of mutatorEntries) {
    markdownLines.push(
      `| ${mutatorName} | ${stat.total} | ${stat.killed} | ${stat.survived} | ${stat.timeout} | ${stat.noCoverage} | ${stat.runtimeError} |`,
    );
  }
}
markdownLines.push(
  "",
  "### Top Survived Mutants",
  "| file | line | mutator | replacement |",
  "|---|---:|---|---|",
);
if ((ts.topSurvivors ?? []).length === 0) {
  markdownLines.push("| n/a | 0 | n/a | n/a |");
} else {
  for (const item of ts.topSurvivors) {
    markdownLines.push(
      `| ${item.file} | ${item.line} | ${item.mutator} | ${String(item.replacement).replaceAll("|", "\\|")} |`,
    );
  }
}
markdownLines.push(
  "",
  "## Python",
  `- status: ${py.status}`,
  `- source: ${py.source}`,
  `- reason: ${py.reason ?? "n/a"}`,
  `- log path: ${py.logPath ?? "n/a"}`,
  py.stderr ? `- stderr: ${py.stderr}` : "- stderr: n/a",
  `- total mutants: ${py.totalMutants}`,
  `- killed: ${py.counters.killed ?? 0}`,
  `- survived: ${py.counters.survived ?? 0}`,
  `- effective: ${py.effective}`,
  "",
);
if (Array.isArray(py.actionItems) && py.actionItems.length > 0) {
  markdownLines.push("### Python Next Actions");
  for (const action of py.actionItems) {
    markdownLines.push(`- ${action}`);
  }
  markdownLines.push("");
}
writeFileSync(markdownPath, `${markdownLines.join("\n")}\n`, "utf8");

cleanupPyMutationRuntimeState(pyRunMeta);

const pyMinScore = Number.parseFloat(process.env.UIQ_MUTATION_PY_MIN_SCORE ?? "100");
const tsMinScore = Number.parseFloat(process.env.UIQ_MUTATION_TS_MIN_SCORE ?? "100");

if (overallStatus !== "ready") {
  const msg =
    `[mutation][summary] status=${overallStatus}; mutation summary gate not evaluated. ` +
    `See ${outputPath}.`;
  if (strictSummary || overallStatus === "blocked") {
    const hint =
      overallStatus === "blocked"
        ? "Resolve blocked mutation steps and re-run mutation commands."
        : "Re-run mutation or set UIQ_MUTATION_SUMMARY_STRICT=0.";
    throw new Error(`${msg} ${hint}`);
  }
  console.warn(msg);
  process.exit(0);
}

if (!ts.effective || !py.effective) {
  throw new Error(
    `Mutation effectiveness check failed (ts=${ts.effective}, py=${py.effective}). See ${outputPath}`,
  );
}

assertMinimumScore("ts", ts, tsMinScore);
assertMinimumScore("py", py, pyMinScore);
