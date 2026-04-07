import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocaleChain, formatDateTime, formatFixedDecimal } from "./locale";

describe("locale formatting helpers", () => {
  const originalDateTimeFormat = Intl.DateTimeFormat;
  const originalNumberFormat = Intl.NumberFormat;

  afterEach(() => {
    Intl.DateTimeFormat = originalDateTimeFormat;
    Intl.NumberFormat = originalNumberFormat;
    vi.restoreAllMocks();
  });

  it("prioritizes the selected UI locale ahead of browser locales", () => {
    const dateFormatSpy = vi.fn().mockImplementation(() => ({
      format: () => "formatted-date",
    }));
    Intl.DateTimeFormat = dateFormatSpy as unknown as typeof Intl.DateTimeFormat;

    expect(formatDateTime("2026-04-01T12:30:00Z", "zh-CN")).toBe("formatted-date");
    expect(dateFormatSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["zh-CN", "zh"]),
      expect.objectContaining({ dateStyle: "medium", timeStyle: "short" }),
    );
  });

  it("returns a locale-aware number formatter output", () => {
    const numberFormatSpy = vi.fn().mockImplementation(() => ({
      format: () => "3.14",
    }));
    Intl.NumberFormat = numberFormatSpy as unknown as typeof Intl.NumberFormat;

    expect(formatFixedDecimal(3.14159, "en", 2)).toBe("3.14");
    expect(numberFormatSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["en-US", "en"]),
      expect.objectContaining({ minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
  });

  it("builds a deduplicated locale chain", () => {
    const locales = buildLocaleChain("en");
    expect(locales[0]).toBe("en-US");
    expect(new Set(locales).size).toBe(locales.length);
  });

  it("returns a readable fallback when the date input is invalid", () => {
    expect(formatDateTime("not-a-date", "zh-CN")).toBe("\u6682\u65e0");
  });
});
