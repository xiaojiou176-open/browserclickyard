#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRIMARY_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_FAST_MODEL = "gemini-3.0-flash";
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_COMPUTER_USE_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_FALLBACK_MODELS = ["gemini-3.1-pro-preview", "gemini-3.0-pro", "gemini-3.0-flash"];

const CONTROLLED_MODEL_ROLES = Object.freeze({
  primary: new Set(["gemini-3.1-pro-preview", "gemini-3.0-pro"]),
  fast: new Set(["gemini-3.0-flash"]),
  embedding: new Set([DEFAULT_EMBEDDING_MODEL]),
  computerUse: new Set([DEFAULT_PRIMARY_MODEL, "gemini-computer-use-preview"]),
});
const CONTROLLED_FALLBACK_MODELS = new Set(DEFAULT_FALLBACK_MODELS);

const ALLOWED_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);
const ALLOWED_TOOL_MODES = new Set(["none", "auto", "any", "validated"]);
const ALLOWED_CONTEXT_CACHE_MODES = new Set(["memory", "api"]);
const ALLOWED_MEDIA_RESOLUTIONS = new Set(["low", "medium", "high", "native"]);
const KEY_NAMES = ["GEMINI_API_KEY"];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeModel(value) {
  return String(value)
    .trim()
    .replace(/^models\//, "");
}

function stripWrappingQuotes(raw) {
  const value = String(raw).trim();
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function readEnvValueFromRootFile(targetKeys) {
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return "";
  }
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!targetKeys.has(key)) {
      continue;
    }
    const rawValue = match[2].split(/\s+#/, 1)[0] ?? "";
    const parsed = stripWrappingQuotes(rawValue);
    if (hasValue(parsed)) {
      return parsed;
    }
  }
  return "";
}

function readProvider() {
  const raw = process.env.VIDEO_ANALYZER_PROVIDER;
  if (!hasValue(raw)) {
    return "gemini";
  }
  return String(raw).trim().toLowerCase();
}

function collectOpenAiEnvVars() {
  return Object.keys(process.env)
    .filter((key) => key.startsWith("OPENAI_"))
    .sort();
}

function collectAnthropicEnvVars() {
  return Object.keys(process.env)
    .filter((key) => key.startsWith("ANTHROPIC_"))
    .sort();
}

function readGeminiKey() {
  if (hasValue(process.env.GEMINI_API_KEY)) {
    return String(process.env.GEMINI_API_KEY).trim();
  }
  return readEnvValueFromRootFile(new Set(KEY_NAMES));
}

function normalizeBool(value) {
  if (!hasValue(value)) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeNonNegativeInteger(value) {
  if (!hasValue(value)) {
    return null;
  }
  if (!/^\d+$/.test(String(value).trim())) {
    return null;
  }
  return Number.parseInt(String(value).trim(), 10);
}

function parseCsvModels(raw, fallbackList) {
  if (!hasValue(raw)) {
    return fallbackList.slice();
  }
  const values = String(raw)
    .split(",")
    .map((entry) => sanitizeModel(entry))
    .filter((entry) => hasValue(entry));
  return values.length > 0 ? values : fallbackList.slice();
}

function readModelByRole(role) {
  if (role === "primary") {
    if (hasValue(process.env.GEMINI_MODEL)) {
      return sanitizeModel(process.env.GEMINI_MODEL);
    }
    return DEFAULT_PRIMARY_MODEL;
  }
  if (role === "fast") {
    if (hasValue(process.env.GEMINI_FAST_MODEL)) {
      return sanitizeModel(process.env.GEMINI_FAST_MODEL);
    }
    return DEFAULT_FAST_MODEL;
  }
  if (role === "computerUse") {
    if (hasValue(process.env.GEMINI_COMPUTER_USE_MODEL)) {
      return sanitizeModel(process.env.GEMINI_COMPUTER_USE_MODEL);
    }
    if (hasValue(process.env.GEMINI_MODEL)) {
      return sanitizeModel(process.env.GEMINI_MODEL);
    }
    return DEFAULT_COMPUTER_USE_MODEL;
  }
  if (hasValue(process.env.GEMINI_EMBEDDING_MODEL)) {
    return sanitizeModel(process.env.GEMINI_EMBEDDING_MODEL);
  }
  return DEFAULT_EMBEDDING_MODEL;
}

function fail(_message) {
  process.exit(1);
}

function validateControlledModels() {
  const primaryModel = readModelByRole("primary");
  const fastModel = readModelByRole("fast");
  const embeddingModel = readModelByRole("embedding");
  const computerUseModel = readModelByRole("computerUse");
  const roleModelMap = {
    primary: primaryModel,
    fast: fastModel,
    embedding: embeddingModel,
    computerUse: computerUseModel,
  };

  for (const [role, model] of Object.entries(roleModelMap)) {
    const controlled = CONTROLLED_MODEL_ROLES[role];
    if (!controlled.has(model)) {
      fail(
        `${role} model '${model}' is outside controlled allowlist (${Array.from(controlled).join(", ")}).`,
      );
    }
  }

  const signature = `${primaryModel}|${fastModel}|${embeddingModel}|${computerUseModel}`;
  if (
    primaryModel === fastModel ||
    primaryModel === embeddingModel ||
    fastModel === embeddingModel
  ) {
    fail(
      `Gemini model role signature must keep primary/fast/embedding distinct, got '${signature}'.`,
    );
  }
  const fallbackChain = parseCsvModels(process.env.GEMINI_FALLBACK_MODELS, DEFAULT_FALLBACK_MODELS);
  const fallbackSignature = fallbackChain.join(" -> ");
  for (const model of fallbackChain) {
    if (!CONTROLLED_FALLBACK_MODELS.has(model)) {
      fail(
        `fallback model '${model}' is outside controlled allowlist (${Array.from(CONTROLLED_FALLBACK_MODELS).join(", ")}).`,
      );
    }
  }
  if (fallbackChain.length < 3) {
    fail(`GEMINI_FALLBACK_MODELS must include at least 3 entries, got '${fallbackSignature}'.`);
  }
  if (
    fallbackChain[0] !== DEFAULT_FALLBACK_MODELS[0] ||
    fallbackChain[1] !== DEFAULT_FALLBACK_MODELS[1] ||
    fallbackChain[2] !== DEFAULT_FALLBACK_MODELS[2]
  ) {
    fail(
      `GEMINI_FALLBACK_MODELS must start with '${DEFAULT_FALLBACK_MODELS.join(",")}', got '${fallbackChain.join(",")}'.`,
    );
  }

  return {
    primaryModel,
    fastModel,
    embeddingModel,
    computerUseModel,
    signature,
    fallbackSignature,
  };
}

function validateThinkingAndCacheConfig() {
  const thinkingLevel = hasValue(process.env.GEMINI_THINKING_LEVEL)
    ? String(process.env.GEMINI_THINKING_LEVEL).trim().toLowerCase()
    : "high";
  if (!ALLOWED_THINKING_LEVELS.has(thinkingLevel)) {
    fail(
      `GEMINI_THINKING_LEVEL must be one of ${Array.from(ALLOWED_THINKING_LEVELS).join(", ")}, got '${thinkingLevel}'.`,
    );
  }

  const toolMode = hasValue(process.env.GEMINI_TOOL_MODE)
    ? String(process.env.GEMINI_TOOL_MODE).trim().toLowerCase()
    : "auto";
  if (!ALLOWED_TOOL_MODES.has(toolMode)) {
    fail(
      `GEMINI_TOOL_MODE must be one of ${Array.from(ALLOWED_TOOL_MODES).join(", ")}, got '${toolMode}'.`,
    );
  }

  const includeThoughtsRaw = hasValue(process.env.GEMINI_INCLUDE_THOUGHTS)
    ? String(process.env.GEMINI_INCLUDE_THOUGHTS)
    : "true";
  const includeThoughts = normalizeBool(includeThoughtsRaw);
  if (includeThoughts === null) {
    fail(`GEMINI_INCLUDE_THOUGHTS must be a boolean-like value, got '${includeThoughtsRaw}'.`);
  }
  if (includeThoughts !== true) {
    fail("GEMINI_INCLUDE_THOUGHTS must be true in strict unified mode.");
  }

  const cacheMode = hasValue(process.env.GEMINI_CONTEXT_CACHE_MODE)
    ? String(process.env.GEMINI_CONTEXT_CACHE_MODE).trim().toLowerCase()
    : "memory";
  if (!ALLOWED_CONTEXT_CACHE_MODES.has(cacheMode)) {
    fail(
      `GEMINI_CONTEXT_CACHE_MODE must be one of ${Array.from(ALLOWED_CONTEXT_CACHE_MODES).join(", ")}, got '${cacheMode}'.`,
    );
  }

  const cacheTtlRaw = hasValue(process.env.GEMINI_CONTEXT_CACHE_TTL_SECONDS)
    ? String(process.env.GEMINI_CONTEXT_CACHE_TTL_SECONDS)
    : "3600";
  const cacheTtl = normalizeNonNegativeInteger(cacheTtlRaw);
  if (cacheTtl === null) {
    fail(`GEMINI_CONTEXT_CACHE_TTL_SECONDS must be a non-negative integer, got '${cacheTtlRaw}'.`);
  }
  if (cacheTtl < 60) {
    fail(`GEMINI_CONTEXT_CACHE_TTL_SECONDS must be >= 60, got '${cacheTtl}'.`);
  }
  if (cacheTtl > 86400) {
    fail(`GEMINI_CONTEXT_CACHE_TTL_SECONDS must be <= 86400, got '${cacheTtl}'.`);
  }

  const mediaResolutionDefault = hasValue(process.env.GEMINI_MEDIA_RESOLUTION_DEFAULT)
    ? String(process.env.GEMINI_MEDIA_RESOLUTION_DEFAULT).trim().toLowerCase()
    : "high";
  if (!ALLOWED_MEDIA_RESOLUTIONS.has(mediaResolutionDefault)) {
    fail(
      `GEMINI_MEDIA_RESOLUTION_DEFAULT must be one of ${Array.from(ALLOWED_MEDIA_RESOLUTIONS).join(", ")}, got '${mediaResolutionDefault}'.`,
    );
  }
  if (mediaResolutionDefault !== "high") {
    fail(
      `GEMINI_MEDIA_RESOLUTION_DEFAULT must be 'high' in strict unified mode, got '${mediaResolutionDefault}'.`,
    );
  }

  if (hasValue(process.env.GEMINI_MEDIA_RESOLUTION)) {
    const mediaResolution = String(process.env.GEMINI_MEDIA_RESOLUTION).trim().toLowerCase();
    if (!ALLOWED_MEDIA_RESOLUTIONS.has(mediaResolution)) {
      fail(
        `GEMINI_MEDIA_RESOLUTION must be one of ${Array.from(ALLOWED_MEDIA_RESOLUTIONS).join(", ")}, got '${mediaResolution}'.`,
      );
    }
  }

  return { thinkingLevel, toolMode, cacheMode, cacheTtl, mediaResolutionDefault };
}

function runGeminiUnifiedAdvancedGate() {
  const scriptPath = path.resolve(
    process.cwd(),
    "scripts/ci/check-gemini-advanced-unification.mjs",
  );
  const result = spawnSync(process.execPath, [scriptPath], {
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown gate failure").trim();
    fail(`Gemini advanced unification gate failed: ${detail}`);
  }
}

function checkProviderReadiness() {
  const provider = readProvider();
  const openAiVars = collectOpenAiEnvVars();
  const anthropicVars = collectAnthropicEnvVars();
  const geminiKey = readGeminiKey();

  if (provider !== "gemini") {
    fail(`VIDEO_ANALYZER_PROVIDER must be 'gemini', got '${provider}'.`);
  }

  if (openAiVars.length > 0) {
    fail(`OpenAI env vars are forbidden in strict mode: ${openAiVars.join(", ")}`);
  }
  if (anthropicVars.length > 0) {
    fail(`Anthropic env vars are forbidden in strict mode: ${anthropicVars.join(", ")}`);
  }

  if (!geminiKey) {
    fail("GEMINI_API_KEY is required in strict mode.");
  }

  const _modelGuard = validateControlledModels();
  const _configGuard = validateThinkingAndCacheConfig();
  runGeminiUnifiedAdvancedGate();
}

checkProviderReadiness();
