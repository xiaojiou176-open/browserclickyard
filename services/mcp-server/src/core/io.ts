// @ts-nocheck
// 
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { MCP_ENV, mcpEnv, mcpInt } from "../env.js";

export type JsonObject = Record<string, unknown>;

export type AutomationRunPayloadMode = "strict";

const API_REQUEST_TIMEOUT_MS_DEFAULT = 15_000;
const RUN_STREAM_TERM_GRACE_MS_DEFAULT = 1_000;
const MCP_AUDIT_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const MCP_AUDIT_BACKUP_COUNT_DEFAULT = 5;
const MCP_AUDIT_RETENTION_DAYS_DEFAULT = 7;

let auditWriteFailureCount = 0;

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function exposeAdvancedTools(): boolean {
  if (MCP_ENV.UIQ_MCP_EXPOSE_ADVANCED_TOOLS !== undefined) {
    return parseBooleanEnv(MCP_ENV.UIQ_MCP_EXPOSE_ADVANCED_TOOLS);
  }
  return parseBooleanEnv(MCP_ENV.UIQ_MCP_EXPOSE_ADVANCED);
}

export function workspaceRoot(): string {
  return resolve(".");
}

export function runtimeCacheRoot(): string {
  const explicit =
    mcpEnv("UIQ_MCP_RUNTIME_CACHE_ROOT", "").trim() || mcpEnv("UIQ_RUNTIME_CACHE_ROOT", "").trim();
  if (!explicit) {
    return resolve(workspaceRoot(), ".runtime-cache");
  }
  return isAbsolute(explicit) ? resolve(explicit) : resolve(workspaceRoot(), explicit);
}

export function runsRoot(): string {
  return resolve(runtimeCacheRoot(), "artifacts/runs");
}

export function proofCampaignsRoot(): string {
  return resolve(runtimeCacheRoot(), "artifacts/proof-campaigns");
}

export function repoRoot(): string {
  return workspaceRoot();
}

export function automationRunPayloadMode(): AutomationRunPayloadMode {
  const policyPath = resolve(repoRoot(), "configs/env/governance-policy.yaml");
  try {
    const raw = readUtf8(policyPath);
    const line = raw
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.startsWith("automation_run_payload_mode:"));
    if (!line) {
      return "strict";
    }
    const value = line
      .split(":", 2)[1]
      ?.trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    return value === "strict" ? "strict" : "strict";
  } catch {
    return "strict";
  }
}

export function backendBaseUrl(): string {
  return (
    mcpEnv("UIQ_MCP_API_BASE_URL", "http://127.0.0.1:18080").trim() || "http://127.0.0.1:18080"
  );
}

export function backendToken(): string | undefined {
  const token = mcpEnv("AUTOMATION_API_TOKEN", "").trim();
  return token ? token : undefined;
}

export function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value?.trim() ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
}

export function apiRequestTimeoutMs(): number {
  return mcpInt("UIQ_MCP_API_TIMEOUT_MS", API_REQUEST_TIMEOUT_MS_DEFAULT);
}

export function runStreamTermGraceMs(): number {
  return RUN_STREAM_TERM_GRACE_MS_DEFAULT;
}

export function auditLogPath(): string {
  return resolve(runtimeCacheRoot(), "logs/mcp-audit.jsonl");
}

export function mcpAuditFailureCount(): number {
  return auditWriteFailureCount;
}

function pruneOldAuditBackups(absPath: string, retentionDays: number, backupCount: number): void {
  const retentionCutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const candidates: string[] = [absPath];
  for (let idx = 1; idx <= backupCount; idx += 1) {
    candidates.push(`${absPath}.${idx}`);
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const mtimeMs = statSync(candidate).mtimeMs;
    if (mtimeMs >= retentionCutoffMs) {
      continue;
    }
    unlinkSync(candidate);
  }
}

function rotateAuditIfNeeded(absPath: string, incomingBytes = 0): void {
  const maxBytes = parsePositiveIntEnv(
    mcpEnv("UIQ_MCP_AUDIT_MAX_BYTES", ""),
    MCP_AUDIT_MAX_BYTES_DEFAULT,
  );
  const backupCount = parsePositiveIntEnv(
    mcpEnv("UIQ_MCP_AUDIT_BACKUP_COUNT", ""),
    MCP_AUDIT_BACKUP_COUNT_DEFAULT,
  );
  const retentionDays = parsePositiveIntEnv(
    mcpEnv("UIQ_MCP_AUDIT_RETENTION_DAYS", ""),
    MCP_AUDIT_RETENTION_DAYS_DEFAULT,
  );
  if (existsSync(absPath)) {
    const currentBytes = statSync(absPath).size;
    if (currentBytes + Math.max(0, incomingBytes) > maxBytes) {
      const oldest = `${absPath}.${backupCount}`;
      if (existsSync(oldest)) {
        unlinkSync(oldest);
      }
      for (let idx = backupCount - 1; idx >= 1; idx -= 1) {
        const from = `${absPath}.${idx}`;
        const to = `${absPath}.${idx + 1}`;
        if (existsSync(from)) {
          renameSync(from, to);
        }
      }
      renameSync(absPath, `${absPath}.1`);
    }
  }
  pruneOldAuditBackups(absPath, retentionDays, backupCount);
}

export function writeAudit(event: {
  type: string;
  ok: boolean;
  detail?: string;
  meta?: JsonObject;
}): void {
  try {
    const abs = auditLogPath();
    const meta = event.meta ?? {};
    const runId =
      typeof meta.runId === "string" && meta.runId.trim().length > 0 ? meta.runId.trim() : undefined;
    const gateName =
      typeof meta.gateName === "string" && meta.gateName.trim().length > 0
        ? meta.gateName.trim()
        : undefined;
    const profile =
      typeof meta.profile === "string" && meta.profile.trim().length > 0 ? meta.profile.trim() : undefined;
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      component: "mcp",
      evidenceClass: "log",
      event: event.type,
      status: event.ok ? "ok" : "error",
      ...(runId ? { runId } : {}),
      ...(gateName ? { gateName } : {}),
      ...(profile ? { profile } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
      meta,
    })}\n`;
    mkdirSync(dirname(abs), { recursive: true });
    rotateAuditIfNeeded(abs, Buffer.byteLength(line, "utf8"));
    appendFileSync(abs, line, "utf8");
  } catch (error) {
    auditWriteFailureCount += 1;
    const _detail = error instanceof Error ? error.message : String(error);
  }
}

export function ensureDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function safeReadDirNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function safeResolveUnder(rootAbs: string, ...segments: string[]): string {
  const normalizedRoot = resolve(rootAbs);
  const hasCanonicalRoot = existsSync(normalizedRoot);
  const rootReal = hasCanonicalRoot ? realpathSync(normalizedRoot) : normalizedRoot;
  const assertInsideRoot = (candidateAbs: string): void => {
    const relReal = relative(rootReal, candidateAbs).replaceAll("\\", "/");
    if (
      isAbsolute(relReal) ||
      relReal === ".." ||
      relReal.startsWith("../") ||
      relReal.includes("/../")
    ) {
      throw new Error("path traversal blocked");
    }
  };
  const decodePathSegment = (segment: string): string => {
    let decoded = segment;
    for (let i = 0; i < 3; i += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          return decoded;
        }
        decoded = next;
      } catch {
        throw new Error("Invalid artifact path");
      }
    }
    return decoded;
  };
  const normalizedSegments = segments.map((segment) => {
    if (segment.includes("\0")) {
      throw new Error("path traversal blocked");
    }
    const normalized = decodePathSegment(segment).replaceAll("\\", "/").trim();
    const parts = normalized.split("/").filter((item) => item.length > 0);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new Error("path traversal blocked");
    }
    if (
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.startsWith("/") ||
      normalized.startsWith("//")
    ) {
      throw new Error("path traversal blocked");
    }
    return normalized;
  });
  const abs = resolve(normalizedRoot, ...normalizedSegments);
  const rel = relative(normalizedRoot, abs);
  if (rel === "") {
    return abs;
  }
  const normalizedRel = rel.replaceAll("\\", "/");
  if (isAbsolute(rel) || normalizedRel === ".." || normalizedRel.startsWith("../")) {
    throw new Error("path traversal blocked");
  }
  // If the target exists, canonicalize it to block symlink escapes and ensure
  // downstream allowlist checks evaluate the real location.
  if (existsSync(abs)) {
    const absReal = realpathSync(abs);
    assertInsideRoot(absReal);
    return absReal;
  }
  // For non-existing leaf paths, resolve nearest existing ancestor to detect
  // symlinked parent escapes (for example link/child.txt where child is absent).
  let ancestor = dirname(abs);
  while (ancestor !== dirname(ancestor) && !existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }
  if (hasCanonicalRoot && existsSync(ancestor)) {
    assertInsideRoot(realpathSync(ancestor));
  }
  return abs;
}

export function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson(absPath: string): unknown {
  return JSON.parse(readUtf8(absPath));
}

export function readJsonMaybe<T>(absPath: string): T | undefined {
  if (!existsSync(absPath)) {
    return undefined;
  }
  return readJson(absPath) as T;
}

export function writeJson(absPath: string, payload: unknown): void {
  mkdirSync(resolve(absPath, ".."), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function listRunIds(limit = 20): string[] {
  const root = runsRoot();
  if (!ensureDir(root)) {
    return [];
  }
  return safeReadDirNames(root)
    .map((name) => {
      try {
        const abs = resolve(root, name);
        const stat = statSync(abs);
        return { name, mtimeMs: stat.mtimeMs, isDir: stat.isDirectory() };
      } catch {
        return null;
      }
    })
    .filter((d): d is { name: string; mtimeMs: number; isDir: boolean } => d !== null)
    .filter((d) => d.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map((d) => d.name);
}

export function latestRunId(): string | undefined {
  return listRunIds(1)[0];
}

export function listProofCampaignIds(limit = 20): string[] {
  const root = proofCampaignsRoot();
  if (!ensureDir(root)) {
    return [];
  }
  return safeReadDirNames(root)
    .map((name) => {
      try {
        const abs = resolve(root, name);
        const stat = statSync(abs);
        return { name, mtimeMs: stat.mtimeMs, isDir: stat.isDirectory() };
      } catch {
        return null;
      }
    })
    .filter((d): d is { name: string; mtimeMs: number; isDir: boolean } => d !== null)
    .filter((d) => d.isDir)
    .filter((d) => !d.name.startsWith("_"))
    .filter((d) => {
      try {
        return existsSync(safeResolveUnder(root, d.name, "campaign.report.json"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 200)))
    .map((d) => d.name);
}

export function latestProofCampaignId(): string | undefined {
  return listProofCampaignIds(1)[0];
}

export function listYamlStemNames(dirAbs: string): string[] {
  if (!ensureDir(dirAbs)) {
    return [];
  }
  return safeReadDirNames(dirAbs)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => name.replace(/\.(ya?ml)$/i, ""));
}
