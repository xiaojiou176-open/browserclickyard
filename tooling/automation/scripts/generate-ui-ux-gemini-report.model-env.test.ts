import assert from "node:assert/strict";
import test from "node:test";

import { resolveGeminiModelFromEnv } from "./generate-ui-ux-gemini-report.js";

test("resolveGeminiModelFromEnv uses primary model in normal mode", () => {
  const model = resolveGeminiModelFromEnv(false, {
    GEMINI_MODEL: "models/gemini-3.1-pro-preview",
    GEMINI_FAST_MODEL: "models/gemini-3.0-flash",
  });

  assert.equal(model, "models/gemini-3.1-pro-preview");
});

test("resolveGeminiModelFromEnv uses flash model in speed mode", () => {
  const model = resolveGeminiModelFromEnv(true, {
    GEMINI_MODEL: "models/gemini-3.1-pro-preview",
    GEMINI_FAST_MODEL: "models/gemini-3.0-flash",
  });

  assert.equal(model, "models/gemini-3.0-flash");
});

test("resolveGeminiModelFromEnv fails fast when speed mode lacks GEMINI_FAST_MODEL", () => {
  assert.throws(
    () =>
      resolveGeminiModelFromEnv(true, {
        GEMINI_MODEL: "models/gemini-3.1-pro-preview",
      }),
    /ai\.gemini\.unavailable\.missing_model_env[\s\S]*GEMINI_FAST_MODEL/,
  );
});

test("resolveGeminiModelFromEnv fails fast when normal mode lacks GEMINI_MODEL", () => {
  assert.throws(
    () =>
      resolveGeminiModelFromEnv(false, {
        GEMINI_FAST_MODEL: "models/gemini-3.0-flash",
      }),
    /ai\.gemini\.unavailable\.missing_model_env[\s\S]*GEMINI_MODEL/,
  );
});
