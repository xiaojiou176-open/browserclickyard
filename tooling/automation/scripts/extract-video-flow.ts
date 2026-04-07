import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  buildAiInputPack,
  type CapturedEvent,
  createContextCacheKey,
  readContextCache,
  type TranscriptItem,
  writeContextCache,
} from "./lib/ai-input-pack.js";
import { automationBool, automationEnv } from "./lib/env.js";

type SelectorCandidate = { kind: "role" | "css" | "id" | "name"; value: string; score: number };

export type CandidateStep = {
  step_id: string;
  action: "navigate" | "click" | "type" | "manual_gate" | "assert" | "wait_for" | "extract";
  url?: string;
  value_ref?: string;
  target?: {
    selectors: SelectorCandidate[];
  };
  confidence: number;
  source_engine: string;
  evidence_ref: string;
  unsupported_reason?: string;
};

export type ModelAnalysis = {
  detectedSignals: string[];
  candidateSteps: CandidateStep[];
  modelName?: string;
  analysisMeta?: {
    modelName: string;
    thinking: string;
    toolMode: string;
    mediaResolutionApplied: {
      default: string;
      perPart: Record<string, string>;
    };
    thoughtSummaryPresent: boolean;
  };
  thoughtSignatures?: {
    status: "present" | "missing" | "parse_failed";
    reasonCode: string;
    signatures: string[];
  };
};

type ProviderName = "gemini";

type ThinkingLevelName = "minimal" | "low" | "medium" | "high";
type GeminiThinkingLevel = ThinkingLevelName;
type GeminiToolMode = "none" | "auto" | "any" | "validated";
type GeminiQualityProfile = "pro" | "fast";
type GeminiMediaResolution = "low" | "medium" | "high";

type GeminiRuntimeOptions = {
  modelName: string;
  thinkingLevel: GeminiThinkingLevel;
  includeThoughts: boolean;
  toolMode: GeminiToolMode;
  qualityProfile: GeminiQualityProfile;
  mediaResolution: GeminiMediaResolution;
};

type ModelAttempt = {
  provider: ProviderName;
  status: "success" | "unavailable" | "failed";
  reasonCode: string;
  modelName?: string;
  detail?: string;
  analysis?: ModelAnalysis;
  cacheHit?: boolean;
  cacheKey?: string;
  cachePath?: string;
  thoughtSignatureStatus?: "present" | "missing" | "parse_failed";
  thoughtSignatureReasonCode?: string;
  thoughtSignatureCount?: number;
};

type ModelContextCache = {
  hit: boolean;
  key: string | null;
  path: string | null;
  modelName: string | null;
};

type ModelResolution = {
  selectedProvider: ProviderName | "none";
  reasonCode: string;
  fallbackUsed: boolean;
  attempts: ModelAttempt[];
  analysis: ModelAnalysis | null;
  contextCache: ModelContextCache;
  thoughtSignatures: {
    includeThoughtsEnabled: boolean;
    status: "present" | "missing" | "parse_failed";
    reasonCode: string;
    signatures: string[];
  };
};

type AnalyzeOptions = {
  cacheDir: string;
  runtime?: Partial<GeminiRuntimeOptions>;
};

type AnalyzeWithModelOptions = {
  cacheDir?: string;
  runtime?: Partial<GeminiRuntimeOptions>;
  provider?: string;
  analyzers?: {
    analyzeWithGeminiHelper?: (
      contextPayload: Record<string, unknown>,
      runtime: GeminiRuntimeOptions,
    ) => Promise<ModelAnalysis | null>;
  };
};

const RUNTIME_ROOT = path.resolve(process.cwd(), "..", ".runtime-cache", "automation");
const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";
const FAST_GEMINI_MODEL = "gemini-3.0-flash";
const DEFAULT_PROVIDER_POLICY = {
  provider: "gemini",
  primary: "gemini",
  fallback: "none",
  fallbackMode: "strict",
};

type ProviderPolicy = {
  sourcePath: string;
  provider: string;
  primary: string;
  fallback: string;
  fallbackMode: string;
  strictNoFallback: boolean;
};
const INVALID_ACTION_SCHEMA_REASON = "ai.gemini.invalid_action_schema";
const actionSchemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/core/src/ai/action-schema.json",
);

type ActionSchema = {
  actions: string[];
};

function loadActionSchemaActions(): string[] {
  const raw = readFileSync(actionSchemaPath, "utf-8");
  const parsed = JSON.parse(raw) as ActionSchema;
  if (
    !Array.isArray(parsed.actions) ||
    parsed.actions.some((action) => typeof action !== "string")
  ) {
    throw new Error(`invalid action schema at ${actionSchemaPath}`);
  }
  return parsed.actions;
}

export const ACTION_SCHEMA_ACTIONS = loadActionSchemaActions();
const ACTION_SCHEMA_SET = new Set(ACTION_SCHEMA_ACTIONS);

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function parseBoolOption(value: string | null | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseThinkingLevel(
  value: string | null | undefined,
  fallback: GeminiThinkingLevel = "high",
): GeminiThinkingLevel {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["minimal", "low", "medium", "high"].includes(normalized)) {
    return normalized as GeminiThinkingLevel;
  }
  return fallback;
}

function parseToolMode(
  value: string | null | undefined,
  fallback: GeminiToolMode = "auto",
): GeminiToolMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["none", "auto", "any", "validated"].includes(normalized)) {
    return normalized as GeminiToolMode;
  }
  return fallback;
}

function parseQualityProfile(
  value: string | null | undefined,
  fallback: GeminiQualityProfile = "pro",
): GeminiQualityProfile {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "fast" ? "fast" : fallback;
}

function parseMediaResolution(
  value: string | null | undefined,
  fallback: GeminiMediaResolution = "high",
): GeminiMediaResolution {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["low", "medium", "high"].includes(normalized)) {
    return normalized as GeminiMediaResolution;
  }
  return fallback;
}

function resolveGeminiRuntimeOptions(
  runtime: Partial<GeminiRuntimeOptions> = {},
): GeminiRuntimeOptions {
  const envModel = automationEnv("GEMINI_MODEL", "").trim();
  const argModel = getArg("geminiModel");
  const explicitModel = runtime.modelName?.trim() || argModel?.trim() || envModel;

  const qualityProfile =
    runtime.qualityProfile ?? parseQualityProfile(getArg("geminiQuality"), "pro");
  const modelName =
    explicitModel || (qualityProfile === "fast" ? FAST_GEMINI_MODEL : DEFAULT_GEMINI_MODEL);

  const thinkingLevel =
    runtime.thinkingLevel ??
    parseThinkingLevel(
      getArg("geminiThinkingLevel"),
      parseThinkingLevel(automationEnv("GEMINI_THINKING_LEVEL", ""), "high"),
    );
  const includeThoughts =
    runtime.includeThoughts ??
    parseBoolOption(
      getArg("geminiIncludeThoughts"),
      automationBool("GEMINI_INCLUDE_THOUGHTS", true),
    );
  const toolMode =
    runtime.toolMode ??
    parseToolMode(
      getArg("geminiToolMode"),
      parseToolMode(automationEnv("GEMINI_TOOL_MODE", ""), "auto"),
    );
  const mediaResolution =
    runtime.mediaResolution ??
    parseMediaResolution(
      getArg("geminiMediaResolution"),
      parseMediaResolution(
        automationEnv("GEMINI_MEDIA_RESOLUTION", "") ||
          automationEnv("GEMINI_MEDIA_RESOLUTION_DEFAULT", ""),
        "high",
      ),
    );

  return {
    modelName,
    thinkingLevel,
    includeThoughts,
    toolMode,
    qualityProfile,
    mediaResolution,
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function readJsonOrDefault<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    return await readJson<T>(filePath);
  } catch {
    return defaultValue;
  }
}

async function readTextOrDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

function parsePolicyValue(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

function resolveProviderPolicyCandidates(): string[] {
  const envPath = process.env.PROVIDER_POLICY_PATH?.trim();
  if (envPath) {
    return [path.resolve(process.cwd(), envPath)];
  }
  return [
    path.resolve(process.cwd(), "configs/ai/provider-policy.yaml"),
    path.resolve(process.cwd(), "../configs/ai/provider-policy.yaml"),
  ];
}

async function loadProviderPolicy(): Promise<ProviderPolicy> {
  const candidates = resolveProviderPolicyCandidates();
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf-8");
      const parsed = parsePolicyValue(raw);
      const provider =
        (parsed.provider || DEFAULT_PROVIDER_POLICY.provider).trim().toLowerCase() ||
        DEFAULT_PROVIDER_POLICY.provider;
      const primary =
        (parsed.primary || provider || DEFAULT_PROVIDER_POLICY.primary).trim().toLowerCase() ||
        DEFAULT_PROVIDER_POLICY.primary;
      const fallback =
        (parsed.fallback || DEFAULT_PROVIDER_POLICY.fallback).trim().toLowerCase() ||
        DEFAULT_PROVIDER_POLICY.fallback;
      const fallbackMode =
        (parsed.fallbackMode || DEFAULT_PROVIDER_POLICY.fallbackMode).trim().toLowerCase() ||
        DEFAULT_PROVIDER_POLICY.fallbackMode;
      return {
        sourcePath: candidate,
        provider,
        primary,
        fallback,
        fallbackMode,
        strictNoFallback: fallbackMode === "strict" && fallback === "none",
      };
    } catch {
      // continue to next path candidate
    }
  }
  return {
    sourcePath: candidates[0] ?? "configs/ai/provider-policy.yaml",
    provider: DEFAULT_PROVIDER_POLICY.provider,
    primary: DEFAULT_PROVIDER_POLICY.primary,
    fallback: DEFAULT_PROVIDER_POLICY.fallback,
    fallbackMode: DEFAULT_PROVIDER_POLICY.fallbackMode,
    strictNoFallback: true,
  };
}

async function resolveSessionDir(): Promise<string> {
  const arg = getArg("sessionDir");
  if (arg) {
    return path.resolve(process.cwd(), arg);
  }
  const latest = await readJson<{ sessionDir: string }>(
    path.join(RUNTIME_ROOT, "latest-session.json"),
  );
  return latest.sessionDir;
}

function buildSelectors(event: CapturedEvent): SelectorCandidate[] {
  const selectors: SelectorCandidate[] = [];
  if (event.target.role && event.target.text) {
    selectors.push({
      kind: "role",
      value: `${event.target.role}[name='${event.target.text}']`,
      score: 90,
    });
  }
  if (event.target.id) {
    selectors.push({ kind: "id", value: `#${event.target.id}`, score: 82 });
  }
  if (event.target.name) {
    selectors.push({ kind: "name", value: `[name='${event.target.name}']`, score: 79 });
  }
  if (event.target.cssPath && event.target.cssPath !== "unknown") {
    selectors.push({ kind: "css", value: event.target.cssPath, score: 68 });
  }
  return selectors;
}

function valueRefForEvent(event: CapturedEvent): string {
  const name = (event.target.name ?? "").toLowerCase();
  const type = (event.target.type ?? "").toLowerCase();
  if (type === "password" || /(password|secret|token|otp|code)/.test(name)) {
    return "${secrets.input}";
  }
  if (/(email|user|login)/.test(name)) {
    return "${params.email}";
  }
  return "${params.input}";
}

function deriveStepsFromEventLog(events: CapturedEvent[]): CandidateStep[] {
  if (events.length === 0) {
    return [];
  }
  const steps: CandidateStep[] = [];
  const firstUrl = events.find((event) => event.url)?.url;
  if (firstUrl) {
    steps.push({
      step_id: "s1",
      action: "navigate",
      url: firstUrl,
      confidence: 0.9,
      source_engine: "event-log",
      evidence_ref: "event-log:navigate",
    });
  }
  const seenTypeTargets = new Set<string>();
  let counter = steps.length + 1;
  for (const event of events) {
    if (event.type === "click") {
      steps.push({
        step_id: `s${counter++}`,
        action: "click",
        target: { selectors: buildSelectors(event) },
        confidence: 0.84,
        source_engine: "event-log",
        evidence_ref: `event-log:${event.ts}:click`,
      });
      continue;
    }
    if ((event.type === "type" || event.type === "change") && event.value !== undefined) {
      const key = `${event.target.cssPath}|${event.target.name ?? ""}|${event.target.id ?? ""}`;
      if (seenTypeTargets.has(key)) {
        continue;
      }
      seenTypeTargets.add(key);
      steps.push({
        step_id: `s${counter++}`,
        action: "type",
        value_ref: valueRefForEvent(event),
        target: { selectors: buildSelectors(event) },
        confidence: 0.86,
        source_engine: "event-log",
        evidence_ref: `event-log:${event.ts}:type`,
      });
    }
  }
  return steps;
}

function detectSignals(combined: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["cloudflare", /cloudflare|cf_clearance|__cf_bm|turnstile/i],
    ["captcha", /captcha|hcaptcha|recaptcha/i],
    ["otp", /otp|verification code|one[-_ ]time|mfa/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(combined)).map(([name]) => name);
}

function tryParseJson(text: string): unknown {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    const start = direct.indexOf("{");
    const end = direct.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(direct.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function looksLikeOtpManualGate(record: Record<string, unknown>): boolean {
  const joined = [
    record.unsupported_reason,
    record.evidence_ref,
    record.value_ref,
    record.action,
    record.url,
  ]
    .map((item) => (typeof item === "string" ? item : ""))
    .join(" ")
    .toLowerCase();
  return /(otp|verification.?code|one[-_ ]time|mfa|2fa|two[-_ ]factor)/i.test(joined);
}

type NormalizedModelSteps = {
  steps: CandidateStep[];
  invalidAction?: string;
};

export function normalizeModelSteps(input: unknown, engine: string): NormalizedModelSteps {
  if (!Array.isArray(input)) {
    return { steps: [] };
  }
  const steps: CandidateStep[] = [];
  let idx = 1;
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    let action = String(record.action ?? "").toLowerCase();
    if (!ACTION_SCHEMA_SET.has(action)) {
      return {
        steps: [],
        invalidAction: action || "<empty>",
      };
    }
    const selectorsRaw = Array.isArray(
      (record.target as { selectors?: unknown[] } | undefined)?.selectors,
    )
      ? (((record.target as { selectors: unknown[] }).selectors ?? []) as unknown[])
      : [];
    const selectors: SelectorCandidate[] = selectorsRaw
      .filter((candidate) => candidate && typeof candidate === "object")
      .map((candidate) => candidate as Record<string, unknown>)
      .map((candidate) => ({
        kind: String(candidate.kind ?? "css") as SelectorCandidate["kind"],
        value: String(candidate.value ?? ""),
        score: Number(candidate.score ?? 70),
      }))
      .filter((selector) => Boolean(selector.value));
    if (action === "manual_gate" && selectors.length > 0 && looksLikeOtpManualGate(record)) {
      action = "type";
      if (typeof record.value_ref !== "string" || !record.value_ref.toLowerCase().includes("otp")) {
        record.value_ref = "${params.otp}";
      }
    }
    steps.push({
      step_id: String(record.step_id ?? `s${idx++}`),
      action: action as CandidateStep["action"],
      url: typeof record.url === "string" ? record.url : undefined,
      value_ref: typeof record.value_ref === "string" ? record.value_ref : undefined,
      target: selectors.length > 0 ? { selectors } : undefined,
      confidence: Math.max(0, Math.min(1, Number(record.confidence ?? 0.75))),
      source_engine: engine,
      evidence_ref: typeof record.evidence_ref === "string" ? record.evidence_ref : `llm:${engine}`,
      unsupported_reason:
        typeof record.unsupported_reason === "string" ? record.unsupported_reason : undefined,
    });
  }
  return { steps };
}

function classifyGeminiUnavailableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

const MODEL_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["detectedSignals", "candidateSteps"],
  properties: {
    detectedSignals: {
      type: "array",
      items: { type: "string" },
    },
    candidateSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step_id", "action", "confidence", "source_engine", "evidence_ref"],
        properties: {
          step_id: { type: "string" },
          action: { type: "string", enum: ACTION_SCHEMA_ACTIONS },
          url: { type: "string" },
          value_ref: { type: "string" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["selectors"],
            properties: {
              selectors: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "value", "score"],
                  properties: {
                    kind: { type: "string", enum: ["role", "css", "id", "name"] },
                    value: { type: "string" },
                    score: { type: "number" },
                  },
                },
              },
            },
          },
          confidence: { type: "number" },
          source_engine: { type: "string" },
          evidence_ref: { type: "string" },
          unsupported_reason: { type: "string" },
        },
      },
    },
  },
} as const;

function toGeminiThinkingLevel(level: ThinkingLevelName): ThinkingLevel {
  if (level === "minimal") {
    return ThinkingLevel.MINIMAL;
  }
  if (level === "low") {
    return ThinkingLevel.LOW;
  }
  if (level === "medium") {
    return ThinkingLevel.MEDIUM;
  }
  return ThinkingLevel.HIGH;
}

function isSpeedModeEnabled(): boolean {
  const value = (process.env.AI_SPEED_MODE ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function extractThoughtSignatures(response: unknown): {
  status: "present" | "missing" | "parse_failed";
  reasonCode: string;
  signatures: string[];
} {
  try {
    const root = response as {
      candidates?: Array<{
        content?: {
          parts?: Array<Record<string, unknown>>;
        };
      }>;
    };
    const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
    const signatures = new Set<string>();
    let malformed = false;
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const directValues = [
          part.thoughtSignature,
          part.thought_signature,
          part.signature,
          part.thought_signature_text,
        ];
        for (const value of directValues) {
          if (value === undefined || value === null) {
            continue;
          }
          if (typeof value === "string" && value.trim()) {
            signatures.add(value.trim());
          } else {
            malformed = true;
          }
        }
        const thought = part.thought;
        if (thought && typeof thought === "object") {
          const thoughtRecord = thought as Record<string, unknown>;
          for (const value of [
            thoughtRecord.thoughtSignature,
            thoughtRecord.thought_signature,
            thoughtRecord.signature,
          ]) {
            if (value === undefined || value === null) {
              continue;
            }
            if (typeof value === "string" && value.trim()) {
              signatures.add(value.trim());
            } else {
              malformed = true;
            }
          }
        }
      }
    }
    if (signatures.size > 0) {
      return {
        status: "present",
        reasonCode: "ai.gemini.thought_signature.present",
        signatures: [...signatures],
      };
    }
    if (malformed) {
      return {
        status: "parse_failed",
        reasonCode: "ai.gemini.thought_signature.parse_failed",
        signatures: [],
      };
    }
    return {
      status: "missing",
      reasonCode: "ai.gemini.thought_signature.missing",
      signatures: [],
    };
  } catch {
    return {
      status: "parse_failed",
      reasonCode: "ai.gemini.thought_signature.parse_failed",
      signatures: [],
    };
  }
}

function resolveGeminiModels(explicitPrimaryModel?: string): {
  models: string[];
  primaryModel: string;
  flashModel: string | null;
  speedMode: boolean;
} {
  const primaryModel =
    explicitPrimaryModel?.trim() ||
    (process.env.GEMINI_MODEL ?? process.env.GEMINI_MODEL ?? "").trim() ||
    "models/gemini-3.1-pro-preview";
  const speedMode = isSpeedModeEnabled();
  const flashModel = speedMode
    ? (process.env.GEMINI_FAST_MODEL ?? "").trim() || "models/gemini-3.0-flash"
    : null;
  const models = [
    ...new Set([flashModel, primaryModel].filter((model): model is string => Boolean(model))),
  ];
  return { models, primaryModel, flashModel, speedMode };
}

function resolveGeminiSuccessReasonCode(params: {
  speedMode: boolean;
  flashModel: string | null;
  primaryModel: string;
  model: string;
  index: number;
  cacheHit: boolean;
}): string {
  const base = (() => {
    if (params.speedMode && params.flashModel && params.model === params.flashModel) {
      return "ai.gemini.success.flash";
    }
    if (params.speedMode && params.model === params.primaryModel && params.index > 0) {
      return "ai.gemini.success.flash_fallback_primary";
    }
    return "ai.gemini.success.primary";
  })();
  return params.cacheHit ? `${base}.cache_hit` : base;
}

async function analyzeWithGemini(
  contextPayload: Record<string, unknown>,
  options: AnalyzeOptions,
): Promise<ModelResolution> {
  const apiKey = process.env.GEMINI_API_KEY;
  const runtime = resolveGeminiRuntimeOptions(options.runtime);
  const { models, primaryModel, flashModel, speedMode } = resolveGeminiModels(runtime.modelName);
  const thinkingLevelName = runtime.thinkingLevel;
  const thinkingLevel = toGeminiThinkingLevel(thinkingLevelName);
  const includeThoughts = runtime.includeThoughts;
  const prompt = [
    "Return JSON only. No markdown.",
    'Schema: {"detectedSignals": string[], "candidateSteps": CandidateStep[]}',
    `CandidateStep action values: ${ACTION_SCHEMA_ACTIONS.join("|")}.`,
    `Thinking level: ${thinkingLevelName}.`,
    JSON.stringify(contextPayload),
  ].join("\n");

  const attempts: ModelAttempt[] = [];
  const modelCacheKeys = models.map((model) =>
    createContextCacheKey({
      namespace: "video-flow.gemini.analysis.v1",
      provider: "gemini",
      model,
      input: contextPayload,
      extras: { thinkingLevel: thinkingLevelName },
    }),
  );

  for (const [index, model] of models.entries()) {
    const cacheKey = modelCacheKeys[index]!;
    const cachePath = path.join(options.cacheDir, `${cacheKey.key}.json`);
    const cached = await readContextCache<ModelAnalysis>(options.cacheDir, cacheKey);
    if (!cached) {
      continue;
    }
    const analysis: ModelAnalysis = {
      detectedSignals: Array.isArray(cached.detectedSignals) ? cached.detectedSignals : [],
      candidateSteps: Array.isArray(cached.candidateSteps) ? cached.candidateSteps : [],
      modelName: cached.modelName ?? model,
    };
    const reasonCode = resolveGeminiSuccessReasonCode({
      speedMode,
      flashModel,
      primaryModel,
      model,
      index,
      cacheHit: true,
    });
    attempts.push({
      provider: "gemini",
      status: "success",
      reasonCode,
      modelName: model,
      analysis,
      cacheHit: true,
      cacheKey: cacheKey.key,
      cachePath,
    });
    return {
      selectedProvider: "gemini",
      reasonCode,
      fallbackUsed: speedMode && model === primaryModel && index > 0,
      attempts,
      analysis,
      contextCache: {
        hit: true,
        key: cacheKey.key,
        path: cachePath,
        modelName: model,
      },
      thoughtSignatures: {
        includeThoughtsEnabled: includeThoughts,
        status: analysis.thoughtSignatures?.status ?? "missing",
        reasonCode: analysis.thoughtSignatures?.reasonCode ?? "ai.gemini.thought_signature.missing",
        signatures: analysis.thoughtSignatures?.signatures ?? [],
      },
    };
  }

  if (!apiKey) {
    return {
      selectedProvider: "none",
      reasonCode: "ai.gemini.unavailable.no_api_key",
      fallbackUsed: false,
      attempts: [
        ...attempts,
        {
          provider: "gemini",
          status: "unavailable",
          reasonCode: "ai.gemini.unavailable.no_api_key",
          detail: "GEMINI_API_KEY is required",
        },
      ],
      analysis: null,
      contextCache: {
        hit: false,
        key: null,
        path: null,
        modelName: null,
      },
      thoughtSignatures: {
        includeThoughtsEnabled: includeThoughts,
        status: "missing",
        reasonCode: "ai.gemini.thought_signature.missing.no_api_key",
        signatures: [],
      },
    };
  }

  const client = new GoogleGenAI({ apiKey });
  for (const [index, model] of models.entries()) {
    const cacheKey = modelCacheKeys[index]!;
    const cachePath = path.join(options.cacheDir, `${cacheKey.key}.json`);
    try {
      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: MODEL_RESPONSE_JSON_SCHEMA,
          thinkingConfig: {
            thinkingLevel,
            includeThoughts,
          },
          temperature: 0.1,
        },
      });
      const thoughtSignatures = extractThoughtSignatures(response);
      const text = response.text?.trim() ?? "";
      const json = tryParseJson(text);
      if (!json || typeof json !== "object") {
        attempts.push({
          provider: "gemini",
          status: "failed",
          reasonCode: "ai.gemini.failed.invalid_payload",
          modelName: model,
          detail: "model response is not a valid JSON object",
        });
        continue;
      }
      const record = json as Record<string, unknown>;
      if (
        !Array.isArray(record.detectedSignals) ||
        record.detectedSignals.some((item) => typeof item !== "string") ||
        !Array.isArray(record.candidateSteps)
      ) {
        attempts.push({
          provider: "gemini",
          status: "failed",
          reasonCode: "ai.gemini.failed.invalid_payload",
          modelName: model,
          detail: "model response does not satisfy required schema fields",
        });
        continue;
      }
      const normalizedModelSteps = normalizeModelSteps(record.candidateSteps, "gemini-video");
      if (normalizedModelSteps.invalidAction) {
        attempts.push({
          provider: "gemini",
          status: "failed",
          reasonCode: INVALID_ACTION_SCHEMA_REASON,
          modelName: model,
          detail: `invalid action from model: ${normalizedModelSteps.invalidAction}`,
        });
        continue;
      }
      const candidateSteps = normalizedModelSteps.steps;
      if (record.candidateSteps.length > 0 && candidateSteps.length === 0) {
        attempts.push({
          provider: "gemini",
          status: "failed",
          reasonCode: "ai.gemini.failed.invalid_payload",
          modelName: model,
          detail: "candidateSteps exists but no valid step could be parsed",
        });
        continue;
      }
      const analysis: ModelAnalysis = {
        detectedSignals: [
          ...new Set(
            record.detectedSignals.map((item) => item.trim()).filter((item) => item.length > 0),
          ),
        ],
        candidateSteps,
        modelName: model,
        thoughtSignatures,
      };
      let persistedPath: string | null = null;
      try {
        persistedPath = await writeContextCache(options.cacheDir, cacheKey, analysis);
      } catch {
        persistedPath = null;
      }
      const reasonCode = resolveGeminiSuccessReasonCode({
        speedMode,
        flashModel,
        primaryModel,
        model,
        index,
        cacheHit: false,
      });
      attempts.push({
        provider: "gemini",
        status: "success",
        reasonCode,
        modelName: model,
        analysis,
        cacheHit: false,
        cacheKey: cacheKey.key,
        cachePath: persistedPath ?? cachePath,
        thoughtSignatureStatus: thoughtSignatures.status,
        thoughtSignatureReasonCode: thoughtSignatures.reasonCode,
        thoughtSignatureCount: thoughtSignatures.signatures.length,
      });
      return {
        selectedProvider: "gemini",
        reasonCode,
        fallbackUsed: speedMode && model === primaryModel && index > 0,
        attempts,
        analysis,
        contextCache: {
          hit: false,
          key: cacheKey.key,
          path: persistedPath ?? cachePath,
          modelName: model,
        },
        thoughtSignatures: {
          includeThoughtsEnabled: includeThoughts,
          status: thoughtSignatures.status,
          reasonCode: thoughtSignatures.reasonCode,
          signatures: thoughtSignatures.signatures,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = (() => {
        if (!error || typeof error !== "object") {
          return NaN;
        }
        const value = (error as { status?: unknown }).status;
        return typeof value === "number" ? value : NaN;
      })();
      const unavailable = Number.isFinite(status) && classifyGeminiUnavailableStatus(status);
      attempts.push({
        provider: "gemini",
        status: unavailable ? "unavailable" : "failed",
        reasonCode: unavailable
          ? "ai.gemini.unavailable.request_failed"
          : "ai.gemini.failed.request_failed",
        modelName: model,
        detail: Number.isFinite(status) ? `status=${status}` : detail,
        cacheHit: false,
        cacheKey: cacheKey.key,
        cachePath,
      });
    }
  }
  const hasUnavailable = attempts.some((attempt) => attempt.status === "unavailable");
  return {
    selectedProvider: "none",
    reasonCode: hasUnavailable
      ? "ai.gemini.unavailable.all_models_failed"
      : "ai.gemini.failed.all_models_failed",
    fallbackUsed: attempts.length > 1,
    attempts,
    analysis: null,
    contextCache: {
      hit: false,
      key: null,
      path: null,
      modelName: null,
    },
    thoughtSignatures: {
      includeThoughtsEnabled: includeThoughts,
      status: "missing",
      reasonCode: hasUnavailable
        ? "ai.gemini.thought_signature.missing.unavailable"
        : "ai.gemini.thought_signature.missing",
      signatures: [],
    },
  };
}

async function analyzeWithModelResolution(
  contextPayload: Record<string, unknown>,
  options: AnalyzeOptions,
): Promise<ModelResolution> {
  return analyzeWithGemini(contextPayload, options);
}

export async function analyzeWithModel(
  contextPayload: Record<string, unknown>,
  options: AnalyzeWithModelOptions = {},
): Promise<ModelAnalysis | null> {
  const runtime = resolveGeminiRuntimeOptions(options.runtime);
  const helper = options.analyzers?.analyzeWithGeminiHelper;
  if (helper) {
    return helper(contextPayload, runtime);
  }
  const cacheDir = options.cacheDir ?? path.join(RUNTIME_ROOT, ".context-cache", "video-flow");
  const resolution = await analyzeWithModelResolution(contextPayload, {
    cacheDir,
    runtime: options.runtime,
  });
  return resolution.analysis;
}

export function resolveAnalysisResult(llm: ModelAnalysis | null, fallbackSteps: CandidateStep[]) {
  const hasLlmSteps = Boolean(llm && llm.candidateSteps.length > 0);
  const candidateSteps = hasLlmSteps ? llm?.candidateSteps : fallbackSteps;
  const defaultMeta = {
    modelName: hasLlmSteps ? (llm?.modelName ?? "gemini") : "event-log-fallback",
    thinking: "high",
    toolMode: "auto",
    mediaResolutionApplied: {
      default: "high",
      perPart: {},
    },
    thoughtSummaryPresent: false,
  };
  return {
    analysisPath: hasLlmSteps ? "llm" : "event-log-fallback",
    analysisEngine: hasLlmSteps ? (llm?.modelName ?? "gemini") : "event-log-fallback",
    candidateSteps,
    analysisMeta: llm?.analysisMeta ?? defaultMeta,
  };
}

async function main(): Promise<void> {
  const sessionDir = await resolveSessionDir();
  const videoPath = getArg("video")
    ? path.resolve(process.cwd(), getArg("video")!)
    : path.join(sessionDir, "session.mp4");
  const transcriptPath = getArg("transcript")
    ? path.resolve(process.cwd(), getArg("transcript")!)
    : path.join(sessionDir, "session.transcript.json");
  const eventLogPath = path.join(sessionDir, "event-log.json");
  const harPath = path.join(sessionDir, "register.har");
  const htmlPath = path.join(sessionDir, "final.register.html");

  const transcript = await readJsonOrDefault<TranscriptItem[]>(transcriptPath, []);
  const events = await readJsonOrDefault<CapturedEvent[]>(eventLogPath, []);
  const har = await readJsonOrDefault<{
    log?: {
      entries?: Array<{
        request?: { method?: string; url?: string };
        response?: { status?: number };
      }>;
    };
  }>(harPath, {});
  const htmlContent = await readTextOrDefault(htmlPath, "");
  const inputPack = buildAiInputPack({
    videoPath,
    transcript,
    events,
    har,
    htmlContent,
  });
  const contextPayload = inputPack.payload as Record<string, unknown>;
  const cacheDir = path.join(sessionDir, ".context-cache", "video-flow");
  const providerPolicy = await loadProviderPolicy();

  const resolution = await analyzeWithModelResolution(contextPayload, { cacheDir });
  const llm = resolution.analysis;
  const fallbackSteps = deriveStepsFromEventLog(events);
  const usingEventLogFallback = !llm || llm.candidateSteps.length === 0;
  if (providerPolicy.strictNoFallback && usingEventLogFallback) {
    throw new Error(
      `[ai.gemini.strict_policy_violation] provider policy strict+fallback:none blocks event-log fallback (policy=${providerPolicy.sourcePath} reason=${resolution.reasonCode})`,
    );
  }
  const candidateSteps = llm && llm.candidateSteps.length > 0 ? llm.candidateSteps : fallbackSteps;
  const combinedText = inputPack.combinedText;
  const detectedSignals = [
    ...new Set([...(llm?.detectedSignals ?? []), ...detectSignals(combinedText)]),
  ];

  const output = {
    generatedAt: new Date().toISOString(),
    sessionDir,
    videoPath,
    transcriptPath,
    eventLogPath,
    analysisEngine: llm?.modelName ?? "event-log-fallback",
    analysisPath: llm ? `llm:${resolution.selectedProvider}` : "event-log-fallback",
    analysisReasonCode: llm ? resolution.reasonCode : "ai.gemini.event_log_fallback",
    fallbackUsed: resolution.fallbackUsed,
    providerPolicy,
    contextCacheHit: resolution.contextCache.hit,
    contextCacheKey: resolution.contextCache.key,
    contextCachePath: resolution.contextCache.path,
    contextCacheModel: resolution.contextCache.modelName,
    inputPackSummary: inputPack.summary,
    modelAttempts: resolution.attempts,
    thoughtSignatures: {
      includeThoughtsEnabled: resolution.thoughtSignatures.includeThoughtsEnabled,
      status: resolution.thoughtSignatures.status,
      reasonCode: resolution.thoughtSignatures.reasonCode,
      signatures: resolution.thoughtSignatures.signatures,
      signatureCount: resolution.thoughtSignatures.signatures.length,
    },
    detectedSignals,
    candidateSteps,
  };

  const outPath = path.join(sessionDir, "video_flow.signals.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf-8");
  process.stdout.write(
    `${JSON.stringify(
      {
        outPath,
        steps: candidateSteps.length,
        analysisPath: output.analysisPath,
        analysisEngine: output.analysisEngine,
        analysisReasonCode: output.analysisReasonCode,
        fallbackUsed: output.fallbackUsed,
        contextCacheHit: output.contextCacheHit,
        contextCacheKey: output.contextCacheKey,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`extract-video-flow failed: ${message}\n`);
    process.exitCode = 1;
  });
}
