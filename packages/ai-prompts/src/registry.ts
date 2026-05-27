export type PromptPrimitiveType = "string" | "number" | "boolean";

export type PromptFieldSchema =
  | { type: PromptPrimitiveType }
  | { type: "array"; items: PromptFieldSchema }
  | {
      type: "object";
      required?: string[];
      properties?: Record<string, PromptFieldSchema>;
      additionalProperties?: boolean;
    };

export type PromptSchema = {
  type: "object";
  required?: string[];
  properties: Record<string, PromptFieldSchema>;
  additionalProperties?: boolean;
};

export type PromptDefinition = {
  id: string;
  version: string;
  description: string;
  template: string;
  inputSchema: PromptSchema;
  outputSchema: PromptSchema;
};

const promptRegistry: Record<string, Record<string, PromptDefinition>> = {
  "ai_review.findings_summary": {
    "1.0.0": {
      id: "ai_review.findings_summary",
      version: "1.0.0",
      description: "Generate a deterministic AI-review findings summary from gate evidence.",
      template: [
        "You are the UIQ AI review assistant.",
        "Run ID: {{runId}}",
        "Profile: {{profile}}",
        "Target: {{targetType}}/{{targetName}}",
        "Severity threshold: {{severityThreshold}}",
        "Candidate artifacts: {{candidateArtifacts}}",
        "",
        "Failed checks JSON:",
        "{{failedChecksJson}}",
        "",
        "Return strict JSON with: findings[] and summary.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        required: [
          "runId",
          "profile",
          "targetType",
          "targetName",
          "severityThreshold",
          "candidateArtifacts",
          "failedChecksJson",
        ],
        properties: {
          runId: { type: "string" },
          profile: { type: "string" },
          targetType: { type: "string" },
          targetName: { type: "string" },
          severityThreshold: { type: "string" },
          candidateArtifacts: { type: "number" },
          failedChecksJson: { type: "string" },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["summary", "findings"],
        properties: {
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["issue_id", "severity", "impact", "recommendation"],
              properties: {
                issue_id: { type: "string" },
                severity: { type: "string" },
                impact: { type: "string" },
                recommendation: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    "1.1.0": {
      id: "ai_review.findings_summary",
      version: "1.1.0",
      description: "Generate a deterministic AI-review findings summary from gate evidence.",
      template: [
        "You are the UIQ AI review assistant.",
        "Run ID: {{runId}}",
        "Profile: {{profile}}",
        "Target: {{targetType}}/{{targetName}}",
        "Severity threshold: {{severityThreshold}}",
        "Candidate artifacts: {{candidateArtifacts}}",
        "",
        "Failed checks JSON:",
        "{{failedChecksJson}}",
        "",
        "Return strict JSON with: findings[] and summary.",
        "Each finding must include reason_code, file_path, patch_hint, acceptance_check, risk_level.",
        "reason_code must start with one of: gate.ai_fix., gate.ai_review., ai.gemini.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        required: [
          "runId",
          "profile",
          "targetType",
          "targetName",
          "severityThreshold",
          "candidateArtifacts",
          "failedChecksJson",
        ],
        properties: {
          runId: { type: "string" },
          profile: { type: "string" },
          targetType: { type: "string" },
          targetName: { type: "string" },
          severityThreshold: { type: "string" },
          candidateArtifacts: { type: "number" },
          failedChecksJson: { type: "string" },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["summary", "findings"],
        properties: {
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              required: [
                "issue_id",
                "severity",
                "impact",
                "recommendation",
                "reason_code",
                "file_path",
                "patch_hint",
                "acceptance_check",
                "risk_level",
              ],
              properties: {
                issue_id: { type: "string" },
                severity: { type: "string" },
                impact: { type: "string" },
                recommendation: { type: "string" },
                reason_code: { type: "string" },
                file_path: { type: "string" },
                patch_hint: { type: "string" },
                acceptance_check: { type: "string" },
                risk_level: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
};

function parseVersion(version: string): number[] {
  return version
    .split(".")
    .map((segment) => Number(segment))
    .map((segment) => (Number.isFinite(segment) ? segment : 0));
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const maxLen = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLen; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return rightValue - leftValue;
    }
  }
  return right.localeCompare(left);
}

export function listPromptDefinitions(): PromptDefinition[] {
  const definitions: PromptDefinition[] = [];
  for (const versions of Object.values(promptRegistry)) {
    for (const definition of Object.values(versions)) {
      definitions.push(definition);
    }
  }
  definitions.sort((left, right) => {
    if (left.id !== right.id) {
      return left.id.localeCompare(right.id);
    }
    return compareVersionDesc(left.version, right.version);
  });
  return definitions;
}

export function getPromptDefinition(promptId: string, version?: string): PromptDefinition {
  const versions = promptRegistry[promptId];
  if (!versions) {
    throw new Error(`Unknown prompt id: ${promptId}`);
  }

  if (version) {
    const definition = versions[version];
    if (!definition) {
      throw new Error(`Unknown prompt version: ${promptId}@${version}`);
    }
    return definition;
  }

  const newestVersion = Object.keys(versions).sort(compareVersionDesc)[0];
  if (!newestVersion) {
    throw new Error(`No prompt versions registered for id: ${promptId}`);
  }
  return versions[newestVersion];
}
