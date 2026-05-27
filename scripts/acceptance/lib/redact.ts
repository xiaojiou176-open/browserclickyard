const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|otp|code|authorization|api[_-]?key|card|cvc|exp|postal)/i;

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b\d{6}\b/g,
  /\b\d{12,19}\b/g,
];

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 1) {
    return "***@***";
  }
  return `${value[0]}***${value.slice(at - 1, at)}@***`;
}

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, "***");
  }
  if (out.includes("@")) {
    const match = out.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
    if (match) {
      for (const m of match) {
        out = out.replaceAll(m, maskEmail(m));
      }
    }
  }
  return out;
}

export function redactObject<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as T;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        next[key] = "***";
        continue;
      }
      next[key] = redactObject(raw);
    }
    return next as T;
  }

  return value;
}

export function redactErrorMessage(message: unknown): string {
  if (message instanceof Error) {
    return redactString(message.message);
  }
  return redactString(String(message ?? ""));
}
