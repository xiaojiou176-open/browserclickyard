export type UiLocale = "en" | "zh-CN";

export const DEFAULT_UI_LOCALE: UiLocale = "en";
export const UI_LOCALE_STORAGE_KEY = "ab_ui_locale";

export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return value === "en" || value === "zh-CN";
}

export function resolveUiLocale(
  value: string | null | undefined,
  browserLanguage?: string | null,
): UiLocale {
  if (isUiLocale(value)) {
    return value;
  }
  if (typeof browserLanguage === "string" && browserLanguage.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return DEFAULT_UI_LOCALE;
}

export function pickUiText(locale: UiLocale, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}
