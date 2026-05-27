import { isAbsolute } from "node:path";
import { PROFILE_TARGET_PATTERN, REDACTED } from "./constants.js";

const LINE_REDACTION_PATTERNS = [
  {
    pattern: /(authorization\s*[:=]\s*basic\s+)([^\s,;]+)/gi,
    replacer: `$1${REDACTED}`,
  },
  {
    pattern: /(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/gi,
    replacer: `$1${REDACTED}`,
  },
  {
    pattern:
      /((?:x-api-key|x-auth-token|x-automation-token|x-vonage-inbound-token|x-vonage-token|x-inbound-token|cookie|set-cookie)\s*[:=]\s*)([^\r\n]+)/gi,
    replacer: `$1${REDACTED}`,
  },
  {
    pattern:
      /((?:^|[?&]|[\s,{])(?:token|access_token|refresh_token|password|passwd|secret|api_key|apikey|cvc|cvv|card_number|cardnumber|key|sig|signature)\s*(?:=|:)\s*)([^&\s,;"}]+)/gi,
    replacer: `$1${REDACTED}`,
  },
  {
    pattern:
      /("?(?:token|accessToken|refreshToken|password|passwd|secret|apiKey|api_key|authorization|cookie|set-cookie|cvc|cvv|cardNumber|card_number|key|sig|signature)"?\s*:\s*")([^"]*)(")/gi,
    replacer: `$1${REDACTED}$3`,
  },
  {
    pattern: /((?:^|\s)[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CVC|CVV)\s*=\s*)([^\s]+)/g,
    replacer: `$1${REDACTED}`,
  },
] as const satisfies ReadonlyArray<{ pattern: RegExp; replacer: string }>;

export function sanitizeProfileTarget(kind: "profile" | "target", value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Invalid ${kind}: empty value`);
  }
  if (isAbsolute(normalized)) {
    throw new Error(`Invalid ${kind}: absolute path is not allowed`);
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`Invalid ${kind}: path separators or '..' are not allowed`);
  }
  if (!PROFILE_TARGET_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${kind}: only [A-Za-z0-9._-] allowed`);
  }
  return normalized;
}

export function sanitizeRunId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Invalid runId: empty value");
  }
  if (isAbsolute(normalized)) {
    throw new Error("Invalid runId: absolute path is not allowed");
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error("Invalid runId: path traversal is not allowed");
  }
  if (!PROFILE_TARGET_PATTERN.test(normalized)) {
    throw new Error("Invalid runId: only [A-Za-z0-9._-] allowed");
  }
  return normalized;
}

export function redactSensitiveLine(line: string): string {
  let redacted = line;
  for (const { pattern, replacer } of LINE_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacer);
  }
  return redacted;
}

export function redactSensitiveText(value: string): string {
  return value
    .split("\n")
    .map((line) => redactSensitiveLine(line))
    .join("\n");
}
