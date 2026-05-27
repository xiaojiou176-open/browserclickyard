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
  process.env.UIQ_FRONTEND_COVERAGE_DIR?.trim() ||
  "../../.runtime-cache/coverage/apps/command-center";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**"],
    maxWorkers: unitMaxWorkers,
    minWorkers: unitMinWorkers,
    fileParallelism: unitFileParallelism,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: coverageReportsDirectory,
      include: [
        "src/hooks/**/*.ts",
        "src/utils/**/*.ts",
        "src/shared/**/*.ts",
        "src/constants/**/*.ts",
        "src/features/command-center/**/*.ts",
        "src/types.ts",
        "src/components/DetailFieldRow.tsx",
        "src/components/EmptyState.tsx",
        "src/components/EvidenceScreenshotPair.tsx",
        "src/components/HelpPanel.tsx",
        "src/components/LogStream.tsx",
        "src/components/ToastStack.tsx",
      ],
      exclude: ["src/**/*.d.ts", "src/**/*.{test,spec}.{ts,tsx}"],
      thresholds: {
        lines: 95,
      },
    },
  },
});
