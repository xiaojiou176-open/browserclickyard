import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { cleanupExpiredSessions } from "../scripts/record-session.js";

function createRuntimeRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "record-session-cleanup-"));
}

function markDirectoryHoursAgo(dirPath: string, hoursAgo: number): Promise<void> {
  const ts = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  return utimes(dirPath, ts, ts);
}

test("cleanup keeps persistent audit directories even when stale", async () => {
  const runtimeRoot = createRuntimeRoot();
  const previousRetentionHours = process.env.AUTOMATION_RETENTION_HOURS;
  const previousMaxBytes = process.env.AUTOMATION_RUNTIME_MAX_BYTES;

  try {
    const universalDir = path.join(runtimeRoot, "universal");
    const vonageDir = path.join(runtimeRoot, "vonage");
    mkdirSync(universalDir, { recursive: true });
    mkdirSync(vonageDir, { recursive: true });
    writeFileSync(path.join(universalDir, "audit.log"), "universal-audit", "utf-8");
    writeFileSync(path.join(vonageDir, "audit.log"), "vonage-audit", "utf-8");

    await markDirectoryHoursAgo(universalDir, 72);
    await markDirectoryHoursAgo(vonageDir, 72);

    process.env.AUTOMATION_RETENTION_HOURS = "1";
    process.env.AUTOMATION_RUNTIME_MAX_BYTES = String(1024 * 1024);

    await cleanupExpiredSessions(runtimeRoot);

    expect(existsSync(universalDir)).toBe(true);
    expect(existsSync(vonageDir)).toBe(true);
  } finally {
    if (previousRetentionHours === undefined) {
      delete process.env.AUTOMATION_RETENTION_HOURS;
    } else {
      process.env.AUTOMATION_RETENTION_HOURS = previousRetentionHours;
    }

    if (previousMaxBytes === undefined) {
      delete process.env.AUTOMATION_RUNTIME_MAX_BYTES;
    } else {
      process.env.AUTOMATION_RUNTIME_MAX_BYTES = previousMaxBytes;
    }

    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("cleanup removes expired session directories and keeps recent ones", async () => {
  const runtimeRoot = createRuntimeRoot();
  const previousRetentionHours = process.env.AUTOMATION_RETENTION_HOURS;
  const previousMaxBytes = process.env.AUTOMATION_RUNTIME_MAX_BYTES;

  try {
    const expiredSessionDir = path.join(runtimeRoot, "session-expired");
    const freshSessionDir = path.join(runtimeRoot, "session-fresh");
    mkdirSync(expiredSessionDir, { recursive: true });
    mkdirSync(freshSessionDir, { recursive: true });
    writeFileSync(path.join(expiredSessionDir, "session-meta.json"), "{}", "utf-8");
    writeFileSync(path.join(freshSessionDir, "session-meta.json"), "{}", "utf-8");

    await markDirectoryHoursAgo(expiredSessionDir, 72);
    await markDirectoryHoursAgo(freshSessionDir, 0.1);

    process.env.AUTOMATION_RETENTION_HOURS = "1";
    process.env.AUTOMATION_RUNTIME_MAX_BYTES = String(1024 * 1024 * 100);

    await cleanupExpiredSessions(runtimeRoot);

    expect(existsSync(expiredSessionDir)).toBe(false);
    expect(existsSync(freshSessionDir)).toBe(true);
  } finally {
    if (previousRetentionHours === undefined) {
      delete process.env.AUTOMATION_RETENTION_HOURS;
    } else {
      process.env.AUTOMATION_RETENTION_HOURS = previousRetentionHours;
    }

    if (previousMaxBytes === undefined) {
      delete process.env.AUTOMATION_RUNTIME_MAX_BYTES;
    } else {
      process.env.AUTOMATION_RUNTIME_MAX_BYTES = previousMaxBytes;
    }

    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
