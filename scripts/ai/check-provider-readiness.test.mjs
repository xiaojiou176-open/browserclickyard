import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-provider-readiness.mjs", import.meta.url));

function createBaseEnv() {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    VIDEO_ANALYZER_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "gemini-3.1-pro-preview",
    GEMINI_FAST_MODEL: "gemini-3.0-flash",
    GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
    GEMINI_COMPUTER_USE_MODEL: "gemini-3.1-pro-preview",
    GEMINI_FALLBACK_MODELS: "gemini-3.1-pro-preview,gemini-3.0-pro,gemini-3.0-flash",
    GEMINI_THINKING_LEVEL: "high",
    GEMINI_TOOL_MODE: "validated",
    GEMINI_INCLUDE_THOUGHTS: "true",
    GEMINI_CONTEXT_CACHE_MODE: "memory",
    GEMINI_CONTEXT_CACHE_TTL_SECONDS: "3600",
  };
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("OPENAI_") && !key.startsWith("ANTHROPIC_")) {
      continue;
    }
    delete env[key];
  }
  return env;
}

function runReadiness(overrides = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...createBaseEnv(), ...overrides },
    encoding: "utf8",
  });
}

test("ai readiness passes for controlled Gemini role contract", () => {
  const result = runReadiness();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Strict provider readiness passed/);
});

test("ai readiness fails when primary model is outside controlled role list", () => {
  const result = runReadiness({ GEMINI_MODEL: "gemini-2.5-pro" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside controlled allowlist/);
});

test("ai readiness passes when primary role uses gemini-3.0-pro", () => {
  const result = runReadiness({ GEMINI_MODEL: "gemini-3.0-pro" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Strict provider readiness passed/);
});

test("ai readiness fails when computer-use model is outside controlled role list", () => {
  const result = runReadiness({ GEMINI_COMPUTER_USE_MODEL: "gemini-3.0-flash" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside controlled allowlist/);
});

test("ai readiness fails when fallback model chain is outside controlled allowlist", () => {
  const result = runReadiness({
    GEMINI_FALLBACK_MODELS: "gemini-3.1-pro-preview,gemini-2.5-pro,gemini-3.0-flash",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fallback model 'gemini-2.5-pro' is outside controlled allowlist/);
});

test("ai readiness fails when Anthropic env vars are present", () => {
  const result = runReadiness({ ANTHROPIC_API_KEY: "test-anthropic-key" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Anthropic env vars are forbidden in strict mode/);
});

test("ai readiness fails when context cache mode is invalid", () => {
  const result = runReadiness({ GEMINI_CONTEXT_CACHE_MODE: "redis" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GEMINI_CONTEXT_CACHE_MODE must be one of/);
});
