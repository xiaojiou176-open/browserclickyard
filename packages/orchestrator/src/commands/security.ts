import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import YAML from "../../../../scripts/lib/yaml-loader.mjs";

export type SecurityConfig = {
  rootDir: string;
  engine: "builtin" | "semgrep";
  maxFileSizeKb: number;
  includeExtensions: string[];
  excludeDirs: string[];
  rulesFile?: string;
};

export type SecurityIssue = {
  id: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  file: string;
  line: number;
  column: number;
  message: string;
  snippet: string;
  ruleId: string;
  component: string;
};

export type SecurityTicket = {
  ticketId: string;
  clusterKey: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR";
  impactScope: string;
  affectedFiles: string[];
  evidence: {
    ruleId: string;
    file: string;
    line: number;
    column: number;
    snippet: string;
  };
  reproSteps: string[];
  fixPlan: {
    rootCauseHypothesis: string;
    actions: string[];
    validation: string[];
  };
  proposedFix: string;
  acceptanceCriteria: string[];
};

type SecurityCluster = {
  id: string;
  key: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  count: number;
  sampleIssueId: string;
};

export type SecurityResult = {
  engine: "builtin" | "semgrep";
  executionStatus: "ok" | "blocked" | "failed";
  executionReasonCode?: string;
  blockedReason?: string;
  blockedReasonDetail?: string;
  errorMessage?: string;
  configSource: string;
  configWarnings: string[];
  scannedFiles: number;
  totalIssueCount: number;
  dedupedIssueCount: number;
  highVulnCount: number;
  mediumVulnCount: number;
  lowVulnCount: number;
  issues: SecurityIssue[];
  clusters: {
    byRule: SecurityCluster[];
    byComponent: SecurityCluster[];
  };
  tickets: SecurityTicket[];
  ticketsPath: string;
  reportPath: string;
};

function normalizeReasonCodeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function securityExecutionReasonCode(
  engine: SecurityResult["engine"],
  status: "blocked" | "failed",
  reason: string,
): string {
  const suffix = normalizeReasonCodeToken(reason);
  return `security.${engine}.${status}.${suffix || "unknown_reason"}`;
}

type Rule = {
  id: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  pattern: string;
  flags?: string;
};

type RulesFile = {
  builtinRules?: Rule[];
  ignorePatterns?: string[];
  componentMap?: Array<{ prefix: string; component: string }>;
};

const DEFAULT_RULES: Rule[] = [
  {
    id: "hardcoded.secret",
    severity: "HIGH",
    message: "Possible hardcoded secret/token/password.",
    pattern: "(api[_-]?key|token|password|secret)\\s*[:=]\\s*[\"'`][^\"'`]{8,}[\"'`]",
    flags: "i",
  },
  {
    id: "dangerous.eval",
    severity: "HIGH",
    message: "Use of eval/new Function is high risk.",
    pattern: "\\b(eval\\s*\\(|new\\s+Function\\s*\\()",
    flags: "",
  },
  {
    id: "childprocess.exec",
    severity: "MEDIUM",
    message: "child_process exec/execSync/spawn usage requires strict validation.",
    pattern: "(?<!\\.)\\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\\s*\\(",
    flags: "",
  },
  {
    id: "insecure.http",
    severity: "LOW",
    message: "HTTP URL found; verify transport security requirements.",
    pattern: "http://",
    flags: "",
  },
];

const DEFAULT_COMPONENT_MAP: Array<{ prefix: string; component: string }> = [
  { prefix: "tests/web-harness/", component: "web-app" },
  { prefix: "apps/api/", component: "api-app" },
  { prefix: "packages/orchestrator/", component: "orchestrator" },
  { prefix: "packages/core/", component: "core" },
  { prefix: "packages/drivers/", component: "drivers" },
  { prefix: "packages/probes/", component: "probes" },
  { prefix: "contracts/", component: "contracts" },
  { prefix: "docs/", component: "docs" },
  { prefix: "configs/profiles/", component: "profiles" },
  { prefix: "configs/targets/", component: "targets" },
];

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".env",
  ".txt",
  ".sh",
]);

type CompiledRule = {
  id: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  regex: RegExp;
};

function parseRulesFile(pathFromRoot: string | undefined): {
  rules: Rule[];
  ignoreRegex: RegExp[];
  componentMap: Array<{ prefix: string; component: string }>;
  source: string;
  warnings: string[];
} {
  if (!pathFromRoot) {
    return {
      rules: DEFAULT_RULES,
      ignoreRegex: [],
      componentMap: DEFAULT_COMPONENT_MAP,
      source: "default",
      warnings: [],
    };
  }

  const abs = resolve(pathFromRoot);
  const warnings: string[] = [];
  try {
    const raw = readFileSync(abs, "utf8");
    const parsed = YAML.parse(raw) as RulesFile;
    const rules = (parsed.builtinRules ?? DEFAULT_RULES).filter(
      (r) => r.id && r.pattern && r.message && r.severity,
    );
    const ignoreRegex = (parsed.ignorePatterns ?? []).flatMap((p) => {
      try {
        return [new RegExp(p)];
      } catch {
        warnings.push(`invalid_ignore_pattern:${p}`);
        return [];
      }
    });
    const componentMap = (parsed.componentMap ?? DEFAULT_COMPONENT_MAP)
      .filter((m) => m.prefix && m.component)
      .sort((a, b) => b.prefix.length - a.prefix.length);

    return {
      rules: rules.length > 0 ? rules : DEFAULT_RULES,
      ignoreRegex,
      componentMap,
      source: pathFromRoot,
      warnings,
    };
  } catch (error) {
    return {
      rules: DEFAULT_RULES,
      ignoreRegex: [],
      componentMap: DEFAULT_COMPONENT_MAP,
      source: `default(fallback:${pathFromRoot})`,
      warnings: [`rules_file_read_failed:${(error as Error).message}`],
    };
  }
}

function compileRules(rules: Rule[]): { compiled: CompiledRule[]; warnings: string[] } {
  const warnings: string[] = [];
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    const flags = rule.flags ?? "";
    try {
      const normalizedFlags = flags.includes("g") ? flags : `${flags}g`;
      compiled.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        regex: new RegExp(rule.pattern, normalizedFlags),
      });
    } catch {
      warnings.push(`invalid_rule_regex:${rule.id}`);
    }
  }

  if (compiled.length === 0) {
    for (const fallback of DEFAULT_RULES) {
      const flags = fallback.flags ?? "";
      const normalizedFlags = flags.includes("g") ? flags : `${flags}g`;
      compiled.push({
        id: fallback.id,
        severity: fallback.severity,
        message: fallback.message,
        regex: new RegExp(fallback.pattern, normalizedFlags),
      });
    }
    warnings.push("all_rules_invalid_using_defaults");
  }

  return { compiled, warnings };
}

function shouldScanFile(filePath: string, includeExtensions: string[]): boolean {
  const ext = extname(filePath).toLowerCase();
  if (includeExtensions.length > 0) {
    return includeExtensions.includes(ext);
  }
  return TEXT_EXTENSIONS.has(ext) || ext === "";
}

function walkFiles(rootDir: string, excludeDirs: string[]): string[] {
  const output: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile()) {
        output.push(full);
      }
    }
  }

  return output;
}

function toLineColumn(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function buildSnippet(content: string, index: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  return content.slice(start, end).replace(/\n/g, "\\n");
}

function classifyComponent(
  file: string,
  componentMap: Array<{ prefix: string; component: string }>,
): string {
  for (const mapping of componentMap) {
    if (file.startsWith(mapping.prefix)) {
      return mapping.component;
    }
  }
  return "unknown";
}

function severityFromSemgrep(raw: string | undefined): "HIGH" | "MEDIUM" | "LOW" {
  const value = (raw ?? "MEDIUM").toUpperCase();
  if (value === "ERROR" || value === "HIGH") {
    return "HIGH";
  }
  if (value === "WARNING" || value === "MEDIUM") {
    return "MEDIUM";
  }
  return "LOW";
}

function dedupeIssues(issues: SecurityIssue[]): SecurityIssue[] {
  const map = new Map<string, SecurityIssue>();
  for (const issue of issues) {
    const key = `${issue.ruleId}|${issue.file}|${issue.line}|${issue.column}|${issue.message}`;
    if (!map.has(key)) {
      map.set(key, issue);
    }
  }
  return Array.from(map.values());
}

function buildClusters(issues: SecurityIssue[]): {
  byRule: SecurityCluster[];
  byComponent: SecurityCluster[];
} {
  const byRuleMap = new Map<string, SecurityCluster>();
  const byCompMap = new Map<string, SecurityCluster>();

  for (const issue of issues) {
    const ruleKey = issue.ruleId;
    const compKey = issue.component;

    if (!byRuleMap.has(ruleKey)) {
      byRuleMap.set(ruleKey, {
        id: `rule:${ruleKey}`,
        key: ruleKey,
        severity: issue.severity,
        count: 0,
        sampleIssueId: issue.id,
      });
    }
    if (!byCompMap.has(compKey)) {
      byCompMap.set(compKey, {
        id: `component:${compKey}`,
        key: compKey,
        severity: issue.severity,
        count: 0,
        sampleIssueId: issue.id,
      });
    }

    const ruleCluster = byRuleMap.get(ruleKey) as SecurityCluster;
    const compCluster = byCompMap.get(compKey) as SecurityCluster;
    ruleCluster.count += 1;
    compCluster.count += 1;

    if (issue.severity === "HIGH") {
      ruleCluster.severity = "HIGH";
      compCluster.severity = "HIGH";
    } else if (issue.severity === "MEDIUM") {
      if (ruleCluster.severity === "LOW") {
        ruleCluster.severity = "MEDIUM";
      }
      if (compCluster.severity === "LOW") {
        compCluster.severity = "MEDIUM";
      }
    }
  }

  const sortByCount = (a: SecurityCluster, b: SecurityCluster): number => b.count - a.count;
  return {
    byRule: Array.from(byRuleMap.values()).sort(sortByCount),
    byComponent: Array.from(byCompMap.values()).sort(sortByCount),
  };
}

function mapTicketSeverity(severity: "HIGH" | "MEDIUM" | "LOW"): "BLOCKER" | "MAJOR" | "MINOR" {
  if (severity === "HIGH") {
    return "BLOCKER";
  }
  if (severity === "MEDIUM") {
    return "MAJOR";
  }
  return "MINOR";
}

function buildProposedFix(issue: SecurityIssue): string {
  if (issue.ruleId === "hardcoded.secret") {
    return "Move secrets to runtime env/secret manager and remove literal values from source.";
  }
  if (issue.ruleId === "dangerous.eval") {
    return "Replace eval/new Function with explicit parser or validated dispatch table.";
  }
  if (issue.ruleId === "childprocess.exec") {
    return "Use strict allowlist validation and safer spawn argument handling before execution.";
  }
  if (issue.ruleId === "insecure.http") {
    return "Use HTTPS endpoints where possible, or document and constrain localhost/test-only HTTP usage.";
  }
  return "Apply least-privilege and input-validation remediation for this finding.";
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildFixPlan(ruleId: string, affectedFiles: string[]): SecurityTicket["fixPlan"] {
  return {
    rootCauseHypothesis: `Unsafe pattern '${ruleId}' appears across ${affectedFiles.length} file(s).`,
    actions: [
      `Apply one consistent remediation for '${ruleId}' in affectedFiles[].`,
      "Add or adjust tests/guards to prevent recurrence.",
      "Document explicit exceptions if any findings are intentionally retained.",
    ],
    validation: [
      "Re-run security scan and ensure this cluster ticket no longer appears.",
      "Run impacted test suites and verify behavior is unchanged.",
    ],
  };
}

function buildTickets(issues: SecurityIssue[]): SecurityTicket[] {
  const grouped = new Map<string, SecurityIssue[]>();
  for (const issue of issues) {
    const clusterKey = `${issue.ruleId}|${issue.component}`;
    if (!grouped.has(clusterKey)) {
      grouped.set(clusterKey, []);
    }
    (grouped.get(clusterKey) as SecurityIssue[]).push(issue);
  }

  const tickets: SecurityTicket[] = [];
  for (const [clusterKey, clusterIssues] of grouped.entries()) {
    const sorted = [...clusterIssues].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    );
    const representative = sorted[0] as SecurityIssue;
    const affectedFiles = Array.from(new Set(sorted.map((item) => item.file))).sort();
    const highestSeverity = sorted.reduce<"HIGH" | "MEDIUM" | "LOW">((acc, cur) => {
      if (acc === "HIGH" || cur.severity === "HIGH") {
        return "HIGH";
      }
      if (acc === "MEDIUM" || cur.severity === "MEDIUM") {
        return "MEDIUM";
      }
      return "LOW";
    }, "LOW");

    tickets.push({
      ticketId: `ticket:${sanitizeKey(clusterKey)}`,
      clusterKey,
      severity: mapTicketSeverity(highestSeverity),
      impactScope: `${representative.component}:${representative.ruleId}`,
      affectedFiles,
      evidence: {
        ruleId: representative.ruleId,
        file: representative.file,
        line: representative.line,
        column: representative.column,
        snippet: representative.snippet,
      },
      reproSteps: [
        `Open representative finding '${representative.file}' at ${representative.line}:${representative.column}`,
        `Search all matches of '${representative.ruleId}' across affectedFiles[]`,
        `Confirm and remediate ${sorted.length} finding(s) in cluster '${clusterKey}'`,
      ],
      fixPlan: buildFixPlan(representative.ruleId, affectedFiles),
      proposedFix: buildProposedFix(representative),
      acceptanceCriteria: [
        `All findings in cluster '${clusterKey}' are fixed or explicitly waived`,
        "Security scan rerun confirms this ticket is resolved",
        "Regression tests pass after remediation",
      ],
    });
  }

  const severityRank: Record<SecurityTicket["severity"], number> = {
    BLOCKER: 3,
    MAJOR: 2,
    MINOR: 1,
  };
  return tickets.sort((a, b) => {
    if (severityRank[b.severity] !== severityRank[a.severity]) {
      return severityRank[b.severity] - severityRank[a.severity];
    }
    return b.affectedFiles.length - a.affectedFiles.length;
  });
}

export function runSecurity(baseDir: string, config: SecurityConfig): SecurityResult {
  const reportPath = "security/report.json";
  const summaryPath = "metrics/security-summary.json";
  const ticketsPath = "metrics/security-tickets.json";

  const rulesConfig = parseRulesFile(config.rulesFile);
  const compiled = compileRules(rulesConfig.rules);
  const configWarnings = [...rulesConfig.warnings, ...compiled.warnings];

  if (config.engine === "semgrep") {
    const probe = spawnSync("semgrep", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      const blockedReason = "semgrep_not_available";
      const blockedReasonDetail =
        probe.error?.message ?? `semgrep unavailable (exit=${probe.status ?? "unknown"})`;
      const blockedResult: SecurityResult = {
        engine: "semgrep",
        executionStatus: "blocked",
        executionReasonCode: securityExecutionReasonCode("semgrep", "blocked", blockedReason),
        blockedReason,
        blockedReasonDetail,
        configSource: rulesConfig.source,
        configWarnings,
        scannedFiles: 0,
        totalIssueCount: 0,
        dedupedIssueCount: 0,
        highVulnCount: 0,
        mediumVulnCount: 0,
        lowVulnCount: 0,
        issues: [],
        clusters: { byRule: [], byComponent: [] },
        tickets: [],
        ticketsPath,
        reportPath,
      };
      writeFileSync(resolve(baseDir, reportPath), JSON.stringify(blockedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(blockedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify([], null, 2), "utf8");
      return blockedResult;
    }

    const run = spawnSync("semgrep", ["scan", "--json", "--config", "auto", config.rootDir], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const stdout = run.stdout ?? "";
    if (run.error) {
      const reason = "semgrep_process_error";
      const failedResult: SecurityResult = {
        engine: "semgrep",
        executionStatus: "failed",
        executionReasonCode: securityExecutionReasonCode("semgrep", "failed", reason),
        errorMessage: run.error.message,
        configSource: rulesConfig.source,
        configWarnings,
        scannedFiles: 0,
        totalIssueCount: 0,
        dedupedIssueCount: 0,
        highVulnCount: 0,
        mediumVulnCount: 0,
        lowVulnCount: 0,
        issues: [],
        clusters: { byRule: [], byComponent: [] },
        tickets: [],
        ticketsPath,
        reportPath,
      };
      writeFileSync(resolve(baseDir, reportPath), JSON.stringify(failedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(failedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify([], null, 2), "utf8");
      return failedResult;
    }

    let parsed: {
      results?: Array<{
        check_id?: string;
        extra?: { message?: string; severity?: string };
        path?: string;
        start?: { line?: number; col?: number };
      }>;
      paths?: { scanned?: string[] };
      errors?: Array<{ message?: string }>;
    };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const reason = "semgrep_json_parse_failed";
      const failedResult: SecurityResult = {
        engine: "semgrep",
        executionStatus: "failed",
        executionReasonCode: securityExecutionReasonCode("semgrep", "failed", reason),
        errorMessage: `Unable to parse semgrep JSON output (exit=${run.status ?? "unknown"})`,
        configSource: rulesConfig.source,
        configWarnings,
        scannedFiles: 0,
        totalIssueCount: 0,
        dedupedIssueCount: 0,
        highVulnCount: 0,
        mediumVulnCount: 0,
        lowVulnCount: 0,
        issues: [],
        clusters: { byRule: [], byComponent: [] },
        tickets: [],
        ticketsPath,
        reportPath,
      };
      writeFileSync(resolve(baseDir, reportPath), JSON.stringify(failedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(failedResult, null, 2), "utf8");
      writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify([], null, 2), "utf8");
      return failedResult;
    }

    const rawIssues: SecurityIssue[] = (parsed.results ?? []).map((item, index) => {
      const file = item.path ? relative(resolve(config.rootDir), item.path) : "unknown";
      return {
        id: `${item.check_id ?? "semgrep"}-${index + 1}`,
        severity: severityFromSemgrep(item.extra?.severity),
        file,
        line: item.start?.line ?? 1,
        column: item.start?.col ?? 1,
        message: item.extra?.message ?? "Semgrep finding",
        snippet: "",
        ruleId: item.check_id ?? "semgrep.unknown",
        component: classifyComponent(file, rulesConfig.componentMap),
      };
    });

    const issues = dedupeIssues(rawIssues);
    const highVulnCount = issues.filter((i) => i.severity === "HIGH").length;
    const mediumVulnCount = issues.filter((i) => i.severity === "MEDIUM").length;
    const lowVulnCount = issues.filter((i) => i.severity === "LOW").length;
    const semgrepErrors = (parsed.errors ?? []).map((e) => e.message).filter(Boolean) as string[];
    const ignorableSemgrepError = (message: string) =>
      message.includes("When parsing a snippet as Bash for metavariable-pattern") ||
      message.includes("was unexpected");
    const actionableSemgrepErrors = semgrepErrors.filter(
      (message) => !ignorableSemgrepError(message),
    );
    const executionStatus: "ok" | "failed" = actionableSemgrepErrors.length > 0 ? "failed" : "ok";
    const executionReasonCode =
      executionStatus === "failed"
        ? securityExecutionReasonCode("semgrep", "failed", "semgrep_reported_errors")
        : undefined;
    const clusters = buildClusters(issues);
    const tickets = buildTickets(issues);

    const result: SecurityResult = {
      engine: "semgrep",
      executionStatus,
      executionReasonCode,
      errorMessage:
        actionableSemgrepErrors.length > 0 ? actionableSemgrepErrors.join("; ") : undefined,
      configSource: rulesConfig.source,
      configWarnings,
      scannedFiles: parsed.paths?.scanned?.length ?? 0,
      totalIssueCount: rawIssues.length,
      dedupedIssueCount: issues.length,
      highVulnCount,
      mediumVulnCount,
      lowVulnCount,
      issues,
      clusters,
      tickets,
      ticketsPath,
      reportPath,
    };

    writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
    writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(result, null, 2), "utf8");
    writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify(tickets, null, 2), "utf8");
    return result;
  }

  const rootDir = resolve(config.rootDir);
  let files: string[] = [];
  try {
    files = walkFiles(rootDir, config.excludeDirs);
  } catch (error) {
    const blockedReason = "builtin_scan_root_unreadable";
    const blockedResult: SecurityResult = {
      engine: "builtin",
      executionStatus: "blocked",
      executionReasonCode: securityExecutionReasonCode("builtin", "blocked", blockedReason),
      blockedReason,
      blockedReasonDetail: (error as Error).message,
      configSource: rulesConfig.source,
      configWarnings,
      scannedFiles: 0,
      totalIssueCount: 0,
      dedupedIssueCount: 0,
      highVulnCount: 0,
      mediumVulnCount: 0,
      lowVulnCount: 0,
      issues: [],
      clusters: { byRule: [], byComponent: [] },
      tickets: [],
      ticketsPath,
      reportPath,
    };
    writeFileSync(resolve(baseDir, reportPath), JSON.stringify(blockedResult, null, 2), "utf8");
    writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(blockedResult, null, 2), "utf8");
    writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify([], null, 2), "utf8");
    return blockedResult;
  }
  const rawIssues: SecurityIssue[] = [];
  let scannedFiles = 0;
  let issueSeq = 0;

  for (const file of files) {
    const rel = relative(rootDir, file);
    const fileStat = statSync(file);
    if (fileStat.size > config.maxFileSizeKb * 1024) {
      continue;
    }
    if (!shouldScanFile(file, config.includeExtensions)) {
      continue;
    }
    if (rulesConfig.ignoreRegex.some((rx) => rx.test(rel))) {
      continue;
    }

    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    scannedFiles += 1;
    for (const rule of compiled.compiled) {
      const regex = new RegExp(
        rule.regex.source,
        rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`,
      );
      let match: RegExpExecArray | null = regex.exec(content);
      while (match) {
        issueSeq += 1;
        const pos = toLineColumn(content, match.index);
        rawIssues.push({
          id: `${rule.id}-${issueSeq}`,
          severity: rule.severity,
          file: rel,
          line: pos.line,
          column: pos.column,
          message: rule.message,
          snippet: buildSnippet(content, match.index),
          ruleId: rule.id,
          component: classifyComponent(rel, rulesConfig.componentMap),
        });
        match = regex.exec(content);
      }
    }
  }

  const issues = dedupeIssues(rawIssues);
  const highVulnCount = issues.filter((i) => i.severity === "HIGH").length;
  const mediumVulnCount = issues.filter((i) => i.severity === "MEDIUM").length;
  const lowVulnCount = issues.filter((i) => i.severity === "LOW").length;
  const clusters = buildClusters(issues);
  const tickets = buildTickets(issues);

  const result: SecurityResult = {
    engine: "builtin",
    executionStatus: highVulnCount > 0 ? "blocked" : mediumVulnCount > 0 ? "failed" : "ok",
    configSource: rulesConfig.source,
    configWarnings,
    scannedFiles,
    totalIssueCount: rawIssues.length,
    dedupedIssueCount: issues.length,
    highVulnCount,
    mediumVulnCount,
    lowVulnCount,
    issues,
    clusters,
    tickets,
    ticketsPath,
    reportPath,
  };

  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(resolve(baseDir, summaryPath), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(resolve(baseDir, ticketsPath), JSON.stringify(tickets, null, 2), "utf8");
  return result;
}
