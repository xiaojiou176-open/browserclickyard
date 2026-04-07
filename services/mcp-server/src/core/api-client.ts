// @ts-nocheck
// 
import {
  DEFAULT_API_RETRY_BASE_DELAY_MS,
  DEFAULT_API_RETRY_MAX_ATTEMPTS,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_BACKEND_BASE_URL,
  envFlag,
  envPositiveInt,
  isLoopbackHost,
  sleep,
} from "./constants.js";
import { writeAudit } from "./io.js";
import type { JsonObject } from "./types.js";

let backendBaseUrlOverride: string | undefined;

export function setBackendBaseUrlOverride(value?: string): void {
  backendBaseUrlOverride = value?.trim() || undefined;
}

function allowRemoteBackendBaseUrl(): boolean {
  return envFlag("UIQ_MCP_ALLOW_REMOTE_BASE_URL");
}

function allowRemoteTokenForwarding(): boolean {
  return envFlag("UIQ_MCP_ALLOW_REMOTE_TOKEN_FORWARDING");
}

function remoteTokenHostAllowlist(): Set<string> {
  const raw = process.env.UIQ_MCP_REMOTE_TOKEN_HOST_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isTimeoutAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error && cause.name === "AbortError";
}

function fetchErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const direct = (error as Error & { code?: unknown }).code;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

function isRetryableFetchError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return false;
  }
  const code = fetchErrorCode(error);
  return code === "EADDRNOTAVAIL" || code === "ECONNRESET" || code === "ECONNREFUSED";
}

export function canForwardTokenToBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (isLoopbackHost(url.hostname)) {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    if (!allowRemoteTokenForwarding()) {
      return false;
    }
    if (url.protocol !== "https:") {
      return false;
    }
    return remoteTokenHostAllowlist().has(url.hostname.trim().toLowerCase());
  } catch {
    return false;
  }
}

export function isTrustedBackendBaseUrl(baseUrl: string): boolean {
  if (allowRemoteBackendBaseUrl()) {
    return true;
  }
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeBackendBaseUrl(input?: string): string {
  const raw = input?.trim();
  if (!raw) {
    return DEFAULT_BACKEND_BASE_URL;
  }
  if (!isTrustedBackendBaseUrl(raw)) {
    return DEFAULT_BACKEND_BASE_URL;
  }
  return raw.replace(/\/+$/, "");
}

export function backendBaseUrl(): string {
  return normalizeBackendBaseUrl(backendBaseUrlOverride ?? process.env.UIQ_MCP_API_BASE_URL);
}

export function backendToken(): string | undefined {
  const token = process.env.AUTOMATION_API_TOKEN?.trim();
  return token ? token : undefined;
}

function perfectModeEnabled(): boolean {
  const raw = process.env.UIQ_MCP_PERFECT_MODE;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  return envFlag("UIQ_MCP_PERFECT_MODE");
}

function advancedToolsExplicitlyDisabled(): boolean {
  const raw = process.env.UIQ_MCP_ENABLE_ADVANCED_TOOLS;
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off"
  );
}

export function isAdvancedToolsEnabled(): boolean {
  const advancedRaw = process.env.UIQ_MCP_ENABLE_ADVANCED_TOOLS;
  const advancedEnabled =
    advancedRaw === undefined || advancedRaw.trim() === ""
      ? true
      : envFlag("UIQ_MCP_ENABLE_ADVANCED_TOOLS");
  if (!perfectModeEnabled()) {
    return advancedEnabled;
  }
  if (advancedToolsExplicitlyDisabled()) {
    throw new Error(
      "UIQ_MCP_PERFECT_MODE=true requires UIQ_MCP_ENABLE_ADVANCED_TOOLS not be explicitly false",
    );
  }
  // Perfect mode forces advanced capability exposure unless it is explicitly disabled.
  return true;
}

function apiTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.UIQ_MCP_API_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_API_TIMEOUT_MS;
}

function apiRetryMaxAttempts(): number {
  return envPositiveInt("UIQ_MCP_API_RETRY_MAX_ATTEMPTS", DEFAULT_API_RETRY_MAX_ATTEMPTS, 1, 20);
}

function apiRetryBaseDelayMs(): number {
  return envPositiveInt(
    "UIQ_MCP_API_RETRY_BASE_DELAY_MS",
    DEFAULT_API_RETRY_BASE_DELAY_MS,
    1,
    60_000,
  );
}

function jsonObjectOrThrow(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} returned non-object payload`);
  }
  return value as JsonObject;
}

function listFromApiPayload(payload: JsonObject, keys: string[]): JsonObject[] {
  for (const key of keys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (item): item is JsonObject =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    }
  }
  return [];
}

export function readFirstString(payload: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function normalizeRunPayload(payload: JsonObject): JsonObject {
  const nestedRun = asObject(payload.run);
  if (!nestedRun) {
    return payload;
  }
  const normalized: JsonObject = { ...nestedRun };
  const topLevelTaskId = readFirstString(payload, ["task_id", "taskId"]);
  if (topLevelTaskId && !readFirstString(normalized, ["task_id", "taskId"])) {
    normalized.task_id = topLevelTaskId;
  }
  return normalized;
}

export function parseRunStatus(run: JsonObject): string {
  const status = normalizeRunPayload(run).status;
  return typeof status === "string" ? status : "unknown";
}

export function extractRunId(run: JsonObject): string {
  const runId = readFirstString(normalizeRunPayload(run), ["run_id", "runId"]);
  if (!runId) {
    throw new Error("run id missing in run payload");
  }
  return runId;
}

export async function apiRequest(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: string; json?: unknown }> {
  const baseUrl = backendBaseUrl();
  const method = init?.method ?? "GET";
  const timeoutMs = apiTimeoutMs();
  const maxAttempts = apiRetryMaxAttempts();
  const retryBaseDelayMs = apiRetryBaseDelayMs();
  const url = new URL(
    path.startsWith("/") ? path : `/${path}`,
    `${baseUrl.replace(/\/+$/, "")}/`,
  ).toString();
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("content-type") && init?.body) {
    headers.set("content-type", "application/json");
  }
  const token = backendToken();
  const tokenForwardAllowed = token ? canForwardTokenToBaseUrl(baseUrl) : false;
  if (token && !tokenForwardAllowed) {
    const result = { ok: false, status: 401, body: "invalid automation token" };
    writeAudit({
      type: "api_request",
      ok: false,
      detail: `${method} ${path} -> ${result.status} (remote token forwarding blocked)`,
      meta: {
        baseUrl,
        method,
        path,
        attempt: 0,
        maxAttempts,
        willRetry: false,
        errorCode: "TOKEN_FORWARD_BLOCKED",
      },
    });
    return result;
  }
  if (token && tokenForwardAllowed) {
    headers.set("x-automation-token", token);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeoutHandle);
      const isTimeoutError = isTimeoutAbortError(error, controller.signal);
      const retryable = isRetryableFetchError(error, controller.signal);
      const errorCode = fetchErrorCode(error) ?? "UNKNOWN_FETCH_ERROR";
      const willRetry = !isTimeoutError && retryable && attempt < maxAttempts;
      const retryDelayMs = willRetry ? retryBaseDelayMs * attempt : 0;
      writeAudit({
        type: "api_request",
        ok: false,
        detail: `${method} ${path} -> ${isTimeoutError ? 408 : 503} (${(error as Error).message})`,
        meta: {
          baseUrl,
          method,
          path,
          attempt,
          maxAttempts,
          willRetry,
          retryDelayMs,
          timeoutMs,
          errorCode,
          isTimeoutError,
          retryable,
        },
      });
      if (willRetry) {
        // Backoff briefly on transient local-socket churn (for example EADDRNOTAVAIL).
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs);
        continue;
      }
      const detail = isTimeoutError
        ? `request timeout after ${timeoutMs}ms`
        : `request failed: ${(error as Error).message}`;
      const result = { ok: false, status: isTimeoutError ? 408 : 503, body: detail };
      return result;
    }
    clearTimeout(timeoutHandle);
    const body = await response.text();
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const result = { ok: response.ok, status: response.status, body, json };
    writeAudit({
      type: "api_request",
      ok: result.ok,
      detail: `${method} ${path} -> ${result.status}`,
      meta: {
        baseUrl,
        method,
        path,
        attempt,
        maxAttempts,
        willRetry: false,
        retried: attempt > 1,
        timeoutMs,
      },
    });
    return result;
  }
  const fallback = { ok: false, status: 503, body: "request failed: unknown network error" };
  writeAudit({
    type: "api_request",
    ok: false,
    detail: `${method} ${path} -> ${fallback.status} (${fallback.body})`,
    meta: {
      baseUrl,
      method,
      path,
      attempt: maxAttempts,
      maxAttempts,
      willRetry: false,
      errorCode: "UNKNOWN_NETWORK_ERROR",
    },
  });
  return fallback;
}

async function apiJsonRequest(path: string, init?: RequestInit): Promise<JsonObject> {
  const response = await apiRequest(path, init);
  if (!response.ok) {
    throw new Error(
      `api ${init?.method ?? "GET"} ${path} failed: ${response.status} ${response.body}`,
    );
  }
  return jsonObjectOrThrow(response.json, `api ${path}`);
}

export async function apiStartSession(startUrl: string, mode: string): Promise<JsonObject> {
  return apiJsonRequest("/api/sessions/start", {
    method: "POST",
    body: JSON.stringify({ start_url: startUrl, mode }),
  });
}

export async function apiListSessions(limit: number): Promise<JsonObject[]> {
  const payload = await apiJsonRequest(`/api/sessions?limit=${encodeURIComponent(String(limit))}`);
  return listFromApiPayload(payload, ["sessions", "items"]);
}

export async function apiFinishSession(sessionId: string): Promise<JsonObject> {
  return apiJsonRequest(`/api/sessions/${encodeURIComponent(sessionId)}/finish`, {
    method: "POST",
  });
}

export async function apiImportLatestFlow(): Promise<JsonObject> {
  return apiJsonRequest("/api/flows/import-latest", { method: "POST" });
}

export async function apiCreateTemplate(payload: JsonObject): Promise<JsonObject> {
  return apiJsonRequest("/api/templates", { method: "POST", body: JSON.stringify(payload) });
}

export async function apiGetFlow(flowId: string): Promise<JsonObject> {
  return apiJsonRequest(`/api/flows/${encodeURIComponent(flowId)}`);
}

export async function apiGetTemplate(templateId: string): Promise<JsonObject> {
  return apiJsonRequest(`/api/templates/${encodeURIComponent(templateId)}`);
}

export async function apiCreateRun(
  templateId: string,
  params: JsonObject,
  otpCode?: string,
): Promise<JsonObject> {
  const payload = await apiJsonRequest("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      template_id: templateId,
      params,
      ...(otpCode ? { otp_code: otpCode } : {}),
    }),
  });
  return normalizeRunPayload(payload);
}

export async function apiGetRun(runId: string): Promise<JsonObject> {
  const payload = await apiJsonRequest(`/api/runs/${encodeURIComponent(runId)}`);
  return normalizeRunPayload(payload);
}

export async function apiSubmitRunOtp(runId: string, otpCode: string): Promise<JsonObject> {
  const payload = await apiJsonRequest(`/api/runs/${encodeURIComponent(runId)}/otp`, {
    method: "POST",
    body: JSON.stringify({ otp_code: otpCode }),
  });
  return normalizeRunPayload(payload);
}

export function asObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}
