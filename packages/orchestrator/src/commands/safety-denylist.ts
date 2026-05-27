const ASCII_WORD_OR_PHRASE = /^[a-z0-9][a-z0-9 _-]*$/i;

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTokenPattern(token: string): string {
  const escaped = escapeRegex(token);
  if (!ASCII_WORD_OR_PHRASE.test(token)) {
    return escaped;
  }
  return `(?<![a-z0-9])${escaped}(?![a-z0-9])`;
}

export function buildDenyRegex(denylist: string[]): RegExp {
  const normalized = denylist.map((token) => token.trim()).filter((token) => token.length > 0);
  if (normalized.length === 0) {
    return /$^/;
  }
  return new RegExp(`(${normalized.map(toTokenPattern).join("|")})`, "i");
}
