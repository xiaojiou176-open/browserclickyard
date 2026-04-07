import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TranscriptItem = { t: string; text: string };

export type CapturedEvent = {
  ts: string;
  type: "navigate" | "click" | "type" | "change" | "submit" | "keydown";
  url: string;
  target: {
    tag: string;
    id: string | null;
    name: string | null;
    type: string | null;
    role: string | null;
    text: string | null;
    cssPath: string;
  };
  value?: string;
};

type RawHar = {
  log?: {
    entries?: Array<{
      request?: { method?: string; url?: string };
      response?: { status?: number };
    }>;
  };
};

export type HarEntrySummary = {
  method: string;
  path: string;
  status: number;
};

type InputPackLimits = {
  maxTranscriptItems: number;
  maxTranscriptChars: number;
  maxEventItems: number;
  maxEventValueChars: number;
  maxHarEntries: number;
  maxHtmlChars: number;
  maxCombinedChars: number;
};

type BuildAiInputPackOptions = {
  videoPath: string;
  transcript: TranscriptItem[];
  events: CapturedEvent[];
  har: RawHar;
  htmlContent: string;
  limits?: Partial<InputPackLimits>;
};

type CacheKeyOptions = {
  namespace: string;
  provider: string;
  model: string;
  input: unknown;
  extras?: Record<string, unknown>;
};

type CacheEnvelope<T> = {
  createdAt: string;
  key: string;
  provider: string;
  model: string;
  namespace: string;
  inputHash: string;
  value: T;
};

export type ContextCacheKey = {
  key: string;
  provider: string;
  model: string;
  namespace: string;
  inputHash: string;
};

export type AiInputPack = {
  payload: {
    videoPath: string;
    transcript: TranscriptItem[];
    eventLog: CapturedEvent[];
    harEntries: HarEntrySummary[];
    htmlSnippet: string;
  };
  combinedText: string;
  summary: {
    transcriptOriginalCount: number;
    transcriptPackedCount: number;
    transcriptPackedChars: number;
    eventsOriginalCount: number;
    eventsPackedCount: number;
    harOriginalCount: number;
    harPackedCount: number;
    htmlOriginalChars: number;
    htmlPackedChars: number;
  };
};

const DEFAULT_LIMITS: InputPackLimits = {
  maxTranscriptItems: 240,
  maxTranscriptChars: 12000,
  maxEventItems: 320,
  maxEventValueChars: 280,
  maxHarEntries: 180,
  maxHtmlChars: 12000,
  maxCombinedChars: 26000,
};

function trimToMax(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTranscript(items: TranscriptItem[], limits: InputPackLimits): TranscriptItem[] {
  const packed: TranscriptItem[] = [];
  let totalChars = 0;
  for (const item of items) {
    if (packed.length >= limits.maxTranscriptItems || totalChars >= limits.maxTranscriptChars) {
      break;
    }
    const text = normalizeText(item?.text);
    if (!text) {
      continue;
    }
    const remaining = limits.maxTranscriptChars - totalChars;
    const trimmed = trimToMax(text, remaining);
    if (!trimmed) {
      break;
    }
    packed.push({
      t: typeof item?.t === "string" ? item.t : "",
      text: trimmed,
    });
    totalChars += trimmed.length;
  }
  return packed;
}

function normalizeEvents(events: CapturedEvent[], limits: InputPackLimits): CapturedEvent[] {
  const packed: CapturedEvent[] = [];
  for (const event of events) {
    if (packed.length >= limits.maxEventItems) {
      break;
    }
    if (!event || typeof event !== "object") {
      continue;
    }
    const target = event.target ?? {
      tag: "",
      id: null,
      name: null,
      type: null,
      role: null,
      text: null,
      cssPath: "",
    };
    packed.push({
      ts: typeof event.ts === "string" ? event.ts : "",
      type: event.type,
      url: typeof event.url === "string" ? event.url : "",
      target: {
        tag: normalizeText(target.tag),
        id: typeof target.id === "string" ? target.id : null,
        name: typeof target.name === "string" ? target.name : null,
        type: typeof target.type === "string" ? target.type : null,
        role: typeof target.role === "string" ? target.role : null,
        text: typeof target.text === "string" ? trimToMax(target.text, 240) : null,
        cssPath: normalizeText(target.cssPath),
      },
      ...(typeof event.value === "string"
        ? { value: trimToMax(event.value, limits.maxEventValueChars) }
        : {}),
    });
  }
  return packed;
}

export function summarizeHarEntries(har: RawHar, maxEntries: number): HarEntrySummary[] {
  const entries = har.log?.entries ?? [];
  const packed: HarEntrySummary[] = [];
  for (const entry of entries) {
    if (packed.length >= maxEntries) {
      break;
    }
    const method = String(entry.request?.method ?? "GET").toUpperCase();
    const rawUrl = String(entry.request?.url ?? "");
    let pathname = rawUrl;
    try {
      pathname = rawUrl ? new URL(rawUrl).pathname : rawUrl;
    } catch {
      pathname = rawUrl;
    }
    if (!pathname) {
      continue;
    }
    packed.push({
      method,
      path: pathname,
      status: Number(entry.response?.status ?? 0),
    });
  }
  return packed;
}

export function buildAiInputPack(options: BuildAiInputPackOptions): AiInputPack {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const transcript = normalizeTranscript(options.transcript ?? [], limits);
  const eventLog = normalizeEvents(options.events ?? [], limits);
  const harEntries = summarizeHarEntries(options.har ?? {}, limits.maxHarEntries);
  const htmlSnippet = trimToMax(options.htmlContent ?? "", limits.maxHtmlChars);

  const combinedTextRaw = [
    transcript.map((item) => item.text).join("\n"),
    htmlSnippet,
    harEntries.map((item) => `${item.method} ${item.path}`).join("\n"),
  ].join("\n");
  const combinedText = trimToMax(combinedTextRaw, limits.maxCombinedChars);

  return {
    payload: {
      videoPath: options.videoPath,
      transcript,
      eventLog,
      harEntries,
      htmlSnippet,
    },
    combinedText,
    summary: {
      transcriptOriginalCount: options.transcript.length,
      transcriptPackedCount: transcript.length,
      transcriptPackedChars: transcript.reduce((total, item) => total + item.text.length, 0),
      eventsOriginalCount: options.events.length,
      eventsPackedCount: eventLog.length,
      harOriginalCount: options.har.log?.entries?.length ?? 0,
      harPackedCount: harEntries.length,
      htmlOriginalChars: (options.htmlContent ?? "").length,
      htmlPackedChars: htmlSnippet.length,
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createContextCacheKey(options: CacheKeyOptions): ContextCacheKey {
  const inputHash = sha256(stableStringify(options.input));
  const metaHash = sha256(
    stableStringify({
      namespace: options.namespace,
      provider: options.provider,
      model: options.model,
      extras: options.extras ?? {},
    }),
  );
  return {
    key: sha256(`${metaHash}:${inputHash}`),
    provider: options.provider,
    model: options.model,
    namespace: options.namespace,
    inputHash,
  };
}

function resolveCacheFilePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.json`);
}

export async function readContextCache<T>(
  cacheDir: string,
  cacheKey: ContextCacheKey,
): Promise<T | null> {
  const filePath = resolveCacheFilePath(cacheDir, cacheKey.key);
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.key !== cacheKey.key) {
      return null;
    }
    if (
      parsed.model !== cacheKey.model ||
      parsed.provider !== cacheKey.provider ||
      parsed.namespace !== cacheKey.namespace
    ) {
      return null;
    }
    if (parsed.inputHash !== cacheKey.inputHash) {
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

export async function writeContextCache<T>(
  cacheDir: string,
  cacheKey: ContextCacheKey,
  value: T,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const filePath = resolveCacheFilePath(cacheDir, cacheKey.key);
  const envelope: CacheEnvelope<T> = {
    createdAt: new Date().toISOString(),
    key: cacheKey.key,
    provider: cacheKey.provider,
    model: cacheKey.model,
    namespace: cacheKey.namespace,
    inputHash: cacheKey.inputHash,
    value,
  };
  await writeFile(filePath, JSON.stringify(envelope, null, 2), "utf-8");
  return filePath;
}
