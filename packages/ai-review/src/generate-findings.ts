import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatValidationIssues, validatePromptOutput } from "../../ai-prompts/src/validate.js";
import type { AiReviewInput, AiReviewSeverity } from "./build-input.js";
import {
  AI_REVIEW_PROMPT_ID,
  AI_REVIEW_PROMPT_VERSION,
  buildAiReviewPromptContext,
} from "./prompt-entry.js";

const AI_REVIEW_NO_ARTIFACTS = "gate.ai_review.blocked.no_candidate_artifacts";
const AI_REVIEW_HIGH_FINDINGS = "gate.ai_review.failed.high_severity_findings";
const AI_REVIEW_LLM_SCHEMA_INVALID = "gate.ai_review.failed.llm_output_schema_invalid";
const AI_REVIEW_LLM_JSON_INVALID = "gate.ai_review.failed.llm_output_json_invalid";
const AI_REVIEW_REASON_CODE_PREFIXES = ["gate.ai_fix.", "gate.ai_review.", "ai.gemini."];
const AI_GEMINI_REASON_CODE_FALLBACK = "ai.gemini.review.finding.generated";

export type SeverityThreshold = "critical" | "high" | "medium" | "low";

export type AiReviewGenerationMode = "llm" | "rule_fallback";

export type AiReviewFinding = {
  issue_id: string;
  severity: AiReviewSeverity;
  impact: string;
  evidence: string[];
  repro: string;
  recommendation: string;
  acceptance: string;
  reason_code: string;
  file_path: string;
  patch_hint: string;
  acceptance_check: string;
  risk_level: AiReviewSeverity;
};

export type AiReviewReport = {
  schemaVersion: "1.0";
  generatedAt: string;
  runId: string;
  profile: string;
  target: { type: string; name: string };
  severityThreshold: SeverityThreshold;
  candidates: AiReviewInput["candidates"];
  findings: AiReviewFinding[];
  summary: {
    totalFindings: number;
    highOrAbove: number;
    candidateArtifacts: number;
  };
  gate: {
    status: "passed" | "failed" | "blocked";
    reasonCode: string;
  };
  generation: {
    mode: AiReviewGenerationMode;
    promptId: string;
    promptVersion: string;
    model: string;
  };
};

export type GenerateAiReviewOptions = {
  severityThreshold: SeverityThreshold;
  mode?: AiReviewGenerationMode;
  llmGenerate?: (request: {
    prompt: string;
    input: AiReviewInput;
    options: Pick<GenerateAiReviewOptions, "severityThreshold">;
  }) => { model: string; output: unknown | string };
};

export class AiReviewGenerationError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "AiReviewGenerationError";
    this.reasonCode = reasonCode;
  }
}

function severityRank(severity: AiReviewSeverity): number {
  if (severity === "critical") {
    return 4;
  }
  if (severity === "high") {
    return 3;
  }
  if (severity === "medium") {
    return 2;
  }
  return 1;
}

function normalizeToken(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "finding"
  );
}

export function isSeverityAtOrAbove(
  severity: AiReviewSeverity,
  threshold: SeverityThreshold,
): boolean {
  return severityRank(severity) >= severityRank(threshold);
}

function severityFromCheckId(checkId: string): AiReviewSeverity {
  if (checkId.startsWith("security.")) {
    return "critical";
  }
  if (
    checkId.startsWith("console.") ||
    checkId.startsWith("page.") ||
    checkId.startsWith("http.")
  ) {
    return "high";
  }
  if (checkId.startsWith("a11y.") || checkId.startsWith("perf.") || checkId.startsWith("visual.")) {
    return "high";
  }
  if (checkId.startsWith("test.")) {
    return "high";
  }
  if (checkId.startsWith("load.") || checkId.startsWith("safety.")) {
    return "medium";
  }
  return "low";
}

function recommendationFromCheckId(checkId: string): string {
  if (checkId.startsWith("a11y.")) {
    return "Fix accessibility violations and ensure serious/critical counts meet threshold.";
  }
  if (checkId.startsWith("perf.")) {
    return "Optimize critical rendering path and reduce paint/contentful timings.";
  }
  if (checkId.startsWith("visual.")) {
    return "Stabilize visual output and update baseline only after verified intentional UI changes.";
  }
  if (checkId.startsWith("security.")) {
    return "Patch security findings and remove high-risk patterns before merge.";
  }
  if (checkId.startsWith("test.")) {
    return "Repair failing test suite and enforce deterministic assertions.";
  }
  if (checkId.startsWith("safety.")) {
    return "Refine dangerous action denylist and traversal policy to avoid destructive actions.";
  }
  return "Resolve the failing gate check and provide deterministic evidence artifacts.";
}

type PromptFindingOutput = {
  issue_id: string;
  severity: string;
  impact: string;
  recommendation: string;
  reason_code: string;
  file_path: string;
  patch_hint: string;
  acceptance_check: string;
  risk_level: string;
};

type PromptOutput = {
  summary: string;
  findings: PromptFindingOutput[];
};

function parsePromptOutput(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AiReviewGenerationError(
        AI_REVIEW_LLM_JSON_INVALID,
        `AI review LLM output is not valid JSON: ${message}`,
      );
    }
  }
  return raw;
}

function parseAiReviewSeverity(value: string): AiReviewSeverity {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new AiReviewGenerationError(
    AI_REVIEW_LLM_SCHEMA_INVALID,
    `AI review LLM output has invalid severity value: ${value}`,
  );
}

function isAllowedReasonCodePrefix(value: string): boolean {
  return AI_REVIEW_REASON_CODE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function normalizeReasonCode(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > 0 && isAllowedReasonCodePrefix(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function normalizeFilePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "reports/summary.json";
}

function mapPromptFindingsToReport(
  input: AiReviewInput,
  promptOutput: PromptOutput,
): AiReviewFinding[] {
  const checkByIssue = new Map<string, AiReviewInput["failedChecks"][number]>();
  input.failedChecks.forEach((check, index) => {
    const issueId = `AI-${String(index + 1).padStart(3, "0")}-${normalizeToken(check.id)}`;
    checkByIssue.set(issueId, check);
  });

  return promptOutput.findings.map((finding) => {
    const sourceCheck = checkByIssue.get(finding.issue_id);
    const evidencePath = sourceCheck?.evidencePath ?? normalizeFilePath(finding.file_path);
    const fallbackReasonCode = sourceCheck
      ? `gate.ai_review.finding.${normalizeToken(sourceCheck.id)}`
      : AI_GEMINI_REASON_CODE_FALLBACK;
    const normalizedReasonCode = normalizeReasonCode(finding.reason_code, fallbackReasonCode);
    const normalizedFilePath = normalizeFilePath(finding.file_path || sourceCheck?.evidencePath);
    const parsedRiskLevel = parseAiReviewSeverity(finding.risk_level);
    return {
      issue_id: finding.issue_id,
      severity: parseAiReviewSeverity(finding.severity),
      impact: finding.impact,
      evidence: [evidencePath],
      repro: `Run profile ${input.profile} for target ${input.target.name} and inspect gate evidence for ${finding.issue_id}.`,
      recommendation: finding.recommendation,
      acceptance: `Finding ${finding.issue_id} must be resolved with deterministic evidence.`,
      reason_code: normalizedReasonCode,
      file_path: normalizedFilePath,
      patch_hint: finding.patch_hint,
      acceptance_check: finding.acceptance_check,
      risk_level: parsedRiskLevel,
    };
  });
}

function buildFallbackFindings(input: AiReviewInput): AiReviewFinding[] {
  return input.failedChecks.map((check, index) => {
    const issueToken = normalizeToken(check.id);
    const severity = severityFromCheckId(check.id);
    return {
      issue_id: `AI-${String(index + 1).padStart(3, "0")}-${issueToken}`,
      severity,
      impact: `Gate check ${check.id} is ${check.status} and affects profile ${input.profile}.`,
      evidence: [check.evidencePath],
      repro: `Run profile ${input.profile} for target ${input.target.name} and inspect ${check.evidencePath}.`,
      recommendation: recommendationFromCheckId(check.id),
      acceptance: `Gate check ${check.id} must become passed with deterministic evidence.`,
      reason_code: `gate.ai_review.finding.${issueToken}`,
      file_path: check.evidencePath,
      patch_hint: `Apply a deterministic fix for check ${check.id} in ${check.evidencePath}.`,
      acceptance_check: `Verify check ${check.id} transitions to passed in gate results.`,
      risk_level: severity,
    };
  });
}

function defaultLlmGenerate(request: { input: AiReviewInput }): {
  model: string;
  output: PromptOutput;
} {
  const findings: PromptFindingOutput[] = request.input.failedChecks.map((check, index) => ({
    issue_id: `AI-${String(index + 1).padStart(3, "0")}-${normalizeToken(check.id)}`,
    severity: severityFromCheckId(check.id),
    impact: `Gate check ${check.id} is ${check.status} and affects profile ${request.input.profile}.`,
    recommendation: recommendationFromCheckId(check.id),
    reason_code: `ai.gemini.review.finding.${normalizeToken(check.id)}`,
    file_path: check.evidencePath,
    patch_hint: `Apply targeted fix for check ${check.id} around ${check.evidencePath}.`,
    acceptance_check: `Re-run gate and ensure ${check.id} is passed.`,
    risk_level: severityFromCheckId(check.id),
  }));
  return {
    model: "rule-llm-synth-v1",
    output: {
      summary:
        findings.length > 0
          ? `${findings.length} findings generated from gate checks`
          : "No findings",
      findings,
    },
  };
}

function buildNoArtifactsReport(
  input: AiReviewInput,
  options: GenerateAiReviewOptions,
): AiReviewReport {
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    runId: input.runId,
    profile: input.profile,
    target: input.target,
    severityThreshold: options.severityThreshold,
    candidates: input.candidates,
    findings: [],
    summary: {
      totalFindings: 0,
      highOrAbove: 0,
      candidateArtifacts: 0,
    },
    gate: {
      status: "blocked",
      reasonCode: AI_REVIEW_NO_ARTIFACTS,
    },
    generation: {
      mode: options.mode ?? "llm",
      promptId: AI_REVIEW_PROMPT_ID,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      model: "none",
    },
  };
}

function resolveFindings(
  input: AiReviewInput,
  options: GenerateAiReviewOptions,
): {
  findings: AiReviewFinding[];
  mode: AiReviewGenerationMode;
  model: string;
} {
  const mode = options.mode ?? "llm";

  if (mode === "rule_fallback") {
    return {
      findings: buildFallbackFindings(input),
      mode,
      model: "rule-fallback-v1",
    };
  }

  const promptContext = buildAiReviewPromptContext(input, options);
  const llmGenerate = options.llmGenerate ?? defaultLlmGenerate;
  const response = llmGenerate({
    prompt: promptContext.prompt,
    input,
    options: { severityThreshold: options.severityThreshold },
  });
  const parsed = parsePromptOutput(response.output);
  const validation = validatePromptOutput<PromptOutput>(promptContext.definition, parsed);
  if (!validation.ok) {
    throw new AiReviewGenerationError(
      AI_REVIEW_LLM_SCHEMA_INVALID,
      `AI review LLM output failed schema validation: ${formatValidationIssues(validation.issues)}`,
    );
  }

  return {
    findings: mapPromptFindingsToReport(input, validation.value),
    mode,
    model: response.model,
  };
}

export function generateAiReviewReport(
  input: AiReviewInput,
  options: GenerateAiReviewOptions,
): AiReviewReport {
  if (input.candidates.length === 0) {
    return buildNoArtifactsReport(input, options);
  }

  const resolved = resolveFindings(input, options);
  const findings = [...resolved.findings];

  findings.sort((left, right) => {
    if (severityRank(right.severity) !== severityRank(left.severity)) {
      return severityRank(right.severity) - severityRank(left.severity);
    }
    return left.issue_id.localeCompare(right.issue_id);
  });

  const highOrAbove = findings.filter((item) => isSeverityAtOrAbove(item.severity, "high")).length;
  const thresholdHits = findings.filter((item) =>
    isSeverityAtOrAbove(item.severity, options.severityThreshold),
  ).length;

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    runId: input.runId,
    profile: input.profile,
    target: input.target,
    severityThreshold: options.severityThreshold,
    candidates: input.candidates,
    findings,
    summary: {
      totalFindings: findings.length,
      highOrAbove,
      candidateArtifacts: input.candidates.length,
    },
    gate: {
      status: thresholdHits > 0 ? "failed" : "passed",
      reasonCode:
        thresholdHits > 0 ? AI_REVIEW_HIGH_FINDINGS : "gate.ai_review.passed.threshold_met",
    },
    generation: {
      mode: resolved.mode,
      promptId: AI_REVIEW_PROMPT_ID,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      model: resolved.model,
    },
  };
}

export function renderAiReviewMarkdown(report: AiReviewReport): string {
  const lines: string[] = [];
  lines.push("## UIQ AI Review");
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Profile: \`${report.profile}\``);
  lines.push(`- Target: \`${report.target.type}/${report.target.name}\``);
  lines.push(`- Gate: **${report.gate.status}**`);
  lines.push(`- reasonCode: \`${report.gate.reasonCode}\``);
  lines.push(`- Mode: \`${report.generation.mode}\``);
  lines.push(`- Prompt: \`${report.generation.promptId}@${report.generation.promptVersion}\``);
  lines.push(`- Model: \`${report.generation.model}\``);
  lines.push(
    `- Findings: **${report.summary.totalFindings}** (highOrAbove=${report.summary.highOrAbove})`,
  );
  lines.push(`- Candidate Artifacts: **${report.summary.candidateArtifacts}**`);
  lines.push("");
  lines.push(
    "| issue_id | severity | risk_level | reason_code | file_path | impact | evidence | recommendation | acceptance_check | acceptance |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  if (report.findings.length === 0) {
    lines.push("| none | n/a | n/a | n/a | n/a | no findings | n/a | n/a | n/a | n/a |");
  } else {
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.issue_id} | ${finding.severity} | ${finding.risk_level} | ${finding.reason_code.replaceAll("|", "\\|")} | ${finding.file_path.replaceAll("|", "\\|")} | ${finding.impact.replaceAll("|", "\\|")} | ${finding.evidence.join(", ").replaceAll("|", "\\|")} | ${finding.recommendation.replaceAll("|", "\\|")} | ${finding.acceptance_check.replaceAll("|", "\\|")} | ${finding.acceptance.replaceAll("|", "\\|")} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeAiReviewReportArtifacts(
  baseDir: string,
  report: AiReviewReport,
  jsonRelativePath: string,
  markdownRelativePath: string,
): { jsonPath: string; markdownPath: string } {
  const jsonPath = resolve(baseDir, jsonRelativePath);
  const markdownPath = resolve(baseDir, markdownRelativePath);
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderAiReviewMarkdown(report), "utf8");
  return { jsonPath: jsonRelativePath, markdownPath: markdownRelativePath };
}
