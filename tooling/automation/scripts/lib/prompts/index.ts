import {
  type PromptLayers,
  type PromptOutputMetadata,
  type PromptTemplateMetadata,
  toPromptOutputMetadata,
} from "../prompt-metadata.js";
import {
  getPromptBundle as getPromptBundleFromRegistry,
  listPromptTemplateIds,
  type PromptTemplateId,
} from "./templates.js";

type PromptInputValue = string | number | boolean | null | undefined;
export type PromptTemplateInput = Record<string, PromptInputValue>;

export type PromptTemplateResult = {
  metadata: PromptTemplateMetadata;
  outputMetadata: PromptOutputMetadata;
  layers: PromptLayers;
  prompt: string;
};

const LAYER_ORDER = ["system", "task", "schema", "rubric"] as const;
const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

function renderLayer(layerText: string, input: PromptTemplateInput): string {
  const missingKeys = new Set<string>();
  const rendered = layerText.replace(PLACEHOLDER_PATTERN, (raw, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) {
      missingKeys.add(key);
      return raw;
    }
    return String(value);
  });

  if (missingKeys.size > 0) {
    const missing = Array.from(missingKeys).sort().join(", ");
    throw new Error(`Missing prompt template input: ${missing}`);
  }
  return rendered;
}

function composePrompt(layers: PromptLayers): string {
  return LAYER_ORDER.map((key) => `### ${key.toUpperCase()}\n${layers[key]}`).join("\n\n");
}

export function getPromptBundle(templateId: PromptTemplateId) {
  return getPromptBundleFromRegistry(templateId);
}

export function usePromptTemplate(
  templateId: PromptTemplateId,
  input: PromptTemplateInput = {},
): PromptTemplateResult {
  const bundle = getPromptBundleFromRegistry(templateId);
  const renderedLayers: PromptLayers = {
    system: renderLayer(bundle.layers.system, input),
    task: renderLayer(bundle.layers.task, input),
    schema: renderLayer(bundle.layers.schema, input),
    rubric: renderLayer(bundle.layers.rubric, input),
  };

  return {
    metadata: bundle.metadata,
    outputMetadata: toPromptOutputMetadata(bundle.metadata),
    layers: renderedLayers,
    prompt: composePrompt(renderedLayers),
  };
}

export { listPromptTemplateIds };
export type { PromptTemplateId };
