import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type DesktopSoakConfig, runDesktopSoak } from "./desktop-soak.js";
import {
  DESKTOP_AUTOMATION_MODE_ENV,
  DESKTOP_AUTOMATION_OPERATOR_MANUAL_MODE,
  DESKTOP_AUTOMATION_REASON_ENV,
} from "./desktop-utils.js";

type DesktopSoakDeps = NonNullable<Parameters<typeof runDesktopSoak>[2]>;

function okShell(detail: string) {
  return { ok: true, detail, stdout: "", stderr: "" };
}

function createDeps(overrides: Partial<DesktopSoakDeps> = {}): DesktopSoakDeps {
  return {
    appNameFromPath: () => "MockApp",
    findAppNameByBundleId: () => undefined,
    findFirstPid: () => undefined,
    getProcessSample: () => undefined,
    getWindowCount: () => undefined,
    isProcessRunning: () => false,
    readBundleIdFromApp: () => undefined,
    runChecked: (command, args) => okShell(`${command} ${args.join(" ")} ok`),
    sleep: async () => {},
    ...overrides,
  };
}

function createBaseDir(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-desktop-soak-"));
  mkdirSync(join(baseDir, "metrics"), { recursive: true });
  return baseDir;
}

function enableManualDesktopAutomation(t: {
  after: (fn: () => void) => void;
}): void {
  const previousMode = process.env[DESKTOP_AUTOMATION_MODE_ENV];
  const previousReason = process.env[DESKTOP_AUTOMATION_REASON_ENV];
  process.env[DESKTOP_AUTOMATION_MODE_ENV] = DESKTOP_AUTOMATION_OPERATOR_MANUAL_MODE;
  process.env[DESKTOP_AUTOMATION_REASON_ENV] = "desktop-soak-test";
  t.after(() => {
    if (previousMode === undefined) {
      delete process.env[DESKTOP_AUTOMATION_MODE_ENV];
    } else {
      process.env[DESKTOP_AUTOMATION_MODE_ENV] = previousMode;
    }
    if (previousReason === undefined) {
      delete process.env[DESKTOP_AUTOMATION_REASON_ENV];
    } else {
      process.env[DESKTOP_AUTOMATION_REASON_ENV] = previousReason;
    }
  });
}

function swiftSoakConfig(): DesktopSoakConfig {
  return {
    targetType: "swift",
    bundleId: "com.example.desktop",
    durationSeconds: 1,
    intervalSeconds: 1,
    gates: {
      crashCountMax: 0,
    },
  };
}

test("runDesktopSoak treats open -b success as recovered when appName is missing", async (t) => {
  enableManualDesktopAutomation(t);
  const baseDir = createBaseDir();
  const commands: Array<{ command: string; args: string[] }> = [];
  const deps = createDeps({
    findAppNameByBundleId: () => undefined,
    runChecked: (command, args) => {
      commands.push({ command, args });
      return okShell(`${command} ${args.join(" ")} ok`);
    },
  });

  const result = await runDesktopSoak(baseDir, swiftSoakConfig(), deps);
  assert.equal(result.status, "passed");
  assert.equal(result.crashCount, 0);
  assert.equal(result.reasonCode, undefined);
  assert.equal(result.stabilityMetrics?.crashRecoveryAttempts, 1);
  assert.equal(result.stabilityMetrics?.crashRecoveryFailedCount, 0);
  assert.equal(result.samples[0]?.running, true);
  assert.equal(
    commands.some(
      (entry) =>
        entry.command === "open" &&
        entry.args[0] === "-b" &&
        entry.args[1] === "com.example.desktop",
    ),
    true,
  );

  const stored = JSON.parse(readFileSync(join(baseDir, "metrics/desktop-soak.json"), "utf8")) as {
    crashCount?: number;
    status?: string;
  };
  assert.equal(stored.crashCount, 0);
  assert.equal(stored.status, "passed");
});

test("runDesktopSoak still requires process confirmation when appName is available", async (t) => {
  enableManualDesktopAutomation(t);
  const baseDir = createBaseDir();
  let processChecks = 0;
  const deps = createDeps({
    findAppNameByBundleId: () => "DemoDesktop",
    isProcessRunning: () => {
      processChecks += 1;
      return false;
    },
  });

  const result = await runDesktopSoak(baseDir, swiftSoakConfig(), deps);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "desktop.soak.gate.crash_count");
  assert.equal(result.crashCount, 1);
  assert.equal(result.stabilityMetrics?.crashRecoveryAttempts, 1);
  assert.equal(result.stabilityMetrics?.crashRecoveryFailedCount, 1);
  assert.equal(result.samples[0]?.running, false);
  assert.equal(processChecks, 2);
});
