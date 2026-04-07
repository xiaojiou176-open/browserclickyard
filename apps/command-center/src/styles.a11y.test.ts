import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "styles.css");

function parseHexColor(css: string, varName: string): string {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  if (!match) {
    throw new Error(`Cannot find color variable: ${varName}`);
  }
  const color = match[1].toLowerCase();
  if (color.length === 4) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  return color;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function sRgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * sRgbToLinear(r) + 0.7152 * sRgbToLinear(g) + 0.0722 * sRgbToLinear(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  const light = Math.max(fg, bg);
  const dark = Math.min(fg, bg);
  return (light + 0.05) / (dark + 0.05);
}

describe("styles accessibility contract", () => {
  it("keeps .error-text at WCAG AA contrast on light background", () => {
    const css = readFileSync(STYLE_FILE, "utf8");
    expect(css).toContain(".error-text");
    expect(css).toContain("color: var(--danger);");

    const danger = parseHexColor(css, "--danger");
    const bg = parseHexColor(css, "--bg");
    expect(contrastRatio(danger, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
