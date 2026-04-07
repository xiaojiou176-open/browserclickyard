import { getPromptDefinition } from "./registry.js";
import { formatValidationIssues, validatePromptInput } from "./validate.js";

export type PromptVariables = Record<string, unknown>;

const TEMPLATE_TOKEN_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;

function valueToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function readVariable(variables: PromptVariables, token: string): unknown {
  const segments = token.split(".");
  let current: unknown = variables;

  for (const segment of segments) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function collectTemplateVariables(template: string): string[] {
  const matches = template.matchAll(TEMPLATE_TOKEN_PATTERN);
  const unique = new Set<string>();
  for (const match of matches) {
    const token = match[1];
    if (token) {
      unique.add(token);
    }
  }
  return [...unique].sort();
}

export function renderTemplate(template: string, variables: PromptVariables): string {
  const missing = new Set<string>();

  const output = template.replace(TEMPLATE_TOKEN_PATTERN, (_, token: string) => {
    const value = readVariable(variables, token);
    if (value === undefined) {
      missing.add(token);
      return "";
    }
    return valueToString(value);
  });

  if (missing.size > 0) {
    throw new Error(`Missing template variables: ${[...missing].sort().join(", ")}`);
  }

  return output;
}

export function renderPrompt(
  promptId: string,
  variables: PromptVariables,
  version?: string,
): string {
  const definition = getPromptDefinition(promptId, version);
  const validation = validatePromptInput(definition, variables);
  if (!validation.ok) {
    throw new Error(`Prompt input validation failed: ${formatValidationIssues(validation.issues)}`);
  }
  return renderTemplate(definition.template, variables);
}
