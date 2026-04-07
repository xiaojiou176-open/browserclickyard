import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const KEY_NAMES = ["GEMINI_API_KEY"] as const;
const ALLOWED_LIVE_MODELS = new Set([
  "gemini-3.1-pro-preview",
  "gemini-3.0-pro",
  "gemini-3.0-flash",
]);
const thisFile = fileURLToPath(import.meta.url);
const automationRoot = path.resolve(path.dirname(thisFile), "..");
const repoRoot = path.resolve(automationRoot, "..");

function isEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.UIQ_LIVE_LLM_ENABLED ?? "");
}

const enabled = isEnabled();
const MAX_RETRIES = 2;
const ATTEMPT_TIMEOUT_MS = Number.parseInt(
  (process.env.UIQ_LIVE_LLM_ATTEMPT_TIMEOUT_MS ?? "90000").trim(),
  10,
);

type LiveErrorClass = "network_or_timeout" | "logic";

function isWeakPlaceholderKey(input: string): boolean {
  const raw = input.trim();
  if (!raw) {
    return true;
  }
  if (raw.length < 20) {
    return true;
  }
  const normalized = raw.toLowerCase();
  const banned = new Set([
    "your_api_key",
    "your-api-key",
    "yourapikey",
    "apikey",
    "api_key_here",
    "placeholder",
    "replace_me",
    "replace-this",
    "changeme",
    "test",
    "demo",
    "fake",
    "dummy",
    "none",
    "null",
    "undefined",
  ]);
  if (banned.has(normalized)) {
    return true;
  }
  if (/(example|placeholder|dummy|changeme|replace[_-]?me|test[_-]?key|fake[_-]?key)/i.test(raw)) {
    return true;
  }
  return false;
}

function stripWrappingQuotes(raw: string): string {
  const value = raw.trim();
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

function sanitizeModelName(raw: string): string {
  return raw.trim().replace(/^models\//, "");
}

function readKeyFromShellStyleFile(filePath: string): string {
  if (!existsSync(filePath)) {
    return "";
  }
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
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
    if (!KEY_NAMES.includes(key as (typeof KEY_NAMES)[number])) {
      continue;
    }
    const rawValue = match[2].split(/\s+#/, 1)[0] ?? "";
    const value = stripWrappingQuotes(rawValue);
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveApiKey(): { key: string; source: string } {
  for (const keyName of KEY_NAMES) {
    const fromEnv = (process.env[keyName] ?? "").trim();
    if (fromEnv) {
      return { key: fromEnv, source: `process.env.${keyName}` };
    }
  }

  const probeFiles = [path.join(repoRoot, ".env")];
  for (const filePath of probeFiles) {
    const fromFile = readKeyFromShellStyleFile(filePath);
    if (fromFile) {
      return { key: fromFile, source: filePath };
    }
  }

  return { key: "", source: "none" };
}

function classifyLiveError(error: unknown): LiveErrorClass {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (
    /(timeout|timed out|network|econn|eai_|enotfound|socket|temporary|unavailable|dns|429|5\d{2}|resource exhausted|quota)/i.test(
      reason,
    )
  ) {
    return "network_or_timeout";
  }
  return "logic";
}

function shouldRetry(errorClass: LiveErrorClass): boolean {
  return errorClass === "network_or_timeout";
}

async function withAttemptTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutTask = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`attempt timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([task, timeoutTask]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runWithLiveRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await withAttemptTimeout(task(), ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      const errorClass = classifyLiveError(error);

      if (!shouldRetry(errorClass) || attempt >= MAX_RETRIES) {
        throw new Error(
          `[live-llm][${errorClass}] final-failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  throw new Error(
    `unreachable retry state: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

test("live llm smoke: gemini returns valid JSON payload", { timeout: 360_000 }, async () => {
  assert.ok(enabled, "Set UIQ_LIVE_LLM_ENABLED=true to run real Gemini live smoke test");
  const resolved = resolveApiKey();
  assert.ok(
    resolved.key.length > 0,
    "UIQ_LIVE_LLM_ENABLED=true requires a Gemini key from process.env or repo-root .env",
  );
  assert.ok(
    !isWeakPlaceholderKey(resolved.key),
    "Live LLM smoke requires a real Gemini key (placeholder/weak keys are blocked)",
  );

  const model = sanitizeModelName(
    (process.env.UIQ_LIVE_LLM_MODEL ?? "gemini-3.1-pro-preview").trim(),
  );
  assert.ok(
    ALLOWED_LIVE_MODELS.has(model),
    `UIQ_LIVE_LLM_MODEL must be one of ${Array.from(ALLOWED_LIVE_MODELS).join(", ")}, got '${model}'`,
  );
  const client = new GoogleGenAI({ apiKey: resolved.key });

  const response = await runWithLiveRetry(() =>
    client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: 'Return strict JSON: {"ok": true, "provider": "gemini", "task": "live-smoke"}',
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0,
      },
    }),
  );

  const text = response.text?.trim() ?? "";
  assert.ok(text.length > 0, "Gemini response text should not be empty");

  const parsed = JSON.parse(text) as { ok?: unknown; provider?: unknown; task?: unknown };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, "gemini");
  assert.equal(parsed.task, "live-smoke");
  assert.ok(resolved.source.length > 0);
});
