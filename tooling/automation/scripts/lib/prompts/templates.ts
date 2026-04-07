import { DEFAULT_PROMPT_MODEL_STRATEGY, type PromptTemplateBundle } from "../prompt-metadata.js";

export type PromptTemplateId = "ui_flow_step_extractor";

const PROMPT_TEMPLATES: Record<PromptTemplateId, PromptTemplateBundle> = {
  ui_flow_step_extractor: {
    metadata: {
      prompt_id: "gemini.ui_flow.step_extractor",
      version: "1.0.0",
      model_strategy: DEFAULT_PROMPT_MODEL_STRATEGY,
    },
    layers: {
      system: [
        "You are a deterministic automation analyst for web UI traces.",
        "Return valid JSON only and never wrap output in markdown.",
        "If evidence is incomplete, lower confidence instead of guessing.",
      ].join("\n"),
      task: [
        "Infer replayable candidate steps from the evidence.",
        "Input summary:",
        "- scenario_summary: {{scenario_summary}}",
        "- transcript_excerpt: {{transcript_excerpt}}",
        "- event_digest: {{event_digest}}",
        "- network_digest: {{network_digest}}",
      ].join("\n"),
      schema: [
        "Output JSON schema:",
        "{",
        '  "detectedSignals": ["string"],',
        '  "candidateSteps": [',
        "    {",
        '      "step_id": "s1",',
        '      "action": "navigate|click|type|manual_gate",',
        '      "url": "string optional",',
        '      "value_ref": "string optional",',
        '      "target": { "selectors": [{ "kind": "role|id|name|css", "value": "string", "score": 0 }] },',
        '      "confidence": 0.0,',
        '      "evidence_ref": "string",',
        '      "unsupported_reason": "string optional"',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
      rubric: [
        "Rubric:",
        "1) Preserve chronological order and avoid invented actions.",
        "2) Prefer selectors by stability: role, id, name, css.",
        "3) Keep sensitive input redacted and use value_ref tokens.",
        "4) If otp, captcha, or cloudflare is detected, include manual_gate.",
        "5) Confidence must be within [0, 1].",
      ].join("\n"),
    },
  },
};

export function listPromptTemplateIds(): PromptTemplateId[] {
  return Object.keys(PROMPT_TEMPLATES) as PromptTemplateId[];
}

export function getPromptBundle(templateId: PromptTemplateId): PromptTemplateBundle {
  const template = PROMPT_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Unknown prompt template: ${templateId}`);
  }
  return {
    metadata: { ...template.metadata },
    layers: { ...template.layers },
  };
}
