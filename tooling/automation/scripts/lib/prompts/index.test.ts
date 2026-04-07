import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROMPT_MODEL_STRATEGY } from "../prompt-metadata.js";
import { getPromptBundle, usePromptTemplate } from "./index.js";

test("getPromptBundle returns template metadata with default gemini model strategy", () => {
  const bundle = getPromptBundle("ui_flow_step_extractor");

  assert.equal(bundle.metadata.prompt_id, "gemini.ui_flow.step_extractor");
  assert.equal(bundle.metadata.version, "1.0.0");
  assert.equal(bundle.metadata.model_strategy, DEFAULT_PROMPT_MODEL_STRATEGY);
  assert.ok(bundle.layers.system.length > 0);
  assert.ok(bundle.layers.task.length > 0);
  assert.ok(bundle.layers.schema.length > 0);
  assert.ok(bundle.layers.rubric.length > 0);
});

test("usePromptTemplate renders four layers and provides output metadata for tracing", () => {
  const result = usePromptTemplate("ui_flow_step_extractor", {
    scenario_summary: "user logs in and opens dashboard",
    transcript_excerpt: "click login, type email, type password, submit",
    event_digest: "navigate->type->type->click",
    network_digest: "POST /login 200",
  });

  assert.match(result.prompt, /### SYSTEM/);
  assert.match(result.prompt, /### TASK/);
  assert.match(result.prompt, /### SCHEMA/);
  assert.match(result.prompt, /### RUBRIC/);

  assert.equal(result.outputMetadata.prompt_id, "gemini.ui_flow.step_extractor");
  assert.equal(result.outputMetadata.prompt_version, "1.0.0");
  assert.equal(result.outputMetadata.model_strategy, DEFAULT_PROMPT_MODEL_STRATEGY);
  assert.match(result.layers.task, /user logs in and opens dashboard/);
});

test("usePromptTemplate throws when required placeholders are missing", () => {
  assert.throws(
    () =>
      usePromptTemplate("ui_flow_step_extractor", {
        scenario_summary: "missing values",
      }),
    /Missing prompt template input/,
  );
});
