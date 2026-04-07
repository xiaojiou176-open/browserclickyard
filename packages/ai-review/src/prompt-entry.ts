import {
  getPromptDefinition,
  type PromptDefinition,
  renderTemplate,
} from "../../ai-prompts/src/index.js";
import { formatValidationIssues, validatePromptInput } from "../../ai-prompts/src/validate.js";
import type { AiReviewInput } from "./build-input.js";

export const AI_REVIEW_PROMPT_ID = "ai_review.findings_summary";
export const AI_REVIEW_PROMPT_VERSION = "1.1.0";

export type AiReviewPromptVariables = {
  runId: string;
  profile: string;
  targetType: string;
  targetName: string;
  severityThreshold: string;
  candidateArtifacts: number;
  failedChecksJson: string;
};

type AiReviewPromptRenderOptions = {
  severityThreshold: "critical" | "high" | "medium" | "low";
};

export type AiReviewPromptContext = {
  promptId: typeof AI_REVIEW_PROMPT_ID;
  promptVersion: typeof AI_REVIEW_PROMPT_VERSION;
  definition: PromptDefinition;
  variables: AiReviewPromptVariables;
  prompt: string;
};

export function buildAiReviewPromptVariables(
  input: AiReviewInput,
  options: AiReviewPromptRenderOptions,
): AiReviewPromptVariables {
  return {
    runId: input.runId,
    profile: input.profile,
    targetType: input.target.type,
    targetName: input.target.name,
    severityThreshold: options.severityThreshold,
    candidateArtifacts: input.candidates.length,
    failedChecksJson: JSON.stringify(input.failedChecks, null, 2),
  };
}

export function renderAiReviewPrompt(
  input: AiReviewInput,
  options: AiReviewPromptRenderOptions,
): string {
  return buildAiReviewPromptContext(input, options).prompt;
}

export function buildAiReviewPromptContext(
  input: AiReviewInput,
  options: AiReviewPromptRenderOptions,
): AiReviewPromptContext {
  const definition = getPromptDefinition(AI_REVIEW_PROMPT_ID, AI_REVIEW_PROMPT_VERSION);
  const variables = buildAiReviewPromptVariables(input, options);
  const validation = validatePromptInput<AiReviewPromptVariables>(definition, variables);
  if (!validation.ok) {
    throw new Error(`Invalid AI review prompt input: ${formatValidationIssues(validation.issues)}`);
  }
  return {
    promptId: AI_REVIEW_PROMPT_ID,
    promptVersion: AI_REVIEW_PROMPT_VERSION,
    definition,
    variables,
    prompt: renderTemplate(definition.template, variables),
  };
}
