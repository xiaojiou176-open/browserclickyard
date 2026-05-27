import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const RUN_ID_MAX_LENGTH = 128;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function sanitizeRunId(runId: string): string {
  const normalized = runId.trim();
  if (!normalized) {
    throw new Error("Invalid runId: empty value");
  }
  if (normalized === "." || normalized === "..") {
    throw new Error("Invalid runId: reserved path segment");
  }
  if (normalized.length > RUN_ID_MAX_LENGTH) {
    throw new Error(`Invalid runId: exceeds ${RUN_ID_MAX_LENGTH} chars`);
  }
  if (!RUN_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid runId: only [A-Za-z0-9._-] allowed");
  }
  return normalized;
}

function assertWithinRunsRoot(runsRoot: string, candidate: string): void {
  const rel = relative(runsRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("run directory escapes runs root");
  }
}

export function ensureRunDirectories(runId: string): string {
  const safeRunId = sanitizeRunId(runId);
  const runsRoot = resolve(".runtime-cache/artifacts/runs");
  const baseDir = resolve(runsRoot, safeRunId);
  const required = [
    "screenshots",
    "traces",
    "network",
    "logs",
    "a11y",
    "perf",
    "visual",
    "visual/current",
    "visual/diff",
    "security",
    "metrics",
    "reports",
    "videos",
  ];

  mkdirSync(runsRoot, { recursive: true });
  const runsRootReal = realpathSync(runsRoot);
  assertWithinRunsRoot(runsRootReal, baseDir);

  mkdirSync(baseDir, { recursive: true });
  const baseDirReal = realpathSync(baseDir);
  assertWithinRunsRoot(runsRootReal, baseDirReal);
  for (const dir of required) {
    const dirPath = resolve(baseDirReal, dir);
    assertWithinRunsRoot(baseDirReal, dirPath);
    mkdirSync(dirPath, { recursive: true });
  }

  return baseDirReal;
}
