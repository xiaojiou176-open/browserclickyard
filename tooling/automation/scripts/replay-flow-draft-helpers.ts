import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserContext, Frame, Page } from "playwright";

import { AUTOMATION_ENV } from "./lib/env.js";

export type SelectorCandidate = {
  kind: "role" | "css" | "id" | "name";
  value: string;
  score: number;
};

export type FlowStep = {
  step_id: string;
  action: "navigate" | "click" | "type" | string;
  url?: string;
  value_ref?: string;
  gate_policy?: "auto" | "force_manual" | "forbid_manual";
  gate_reason?: string;
  selected_selector_index?: number;
  target?: {
    selectors?: SelectorCandidate[];
  };
};

export type FlowDraft = {
  flow_id: string;
  session_id: string;
  start_url: string;
  steps: FlowStep[];
};

export type SelectorAttempt = {
  selector_index: number;
  kind: string;
  value: string;
  normalized: string | null;
  success: boolean;
  error: string | null;
};

export type ReplayStepResult = {
  step_id: string;
  action: string;
  ok: boolean;
  detail: string;
  manual_gate_required?: boolean;
  provider_domain: string | null;
  gate_required_by_policy: boolean;
  matched_selector: string | null;
  selector_index: number | null;
  duration_ms: number;
  screenshot_before_path: string | null;
  screenshot_after_path: string | null;
  fallback_trail: SelectorAttempt[];
};

type StripeFieldKey =
  | "card_number"
  | "exp"
  | "exp_month"
  | "exp_year"
  | "cvc"
  | "postal_code"
  | "name";

export type ManualGateSignal = {
  required: boolean;
  reason: string | null;
  reason_code: string | null;
  at_step_id: string | null;
  after_step_id: string | null;
  resume_from_step_id: string | null;
  provider_domain: string | null;
  gate_required_by_policy: boolean;
  signals: string[];
  resume_hint: string | null;
};

const RUNTIME_ROOT = path.resolve(process.cwd(), "..", ".runtime-cache", "automation");
const REPO_ROOT = path.resolve(process.cwd(), "..");
const RESUME_STORAGE_STATE_FILE = "replay-resume-storage-state.json";
const RESUME_SESSION_FILE = "replay-resume-session.json";
const DEFAULT_PROTECTED_PROVIDER_DOMAINS = ["stripe.com", "js.stripe.com"];
const PROVIDER_PROTECTED_PAYMENT_REASON = "provider_protected_payment_step";
const SAFE_SELECTOR_LITERAL_PATTERN = /^[\w .:@/#()-]+$/u;

type OtpFetchAttempt = { code: string } | { code: null; transient: boolean; reason: string };

function quoteSelectorLiteral(value: string): string | null {
  return SAFE_SELECTOR_LITERAL_PATTERN.test(value) ? JSON.stringify(value) : null;
}

type StructuredRef = {
  scope: "params" | "secrets";
  key: string;
};

function readLegacyFlowInput(): string {
  const raw = AUTOMATION_ENV.FLOW_INPUT ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return "";
  }
  return raw;
}

function parseParamsPayload(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        params[key] = value;
      } else if (value == null) {
        params[key] = "";
      } else {
        params[key] = String(value);
      }
    }
    return params;
  } catch {
    return {};
  }
}

function readParamsFromEnv(): Record<string, string> {
  const preferred = (AUTOMATION_ENV.FLOW_PARAMS_JSON ?? "").trim();
  if (preferred) {
    return parseParamsPayload(preferred);
  }
  const fallback = (AUTOMATION_ENV.FLOW_INPUT ?? "").trim();
  if (fallback.startsWith("{") && fallback.endsWith("}")) {
    return parseParamsPayload(fallback);
  }
  return {};
}

function parseStructuredRef(valueRef: string): StructuredRef | null {
  const matched = valueRef.trim().match(/^\$\{(params|secrets)\.([A-Za-z0-9_.-]+)\}$/);
  if (!matched) {
    return null;
  }
  const scope = matched[1];
  const key = matched[2];
  if ((scope !== "params" && scope !== "secrets") || !key) {
    return null;
  }
  return { scope, key };
}

const FLOW_PARAMS = readParamsFromEnv();
const LEGACY_FLOW_INPUT = readLegacyFlowInput();
const OTP_TIMEOUT_SECONDS = 180;
const OTP_POLL_INTERVAL_SECONDS = 5;
const OTP_PROVIDER_TIMEOUT_MS = 8000;
const OTP_SENDER_FILTER = "";
const OTP_SUBJECT_FILTER = "";

function resolveRequiredSecretInput(): string {
  const secret = (
    AUTOMATION_ENV.FLOW_SECRET_INPUT ??
    AUTOMATION_ENV.REGISTER_PASSWORD ??
    ""
  ).trim();
  if (!secret) {
    throw new Error("missing secret input: set FLOW_SECRET_INPUT or REGISTER_PASSWORD");
  }
  return secret;
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function resolveFlowPath(): Promise<{ flowPath: string; sessionDir: string }> {
  const latest = await readJson<{ sessionDir: string }>(
    path.join(RUNTIME_ROOT, "latest-session.json"),
  );
  const flowPath = path.join(latest.sessionDir, "flow-draft.json");
  return { flowPath, sessionDir: latest.sessionDir };
}

async function maybeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch {
    return null;
  }
}

type ResumeSessionSnapshot = {
  updated_at: string;
  current_url: string;
  last_step_id: string | null;
  status: "running" | "manual_gate" | "failed" | "success";
};

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

function normalizeSelector(selector: SelectorCandidate): string | null {
  if (selector.kind === "role") {
    const rolePattern = selector.value.match(/^([a-zA-Z0-9_-]+)(?:\[name=['"](.+)['"]\])?$/);
    if (!rolePattern) {
      return null;
    }
    const [, role, name] = rolePattern;
    if (name) {
      const quotedName = quoteSelectorLiteral(name);
      return quotedName ? `role=${role}[name=${quotedName}]` : null;
    }
    return `role=${role}`;
  }
  if (selector.kind === "css") {
    return selector.value;
  }
  if (selector.kind === "id") {
    return selector.value.startsWith("#") ? selector.value : `#${selector.value}`;
  }
  if (selector.kind === "name") {
    if (selector.value.startsWith("[name=")) {
      return selector.value;
    }
    const normalizedName = selector.value.replace(/^name=/, "");
    const quotedName = quoteSelectorLiteral(normalizedName);
    return quotedName ? `[name=${quotedName}]` : null;
  }
  return null;
}

function selectorCandidates(
  step: FlowStep,
): Array<{ index: number; candidate: SelectorCandidate }> {
  const selectors = step.target?.selectors ?? [];
  if (selectors.length === 0) {
    return [];
  }
  const preferredRaw = Number(
    AUTOMATION_ENV.FLOW_SELECTOR_INDEX ?? step.selected_selector_index ?? 0,
  );
  const preferred = Number.isFinite(preferredRaw)
    ? Math.max(0, Math.min(selectors.length - 1, preferredRaw))
    : 0;
  const ordered = [preferred, ...selectors.map((_, idx) => idx).filter((idx) => idx !== preferred)];
  return ordered.map((idx) => ({ index: idx, candidate: selectors[idx] }));
}

export function parseProtectedProviderDomains(rawValue: string | undefined): string[] {
  const raw = (rawValue ?? "").trim();
  if (!raw) {
    return DEFAULT_PROTECTED_PROVIDER_DOMAINS;
  }
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.replace(/^https?:\/\//, "").split("/")[0] ?? item)
    .filter(Boolean);
}

function extractHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function resolveProviderDomainFromUrl(url: string, protectedDomains: string[]): string | null {
  const hostname = extractHostname(url);
  if (!hostname) {
    return null;
  }
  for (const domain of protectedDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return domain;
    }
  }
  return null;
}

export function resolveProviderDomainForStep(
  step: FlowStep,
  currentUrl: string,
  protectedDomains: string[],
): string | null {
  const fromStepUrl = step.url ? resolveProviderDomainFromUrl(step.url, protectedDomains) : null;
  if (fromStepUrl) {
    return fromStepUrl;
  }
  const fromCurrentUrl = resolveProviderDomainFromUrl(currentUrl, protectedDomains);
  if (fromCurrentUrl) {
    return fromCurrentUrl;
  }
  if (step.gate_reason === PROVIDER_PROTECTED_PAYMENT_REASON) {
    const blob =
      `${step.value_ref ?? ""} ${(step.target?.selectors ?? []).map((item) => item.value).join(" ")}`.toLowerCase();
    if (blob.includes("stripe")) {
      return "stripe.com";
    }
  }
  return null;
}

function firstNonEmptyEnv(keys: string[]): string {
  for (const key of keys) {
    const value = (process.env[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function parseEnvJsonMap(envKey: string): Record<string, string> {
  const raw = (process.env[envKey] ?? "").trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        normalized[key] = value;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function extractParamKey(valueRef: string): string | null {
  const match = valueRef.match(/^\$\{(?:params|secrets)\.([^}]+)\}$/);
  if (!match) {
    return null;
  }
  const key = match[1]?.trim();
  return key ? key : null;
}

export function detectStripeField(step: FlowStep): StripeFieldKey | null {
  const valueRef = (step.value_ref ?? "").toLowerCase();
  const selectors = (step.target?.selectors ?? [])
    .map((item) => item.value.toLowerCase())
    .join(" ");
  const text = `${valueRef} ${selectors}`;
  if (/(card.?number|cc-number|pan)/.test(text)) {
    return "card_number";
  }
  if (/(exp.?month|cc-exp-month)/.test(text)) {
    return "exp_month";
  }
  if (/(exp.?year|cc-exp-year)/.test(text)) {
    return "exp_year";
  }
  if (/(exp|expiry|expiration|cc-exp)/.test(text)) {
    return "exp";
  }
  if (/(cvc|cvv|security.?code|cc-csc)/.test(text)) {
    return "cvc";
  }
  if (/(postal|zip|post.?code|postal.?code)/.test(text)) {
    return "postal_code";
  }
  if (/(cardholder|name.?on.?card|cc-name)/.test(text)) {
    return "name";
  }
  return null;
}

function resolveStripeValue(field: StripeFieldKey): string {
  if (field === "card_number") {
    const value = firstNonEmptyEnv([
      "FLOW_STRIPE_CARD_NUMBER",
      "STRIPE_CARD_NUMBER",
      "FLOW_CARD_NUMBER",
    ]);
    if (!value) {
      throw new Error("missing Stripe env: FLOW_STRIPE_CARD_NUMBER");
    }
    return value;
  }
  if (field === "exp_month") {
    const value = firstNonEmptyEnv(["FLOW_STRIPE_EXP_MONTH", "STRIPE_EXP_MONTH"]);
    if (!value) {
      throw new Error("missing Stripe env: FLOW_STRIPE_EXP_MONTH");
    }
    return value;
  }
  if (field === "exp_year") {
    const value = firstNonEmptyEnv(["FLOW_STRIPE_EXP_YEAR", "STRIPE_EXP_YEAR"]);
    if (!value) {
      throw new Error("missing Stripe env: FLOW_STRIPE_EXP_YEAR");
    }
    return value;
  }
  if (field === "exp") {
    const direct = firstNonEmptyEnv(["FLOW_STRIPE_EXP", "STRIPE_EXP"]);
    if (direct) {
      return direct;
    }
    const month = firstNonEmptyEnv(["FLOW_STRIPE_EXP_MONTH", "STRIPE_EXP_MONTH"]);
    const year = firstNonEmptyEnv(["FLOW_STRIPE_EXP_YEAR", "STRIPE_EXP_YEAR"]);
    if (!month || !year) {
      throw new Error(
        "missing Stripe env: FLOW_STRIPE_EXP or FLOW_STRIPE_EXP_MONTH + FLOW_STRIPE_EXP_YEAR",
      );
    }
    return `${month}/${year}`;
  }
  if (field === "cvc") {
    const value = firstNonEmptyEnv(["FLOW_STRIPE_CVC", "STRIPE_CVC", "FLOW_CVC"]);
    if (!value) {
      throw new Error("missing Stripe env: FLOW_STRIPE_CVC");
    }
    return value;
  }
  if (field === "postal_code") {
    const value = firstNonEmptyEnv([
      "FLOW_STRIPE_POSTAL_CODE",
      "STRIPE_POSTAL_CODE",
      "FLOW_POSTAL_CODE",
    ]);
    if (!value) {
      throw new Error("missing Stripe env: FLOW_STRIPE_POSTAL_CODE");
    }
    return value;
  }
  const value = firstNonEmptyEnv(["FLOW_STRIPE_NAME", "STRIPE_NAME", "FLOW_CARDHOLDER_NAME"]);
  if (!value) {
    throw new Error("missing Stripe env: FLOW_STRIPE_NAME");
  }
  return value;
}

function stripeFrameSelectors(field: StripeFieldKey): string[] {
  if (field === "card_number") {
    return ["input[name='cardnumber']", "input[autocomplete='cc-number']"];
  }
  if (field === "exp") {
    return ["input[name='exp-date']", "input[autocomplete='cc-exp']"];
  }
  if (field === "exp_month") {
    return ["input[name='exp-date']", "input[autocomplete='cc-exp-month']"];
  }
  if (field === "exp_year") {
    return ["input[name='exp-date']", "input[autocomplete='cc-exp-year']"];
  }
  if (field === "cvc") {
    return ["input[name='cvc']", "input[autocomplete='cc-csc']"];
  }
  if (field === "postal_code") {
    return [
      "input[name='postal']",
      "input[name='postalCode']",
      "input[autocomplete='postal-code']",
    ];
  }
  return ["input[name='cardholder-name']", "input[autocomplete='cc-name']"];
}

function rankFrames(frames: Frame[]): Frame[] {
  return [...frames].sort((a, b) => {
    const aScore = /stripe|3ds|challenge/i.test(`${a.url()} ${a.name() ?? ""}`) ? 0 : 1;
    const bScore = /stripe|3ds|challenge/i.test(`${b.url()} ${b.name() ?? ""}`) ? 0 : 1;
    return aScore - bScore;
  });
}

export async function fillStripeViaFrames(
  page: Page,
  field: StripeFieldKey,
  value: string,
): Promise<{ selector: string | null; trail: SelectorAttempt[] }> {
  const selectors = stripeFrameSelectors(field);
  const trail: SelectorAttempt[] = [];
  for (const frame of rankFrames(page.frames())) {
    for (const selector of selectors) {
      try {
        await frame.locator(selector).first().waitFor({ state: "visible", timeout: 1_500 });
        await frame.locator(selector).first().fill(value, { timeout: 5_000 });
        trail.push({
          selector_index: -1,
          kind: "css",
          value: selector,
          normalized: selector,
          success: true,
          error: null,
        });
        return { selector: `frame:${frame.name() || frame.url()} >> ${selector}`, trail };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trail.push({
          selector_index: -1,
          kind: "css",
          value: selector,
          normalized: selector,
          success: false,
          error: message,
        });
      }
    }
  }
  return { selector: null, trail };
}

export function resolveFromStepIndex(flow: FlowDraft): number {
  const fromStepId = (AUTOMATION_ENV.FLOW_FROM_STEP_ID ?? "").trim();
  if (!fromStepId) {
    return 0;
  }
  const index = flow.steps.findIndex((step) => step.step_id === fromStepId);
  if (index < 0) {
    const known = flow.steps.map((step) => step.step_id).join(", ");
    throw new Error(`FLOW_FROM_STEP_ID not found: "${fromStepId}". Known step ids: [${known}]`);
  }
  return index;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientOtpError(reason: string): boolean {
  return /(timeout|timed out|temporary|try again|rate.?limit|429|5\d\d|network|econn|eai_|enotfound|unavailable)/i.test(
    reason,
  );
}

function fetchOtpFromProviderOnce(): OtpFetchAttempt {
  const provider = (AUTOMATION_ENV.FLOW_OTP_PROVIDER ?? process.env.FLOW_OTP_PROVIDER ?? "gmail")
    .trim()
    .toLowerCase();
  const regex = "\\b(\\d{6})\\b";
  const senderFilter = OTP_SENDER_FILTER;
  const subjectFilter = OTP_SUBJECT_FILTER;
  const pythonBin = path.join(REPO_ROOT, "scripts", "lib", "python-exec.sh");
  const timeoutMs = Math.max(1_000, OTP_PROVIDER_TIMEOUT_MS);
  const script = `
from app.services.otp_providers import OtpFetchRequest, resolve_otp_code
provider = ${JSON.stringify(provider)}
regex = ${JSON.stringify(regex)}
sender_filter = ${JSON.stringify(senderFilter)} or None
subject_filter = ${JSON.stringify(subjectFilter)} or None
code = resolve_otp_code(OtpFetchRequest(provider=provider, regex=regex, sender_filter=sender_filter, subject_filter=subject_filter))
print(code or "")
`.trim();
  const result = spawnSync(pythonBin, ["python", "-c", script], {
    cwd: REPO_ROOT,
    env: AUTOMATION_ENV,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  if (result.error) {
    const reason = result.error.message || result.error.name;
    return {
      code: null,
      transient: true,
      reason: `otp provider subprocess error (${provider}): ${reason}`,
    };
  }
  if (result.status !== 0) {
    const reason = result.stderr?.trim() || result.stdout?.trim() || `exit=${result.status}`;
    return {
      code: null,
      transient: isTransientOtpError(reason),
      reason: `otp provider failed (${provider}): ${reason}`,
    };
  }
  const code = (result.stdout ?? "").trim();
  if (code) {
    return { code };
  }
  return { code: null, transient: true, reason: "otp not available yet" };
}

function resolveRequiredSecretValue(paramKey: string | null): string {
  if (paramKey) {
    const normalizedKey = paramKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const envKey = `FLOW_SECRET_${normalizedKey}`;
    const value = firstNonEmptyEnv([envKey, "FLOW_SECRET_INPUT", "REGISTER_PASSWORD"]);
    if (value) {
      return value;
    }
    throw new Error(
      `missing secret input for ${paramKey}; set FLOW_SECRET_INPUT_JSON.${paramKey} or ${envKey} or FLOW_SECRET_INPUT`,
    );
  }
  const fallback = firstNonEmptyEnv(["FLOW_SECRET_INPUT", "REGISTER_PASSWORD"]);
  if (fallback) {
    return fallback;
  }
  throw new Error(
    "missing secret input; set FLOW_SECRET_INPUT (or REGISTER_PASSWORD for legacy callers)",
  );
}

async function resolveOtpValue(): Promise<string> {
  const direct = (AUTOMATION_ENV.FLOW_OTP_CODE ?? "").trim();
  if (direct) {
    return direct;
  }
  const timeoutSeconds = Math.max(5, OTP_TIMEOUT_SECONDS);
  const intervalSeconds = Math.max(1, OTP_POLL_INTERVAL_SECONDS);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastTransientReason = "otp not available yet";
  while (Date.now() <= deadline) {
    const attempt = fetchOtpFromProviderOnce();
    if (attempt.code !== null) {
      return attempt.code;
    }
    if (!attempt.transient) {
      throw new Error(attempt.reason);
    }
    lastTransientReason = attempt.reason;
    await sleep(intervalSeconds * 1000);
  }
  throw new Error(`OTP not found within ${timeoutSeconds}s (${lastTransientReason})`);
}

export async function resolveTypeValue(step: FlowStep): Promise<string> {
  const valueRef = (step.value_ref ?? "").trim();
  const structuredRef = parseStructuredRef(valueRef);
  const stripeField = detectStripeField(step);
  if (stripeField) {
    return resolveStripeValue(stripeField);
  }
  const paramKey = extractParamKey(valueRef);
  const inputMap = parseEnvJsonMap("FLOW_INPUT_JSON");
  const secretMap = parseEnvJsonMap("FLOW_SECRET_INPUT_JSON");
  if (structuredRef) {
    const fromParams = FLOW_PARAMS[structuredRef.key];
    if (typeof fromParams === "string") {
      if (structuredRef.key.toLowerCase().includes("otp") && fromParams.trim()) {
        return fromParams.trim();
      }
      return fromParams;
    }
    if (structuredRef.key.toLowerCase().includes("otp")) {
      return await resolveOtpValue();
    }
    if (structuredRef.scope === "secrets") {
      if (secretMap[structuredRef.key]) {
        return secretMap[structuredRef.key];
      }
      return resolveRequiredSecretInput();
    }
    if (LEGACY_FLOW_INPUT) {
      return LEGACY_FLOW_INPUT;
    }
    return "";
  }
  if (isOtpStep(step) || valueRef.toLowerCase().includes("otp")) {
    return await resolveOtpValue();
  }
  if (valueRef.includes("secrets")) {
    if (paramKey && secretMap[paramKey]) {
      return secretMap[paramKey];
    }
    return resolveRequiredSecretValue(paramKey);
  }
  if (paramKey && inputMap[paramKey]) {
    return inputMap[paramKey];
  }
  if (LEGACY_FLOW_INPUT) {
    return LEGACY_FLOW_INPUT;
  }
  return `demo-${Date.now()}`;
}

function hasOtpHint(text: string): boolean {
  return /(otp|mfa|2fa|two[-_\s]?factor|one[-_\s]?time|verification(?:[-_\s]?code)?|auth(?:entication)?[-_\s]?code)/i.test(
    text,
  );
}

export async function detect3DSManualGate(
  page: Page,
): Promise<{ required: boolean; signals: string[] }> {
  const signals = new Set<string>();
  const allFrames = page.frames();
  const allUrls = allFrames.map((frame) => frame.url());
  const hasStrong3dsUrl = allUrls.some((url) =>
    /(3d[_-]?secure|three[_-]?d[_-]?secure|3ds2|cardinalcommerce|securecode|acs|\/v1\/challenge|\/challenge\/3ds)/i.test(
      url,
    ),
  );
  if (hasStrong3dsUrl) {
    signals.add("3ds-frame-url-strong");
  }
  let hasStrong3dsText = false;
  for (const frame of allFrames) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 1_000 });
      if (
        /(3d secure|three[- ]d secure|authenticate your payment|issuer authentication|bank card authentication|challenge window)/i.test(
          text,
        )
      ) {
        signals.add("3ds-text-strong");
        hasStrong3dsText = true;
        break;
      }
    } catch {
      // ignore frame read failures; detection remains conservative.
    }
  }
  const required = hasStrong3dsUrl || hasStrong3dsText;
  return { required, signals: [...signals] };
}

export function isOtpStep(step: FlowStep): boolean {
  const ref = (step.value_ref ?? "").toLowerCase();
  if (hasOtpHint(ref)) {
    return true;
  }
  const selectorBlob = (step.target?.selectors ?? [])
    .map((item) => `${item.kind}:${item.value}`.toLowerCase())
    .join(" ");
  return (
    hasOtpHint(selectorBlob) ||
    /\bname=['"]?(otp|mfa|verification|verification_code|authcode)/i.test(selectorBlob) ||
    /\btype=['"]?(tel|number|one-time-code)/i.test(selectorBlob)
  );
}

function isSensitiveTypeStep(step: FlowStep): boolean {
  if (step.action !== "type") {
    return false;
  }
  if (detectStripeField(step)) {
    return true;
  }
  const ref = (step.value_ref ?? "").toLowerCase();
  const selectors = (step.target?.selectors ?? [])
    .map((item) => item.value.toLowerCase())
    .join(" ");
  const text = `${ref} ${selectors}`;
  return /(secret|password|passwd|token|otp|verification|code|cvc|cvv|card|cc-|exp|postal|zip|stripe)/i.test(
    text,
  );
}

export function shouldCaptureScreenshotsForStep(step: FlowStep): boolean {
  if (!isSensitiveTypeStep(step)) {
    return true;
  }
  return false;
}

export async function applyWithFallback(
  _page: Page,
  step: FlowStep,
  action: (selector: string) => Promise<void>,
): Promise<{
  ok: boolean;
  detail: string;
  matched_selector: string | null;
  selector_index: number | null;
  fallback_trail: SelectorAttempt[];
}> {
  const trail: SelectorAttempt[] = [];
  const candidates = selectorCandidates(step);
  if (candidates.length === 0) {
    return {
      ok: false,
      detail: "no selector candidates",
      matched_selector: null,
      selector_index: null,
      fallback_trail: trail,
    };
  }
  for (const { index, candidate } of candidates) {
    const normalized = normalizeSelector(candidate);
    if (!normalized) {
      trail.push({
        selector_index: index,
        kind: candidate.kind,
        value: candidate.value,
        normalized: null,
        success: false,
        error: "selector kind not actionable",
      });
      continue;
    }
    try {
      await action(normalized);
      trail.push({
        selector_index: index,
        kind: candidate.kind,
        value: candidate.value,
        normalized,
        success: true,
        error: null,
      });
      return {
        ok: true,
        detail: `matched selector[${index}] ${normalized}`,
        matched_selector: normalized,
        selector_index: index,
        fallback_trail: trail,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trail.push({
        selector_index: index,
        kind: candidate.kind,
        value: candidate.value,
        normalized,
        success: false,
        error: message,
      });
    }
  }
  return {
    ok: false,
    detail: "all selector attempts failed",
    matched_selector: null,
    selector_index: null,
    fallback_trail: trail,
  };
}

export async function waitPrecondition(
  page: Page,
  step: FlowStep,
): Promise<{ ok: boolean; detail: string; fallback_trail: SelectorAttempt[] }> {
  if (step.action === "navigate") {
    return { ok: true, detail: "navigate step has no precondition wait", fallback_trail: [] };
  }
  const waitResult = await applyWithFallback(page, step, async (selector) => {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 5_000 });
  });
  return {
    ok: waitResult.ok,
    detail: waitResult.ok ? "precondition wait passed" : waitResult.detail,
    fallback_trail: waitResult.fallback_trail,
  };
}
