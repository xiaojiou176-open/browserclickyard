import type { PromptDefinition, PromptFieldSchema, PromptSchema } from "./registry.js";

export type PromptValidationIssue = {
  path: string;
  message: string;
};

export type PromptValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: PromptValidationIssue[] };

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFieldSchema(
  schema: PromptFieldSchema,
  value: unknown,
  path: string,
  issues: PromptValidationIssue[],
): void {
  switch (schema.type) {
    case "string":
    case "number":
    case "boolean": {
      if (typeof value !== schema.type) {
        issues.push({ path, message: `Expected ${schema.type}, received ${typeof value}` });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `Expected array, received ${typeof value}` });
        return;
      }
      value.forEach((item, index) =>
        validateFieldSchema(schema.items, item, `${path}[${index}]`, issues),
      );
      return;
    }
    case "object": {
      if (!isJsonObject(value)) {
        issues.push({ path, message: `Expected object, received ${typeof value}` });
        return;
      }

      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in value)) {
          issues.push({ path: `${path}.${key}`, message: "Missing required property" });
        }
      }

      const properties = schema.properties ?? {};
      for (const key of Object.keys(properties)) {
        const propertySchema = properties[key];
        if (key in value && propertySchema) {
          validateFieldSchema(propertySchema, value[key], `${path}.${key}`, issues);
        }
      }

      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(properties));
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            issues.push({ path: `${path}.${key}`, message: "Unexpected property" });
          }
        }
      }
      return;
    }
  }
}

export function validateAgainstSchema<T extends JsonObject>(
  schema: PromptSchema,
  value: unknown,
): PromptValidationResult<T> {
  const issues: PromptValidationIssue[] = [];
  validateFieldSchema(schema, value, "$", issues);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as T };
}

export function validatePromptInput<T extends JsonObject>(
  definition: Pick<PromptDefinition, "inputSchema">,
  value: unknown,
): PromptValidationResult<T> {
  return validateAgainstSchema<T>(definition.inputSchema, value);
}

export function validatePromptOutput<T extends JsonObject>(
  definition: Pick<PromptDefinition, "outputSchema">,
  value: unknown,
): PromptValidationResult<T> {
  return validateAgainstSchema<T>(definition.outputSchema, value);
}

export function formatValidationIssues(issues: PromptValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}
