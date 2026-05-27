#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GEMINI_KEY_NAMES = ["GEMINI_API_KEY"];
const AUTOMATION_TOKEN_NAMES = [
  "AUTOMATION_API_TOKEN",
  "AUTOMATION_API_TOKEN",
  "AUTOMATION_API_TOKEN",
];
const MIN_AUTOMATION_TOKEN_LENGTH = 16;
const LIVE_EXTERNAL_DEFAULT_URL = "https://example.com";
const LIVE_EXTERNAL_DEFAULT_ALLOWLIST = "example.com";
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..", "..");

function stripWrappingQuotes(raw) {
  const value = String(raw ?? "").trim();
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

function isWeakPlaceholderKey(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return true;
  }

  const normalized = raw.toLowerCase();
  if (raw.length < 20) {
    return true;
  }

  const bannedExact = new Set([
    "your_api_key",
    "your-api-key",
    "yourapikey",
    "api_key_here",
    "apikey",
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

  if (bannedExact.has(normalized)) {
    return true;
  }

  if (/(example|placeholder|dummy|changeme|replace[_-]?me|test[_-]?key|fake[_-]?key)/i.test(raw)) {
    return true;
  }

  return false;
}

function resolveValue(acceptedNames) {
  const probeFiles = [path.join(repoRoot, ".env")];

  for (const filePath of probeFiles) {
    const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    for (const keyName of acceptedNames) {
      const value = readSpecificKeyFromContent(content, keyName);
      if (value) {
        return { key: value, source: filePath, name: keyName };
      }
    }
  }

  for (const keyName of acceptedNames) {
    const value = String(process.env[keyName] ?? "").trim();
    if (value) {
      return { key: value, source: `process.env.${keyName}`, name: keyName };
    }
  }

  return { key: "", source: "none", name: acceptedNames[0] ?? "unknown" };
}

function readSpecificKeyFromContent(content, keyName) {
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (!match || match[1] !== keyName) {
      continue;
    }
    const rawValue = (match[2].split(/\s+#/, 1)[0] ?? "").trim();
    const value = stripWrappingQuotes(rawValue);
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveAllValues(acceptedNames) {
  const results = new Map();
  for (const keyName of acceptedNames) {
    results.set(keyName, { key: "", source: "none", name: keyName });
  }

  const probeFiles = [path.join(repoRoot, ".env")];

  for (const filePath of probeFiles) {
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    for (const keyName of acceptedNames) {
      const existing = results.get(keyName);
      if (!existing || existing.key) {
        continue;
      }
      const value = readSpecificKeyFromContent(content, keyName);
      if (value) {
        results.set(keyName, { key: value, source: filePath, name: keyName });
      }
    }
  }

  for (const keyName of acceptedNames) {
    const existing = results.get(keyName);
    if (!existing || existing.key) {
      continue;
    }
    const value = String(process.env[keyName] ?? "").trim();
    if (value) {
      results.set(keyName, { key: value, source: `process.env.${keyName}`, name: keyName });
    }
  }

  return Array.from(results.values());
}

function isWeakPlaceholderToken(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return true;
  }
  const normalized = raw.toLowerCase();
  if (raw.length < MIN_AUTOMATION_TOKEN_LENGTH) {
    return true;
  }
  if (
    /(changeme|dummy|placeholder|replace[_-]?me|replace-with|test(?:[_-]|$)|fake(?:[_-]|$)|example)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function isEnabledByEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function matchesAllowPattern(hostname, pattern) {
  const normalizedHost = String(hostname ?? "").toLowerCase();
  const normalizedPattern = String(pattern ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
}

function parseAllowlist(raw) {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const jsonMode = args.has("--json");
  const assertMode = args.has("--assert") || !jsonMode;
  const skipLlmCheck = args.has("--skip-llm");
  const liveEnabled = isEnabledByEnv(process.env.UIQ_LIVE_LLM_ENABLED);
  const liveExternalEnabled = isEnabledByEnv(process.env.UIQ_LIVE_EXTERNAL_ENABLED);

  if (!liveEnabled && !skipLlmCheck) {
    const payload = {
      ok: false,
      skipped: true,
      reason: "UIQ_LIVE_LLM_ENABLED is not true",
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
    if (assertMode) {
      process.stderr.write(
        "[live-key-preflight] UIQ_LIVE_LLM_ENABLED must be true in live mode.\n",
      );
      process.exit(1);
    }
    return;
  }

  const resolved = resolveValue(GEMINI_KEY_NAMES);
  const weak = isWeakPlaceholderKey(resolved.key);
  const ok = skipLlmCheck ? true : Boolean(resolved.key) && !weak;
  const automationResolved = resolveAllValues(AUTOMATION_TOKEN_NAMES);
  const automationPresent = automationResolved.filter((item) => item.key.length > 0);
  const automationChecks = automationResolved.map((item) => {
    const hasToken = item.key.length > 0;
    const weakToken = hasToken ? isWeakPlaceholderToken(item.key) : false;
    return {
      name: item.name,
      source: item.source,
      hasToken,
      weakPlaceholder: weakToken,
      tokenLength: item.key.length,
      ok: !hasToken || !weakToken,
    };
  });
  const invalidAutomationChecks = automationChecks.filter((item) => item.hasToken && !item.ok);
  const missingAllAutomationTokens = automationPresent.length === 0;
  const liveExternalUrl = String(
    process.env.UIQ_LIVE_EXTERNAL_URL ?? LIVE_EXTERNAL_DEFAULT_URL,
  ).trim();
  const liveExternalAllowlistRaw = String(
    process.env.UIQ_LIVE_EXTERNAL_ALLOWLIST ?? LIVE_EXTERNAL_DEFAULT_ALLOWLIST,
  ).trim();
  const liveExternalAllowlist = parseAllowlist(liveExternalAllowlistRaw);
  let liveExternalParsed = null;
  let liveExternalProtocolOk = false;
  let liveExternalLoopback = true;
  let liveExternalAllowlisted = false;
  let liveExternalParseError = "";
  try {
    liveExternalParsed = new URL(liveExternalUrl);
    liveExternalProtocolOk =
      liveExternalParsed.protocol === "http:" || liveExternalParsed.protocol === "https:";
    liveExternalLoopback = isLoopbackHost(liveExternalParsed.hostname);
    liveExternalAllowlisted =
      liveExternalAllowlist.length > 0 &&
      liveExternalAllowlist.some((pattern) =>
        matchesAllowPattern(liveExternalParsed.hostname, pattern),
      );
  } catch (error) {
    liveExternalParseError = error instanceof Error ? error.message : String(error);
  }
  const liveExternalOk =
    !liveExternalEnabled ||
    (Boolean(liveExternalParsed) &&
      liveExternalProtocolOk &&
      !liveExternalLoopback &&
      liveExternalAllowlist.length > 0 &&
      liveExternalAllowlisted);

  const payload = {
    ok,
    source: resolved.source,
    hasKey: resolved.key.length > 0,
    weakPlaceholder: weak,
    keyLength: resolved.key.length,
    automation: {
      checked: AUTOMATION_TOKEN_NAMES,
      missingAll: missingAllAutomationTokens,
      invalidCount: invalidAutomationChecks.length,
      checks: automationChecks,
    },
    liveExternal: {
      enabled: liveExternalEnabled,
      ok: liveExternalOk,
      url: liveExternalUrl,
      allowlist: liveExternalAllowlist,
      protocolOk: liveExternalProtocolOk,
      loopback: liveExternalLoopback,
      allowlisted: liveExternalAllowlisted,
      parseError: liveExternalParseError,
    },
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  if (assertMode && missingAllAutomationTokens) {
    process.stderr.write(
      "[live-key-preflight] warning: automation token missing (AUTOMATION_API_TOKEN/AUTOMATION_API_TOKEN/AUTOMATION_API_TOKEN). continue live llm/web.\n",
    );
  }

  for (const check of automationChecks) {
    if (!check.hasToken) {
      continue;
    }
    const status = check.ok ? "ok" : "invalid";
    const level = check.ok ? "info" : "error";
    const stream = check.ok ? process.stdout : process.stderr;
    stream.write(
      `[live-key-preflight] ${level} token name=${check.name} source=${check.source} status=${status} weakPlaceholder=${check.weakPlaceholder} tokenLength=${check.tokenLength}\n`,
    );
  }

  if (assertMode && (!ok || invalidAutomationChecks.length > 0 || !liveExternalOk)) {
    if (!ok && !skipLlmCheck) {
      process.stderr.write(
        "[live-key-preflight] missing or placeholder Gemini key. Provide a real key via GEMINI_API_KEY/GEMINI_API_KEY from repo-root .env (preferred) or process.env.\n",
      );
      process.stderr.write(
        `[live-key-preflight] source=${resolved.source} hasKey=${payload.hasKey} weakPlaceholder=${payload.weakPlaceholder} keyLength=${payload.keyLength}\n`,
      );
    }
    if (invalidAutomationChecks.length > 0) {
      for (const item of invalidAutomationChecks) {
        process.stderr.write(
          `[live-key-preflight] invalid automation token name=${item.name} source=${item.source} weakPlaceholder=${item.weakPlaceholder} tokenLength=${item.tokenLength}\n`,
        );
      }
    }
    if (!liveExternalOk) {
      process.stderr.write(
        `[live-key-preflight] invalid live external config enabled=${liveExternalEnabled} url=${liveExternalUrl} protocolOk=${liveExternalProtocolOk} loopback=${liveExternalLoopback} allowlisted=${liveExternalAllowlisted} parseError=${liveExternalParseError || "none"}\n`,
      );
      process.stderr.write(
        `[live-key-preflight] live web requires non-loopback URL and allowlist match (UIQ_LIVE_EXTERNAL_ALLOWLIST=${liveExternalAllowlistRaw})\n`,
      );
    }
    process.exit(1);
  }

  if (assertMode && ok) {
    process.stdout.write(
      `[live-key-preflight] ok source=${resolved.source} keyLength=${payload.keyLength}\n`,
    );
  }
}

main();
