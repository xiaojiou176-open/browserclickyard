import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

const defaultUnitMaxWorkers = process.env.CI ? 2 : 4;
const unitMaxWorkers = readPositiveInt(process.env.UIQ_VITEST_MAX_WORKERS, defaultUnitMaxWorkers);
const unitMinWorkersInput = readPositiveInt(process.env.UIQ_UNIT_MIN_WORKERS, 1);
const unitMinWorkers = Math.min(unitMinWorkersInput, unitMaxWorkers);
const unitFileParallelism = readBoolean(process.env.UIQ_UNIT_FILE_PARALLELISM, true);
const coverageReportsDirectory =
  process.env.UIQ_APPS_WEB_COVERAGE_DIR?.trim() || ".runtime-cache/coverage/apps-web";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "../.."),
  test: {
    environment: "jsdom",
    setupFiles: ["tests/unit/setup.ts"],
    include: ["tests/unit/**/*.test.ts"],
    maxWorkers: unitMaxWorkers,
    minWorkers: unitMinWorkers,
    fileParallelism: unitFileParallelism,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: coverageReportsDirectory,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/main.tsx", "tests/**/*"],
      thresholds: {
        lines: 95,
      },
    },
  },
});
