import type { UiLocale } from "../i18n/uiLocale";
import { pickUiText } from "../i18n/uiLocale";

const UI_LOCALE_FALLBACKS: Record<UiLocale, string[]> = {
  en: ["en-US", "en"],
  "zh-CN": ["zh-CN", "zh"],
};

function readBrowserLocales(): string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const raw = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function buildLocaleChain(locale: UiLocale): string[] {
  const seen = new Set<string>();
  const ordered = [...UI_LOCALE_FALLBACKS[locale], ...readBrowserLocales()];
  return ordered.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale: UiLocale,
): string {
  if (value === null || value === undefined || value === "") {
    return pickUiText(locale, "Not available", "\u6682\u65e0");
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return pickUiText(locale, "Not available", "\u6682\u65e0");
  }
  return new Intl.DateTimeFormat(buildLocaleChain(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function formatFixedDecimal(value: number, locale: UiLocale, digits = 2): string {
  return new Intl.NumberFormat(buildLocaleChain(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
