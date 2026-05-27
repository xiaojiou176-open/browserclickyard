#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const ALLOWED_MEDIA_RESOLUTIONS = new Set(["low", "medium", "high", "native"]);
const SOURCE_RULES = [
  {
    file: "services/api/app/services/engine_adapters/gemini_adapter.py",
    required: [
      "GEMINI_THINKING_LEVEL",
      "GEMINI_INCLUDE_THOUGHTS",
      "include_thoughts=include_thoughts",
    ],
  },
  {
    file: "services/api/app/services/computer_use_service.py",
    required: [
      "GEMINI_THINKING_LEVEL",
      "GEMINI_INCLUDE_THOUGHTS",
      "include_thoughts=self._resolve_include_thoughts(include_thoughts)",
    ],
  },
  {
    file: "services/api/app/services/video_reconstruction_service.py",
    required: [
      "_DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 3600",
      '_DEFAULT_MEDIA_RESOLUTION = "high"',
      "GEMINI_MEDIA_RESOLUTION_DEFAULT",
      "_normalize_media_resolution",
    ],
  },
  {
    file: "tooling/automation/scripts/lib/gemini_video_analyzer.py",
    required: [
      "DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 3600",
      "thought_signature_status",
      '"thoughtSignatures": thought_signatures',
      '"contextCache": context_cache_meta',
      '"mediaResolutionApplied": media_resolution_applied',
    ],
  },
];

function fail(_message) {
  process.exit(1);
}

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readBoolean(value, fallback) {
  if (!hasValue(value)) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readNonNegativeInteger(value, fallback) {
  if (!hasValue(value)) {
    return fallback;
  }
  if (!/^\d+$/.test(String(value).trim())) {
    return fallback;
  }
  return Number.parseInt(String(value).trim(), 10);
}

function validateEnvironmentContract() {
  const includeThoughts = readBoolean(process.env.GEMINI_INCLUDE_THOUGHTS, true);
  if (!includeThoughts) {
    fail("GEMINI_INCLUDE_THOUGHTS must be true for unified Gemini advanced features.");
  }

  const ttl = readNonNegativeInteger(process.env.GEMINI_CONTEXT_CACHE_TTL_SECONDS, 3600);
  if (ttl < 60 || ttl > 86400) {
    fail(`GEMINI_CONTEXT_CACHE_TTL_SECONDS must be within [60, 86400], got '${ttl}'.`);
  }

  const mediaDefaultRaw = hasValue(process.env.GEMINI_MEDIA_RESOLUTION_DEFAULT)
    ? String(process.env.GEMINI_MEDIA_RESOLUTION_DEFAULT).trim().toLowerCase()
    : "high";
  if (!ALLOWED_MEDIA_RESOLUTIONS.has(mediaDefaultRaw)) {
    fail(
      `GEMINI_MEDIA_RESOLUTION_DEFAULT must be one of ${Array.from(ALLOWED_MEDIA_RESOLUTIONS).join(", ")}, got '${mediaDefaultRaw}'.`,
    );
  }

  if (mediaDefaultRaw !== "high") {
    fail(
      `GEMINI_MEDIA_RESOLUTION_DEFAULT must stay 'high' in strict unified mode, got '${mediaDefaultRaw}'.`,
    );
  }

  if (hasValue(process.env.GEMINI_MEDIA_RESOLUTION)) {
    const runtimeMedia = String(process.env.GEMINI_MEDIA_RESOLUTION).trim().toLowerCase();
    if (!ALLOWED_MEDIA_RESOLUTIONS.has(runtimeMedia)) {
      fail(
        `GEMINI_MEDIA_RESOLUTION must be one of ${Array.from(ALLOWED_MEDIA_RESOLUTIONS).join(", ")}, got '${runtimeMedia}'.`,
      );
    }
  }
}

function validateSourceContract() {
  const root = process.cwd();
  for (const rule of SOURCE_RULES) {
    const filePath = path.resolve(root, rule.file);
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      fail(
        `failed to read '${rule.file}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const requiredSnippet of rule.required) {
      if (!content.includes(requiredSnippet)) {
        fail(`'${rule.file}' missing required unified contract snippet: ${requiredSnippet}`);
      }
    }
  }
}

function main() {
  validateEnvironmentContract();
  validateSourceContract();
}

main();
