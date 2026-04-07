import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

import { maybeReadJson } from "./replay-flow-parse.js";
import {
  RESUME_SESSION_FILE,
  RESUME_STORAGE_STATE_FILE,
  type ResumeSessionSnapshot,
} from "./replay-flow-types.js";

export async function loadResumeContext(sessionDir: string): Promise<{
  storageStatePath: string | null;
  snapshot: ResumeSessionSnapshot | null;
}> {
  const storageStatePath = path.join(sessionDir, RESUME_STORAGE_STATE_FILE);
  let hasStorageState = false;
  try {
    await readFile(storageStatePath, "utf-8");
    hasStorageState = true;
  } catch {
    hasStorageState = false;
  }
  const snapshotPath = path.join(sessionDir, RESUME_SESSION_FILE);
  const snapshot = await maybeReadJson<ResumeSessionSnapshot>(snapshotPath);
  return {
    storageStatePath: hasStorageState ? storageStatePath : null,
    snapshot,
  };
}

export async function persistResumeContext(
  context: BrowserContext,
  page: Page,
  sessionDir: string,
  status: ResumeSessionSnapshot["status"],
  lastStepId: string | null,
): Promise<void> {
  const storageStatePath = path.join(sessionDir, RESUME_STORAGE_STATE_FILE);
  const snapshotPath = path.join(sessionDir, RESUME_SESSION_FILE);
  await context.storageState({ path: storageStatePath });
  const snapshot: ResumeSessionSnapshot = {
    updated_at: new Date().toISOString(),
    current_url: page.url(),
    last_step_id: lastStepId,
    status,
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}
