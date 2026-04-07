export const DEFAULT_PROMPT_MODEL_STRATEGY = "gemini-3.1-pro-preview";

export type PromptLayerKey = "system" | "task" | "schema" | "rubric";

export type PromptLayers = {
  system: string;
  task: string;
  schema: string;
  rubric: string;
};

export type PromptTemplateMetadata = {
  prompt_id: string;
  version: string;
  model_strategy: string;
};

export type PromptTemplateBundle = {
  metadata: PromptTemplateMetadata;
  layers: PromptLayers;
};

export type PromptOutputMetadata = {
  prompt_id: string;
  prompt_version: string;
  model_strategy: string;
};

export function toPromptOutputMetadata(metadata: PromptTemplateMetadata): PromptOutputMetadata {
  return {
    prompt_id: metadata.prompt_id,
    prompt_version: metadata.version,
    model_strategy: metadata.model_strategy,
  };
}
