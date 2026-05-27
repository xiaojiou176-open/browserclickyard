import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Frame, Page } from "playwright";

import { resolveProviderDomainForStep } from "./replay-flow-parse.js";
import {
  type FlowStep,
  type OtpFetchAttempt,
  REPO_ROOT,
  type ReplayStepResult,
  type SelectorAttempt,
  type StripeFieldKey,
} from "./replay-flow-types.js";

const OTP_TIMEOUT_SECONDS = 180;
const OTP_POLL_INTERVAL_SECONDS = 5;
const OTP_PROVIDER_TIMEOUT_MS = 8000;
const OTP_SENDER_FILTER = "";
const OTP_SUBJECT_FILTER = "";
const SAFE_SELECTOR_LITERAL_PATTERN = /^[\w .:@/#()-]+$/u;

function quoteSelectorLiteral(value: string): string | null {
  return SAFE_SELECTOR_LITERAL_PATTERN.test(value) ? JSON.stringify(value) : null;
}

function normalizeSelector(selector: {
  kind: "role" | "css" | "id" | "name";
  value: string;
}): string | null {
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

function selectorCandidates(step: FlowStep): Array<{
  index: number;
  candidate: { kind: "role" | "css" | "id" | "name"; value: string; score: number };
}> {
  const selectors = step.target?.selectors ?? [];
  if (selectors.length === 0) {
    return [];
  }
  const preferredRaw = Number(process.env.FLOW_SELECTOR_INDEX ?? step.selected_selector_index ?? 0);
  const preferred = Number.isFinite(preferredRaw)
    ? Math.max(0, Math.min(selectors.length - 1, preferredRaw))
    : 0;
  const ordered = [preferred, ...selectors.map((_, idx) => idx).filter((idx) => idx !== preferred)];
  return ordered.map((idx) => ({ index: idx, candidate: selectors[idx]! }));
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

function detectStripeField(step: FlowStep): StripeFieldKey | null {
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

async function fillStripeViaFrames(
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientOtpError(reason: string): boolean {
  return /(timeout|timed out|temporary|try again|rate.?limit|429|5\d\d|network|econn|eai_|enotfound|unavailable)/i.test(
    reason,
  );
}

function fetchOtpFromProviderOnce(): OtpFetchAttempt {
  const provider = (process.env.FLOW_OTP_PROVIDER ?? "gmail").trim().toLowerCase();
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
    env: process.env,
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
  const direct = (process.env.FLOW_OTP_CODE ?? "").trim();
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

async function applyWithFallback(
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

async function resolveTypeValue(step: FlowStep): Promise<string> {
  const stripeField = detectStripeField(step);
  if (stripeField) {
    return resolveStripeValue(stripeField);
  }
  const valueRef = step.value_ref ?? "";
  const paramKey = extractParamKey(valueRef);
  const inputMap = parseEnvJsonMap("FLOW_INPUT_JSON");
  const secretMap = parseEnvJsonMap("FLOW_SECRET_INPUT_JSON");
  if (isOtpStep(step)) {
    return await resolveOtpValue();
  }
  if (valueRef.includes("secrets")) {
    if (paramKey && secretMap[paramKey]) {
      return secretMap[paramKey]!;
    }
    return resolveRequiredSecretValue(paramKey);
  }
  if (paramKey && inputMap[paramKey]) {
    return inputMap[paramKey]!;
  }
  return process.env.FLOW_INPUT ?? `demo-${Date.now()}`;
}

export async function runStep(
  page: Page,
  step: FlowStep,
  protectedProviderDomains: string[],
): Promise<ReplayStepResult> {
  const started = Date.now();
  const providerDomain = resolveProviderDomainForStep(step, page.url(), protectedProviderDomains);

  if ((step.gate_policy ?? "").trim().toLowerCase() === "force_manual") {
    const reasonCode = step.gate_reason ?? "manual_gate_required_by_policy";
    return {
      step_id: step.step_id,
      action: step.action,
      ok: false,
      detail: `manual gate required by policy (${reasonCode})`,
      manual_gate_required: true,
      provider_domain: providerDomain,
      gate_required_by_policy: true,
      matched_selector: null,
      selector_index: null,
      duration_ms: Date.now() - started,
      screenshot_before_path: null,
      screenshot_after_path: null,
      fallback_trail: [],
    };
  }

  if (step.action === "manual_gate") {
    if (isOtpStep(step) && (step.target?.selectors?.length ?? 0) > 0) {
      const value = await resolveTypeValue(step);
      const fillResult = await applyWithFallback(page, step, async (selector) => {
        await page.locator(selector).first().fill(value, { timeout: 10_000 });
      });
      return {
        step_id: step.step_id,
        action: "type",
        ok: fillResult.ok,
        detail: fillResult.ok ? `filled OTP ${fillResult.matched_selector}` : fillResult.detail,
        provider_domain: providerDomain,
        gate_required_by_policy: false,
        matched_selector: fillResult.matched_selector,
        selector_index: fillResult.selector_index,
        duration_ms: Date.now() - started,
        screenshot_before_path: null,
        screenshot_after_path: null,
        fallback_trail: fillResult.fallback_trail,
      };
    }
    return {
      step_id: step.step_id,
      action: step.action,
      ok: false,
      detail: "manual gate required by flow step",
      manual_gate_required: true,
      provider_domain: providerDomain,
      gate_required_by_policy: false,
      matched_selector: null,
      selector_index: null,
      duration_ms: Date.now() - started,
      screenshot_before_path: null,
      screenshot_after_path: null,
      fallback_trail: [],
    };
  }

  if (step.action === "navigate") {
    const targetUrl = step.url ?? "";
    if (!targetUrl) {
      return {
        step_id: step.step_id,
        action: step.action,
        ok: false,
        detail: "missing url",
        provider_domain: providerDomain,
        gate_required_by_policy: false,
        matched_selector: null,
        selector_index: null,
        duration_ms: Date.now() - started,
        screenshot_before_path: null,
        screenshot_after_path: null,
        fallback_trail: [],
      };
    }
    await page.goto(targetUrl, { waitUntil: "networkidle" });
    return {
      step_id: step.step_id,
      action: step.action,
      ok: true,
      detail: `navigated to ${targetUrl}`,
      provider_domain: resolveProviderDomainForStep(
        { ...step, url: targetUrl },
        targetUrl,
        protectedProviderDomains,
      ),
      gate_required_by_policy: false,
      matched_selector: null,
      selector_index: null,
      duration_ms: Date.now() - started,
      screenshot_before_path: null,
      screenshot_after_path: null,
      fallback_trail: [],
    };
  }

  if (step.action === "click") {
    const clickResult = await applyWithFallback(page, step, async (selector) => {
      await page.locator(selector).first().click({ timeout: 10_000 });
    });
    return {
      step_id: step.step_id,
      action: step.action,
      ok: clickResult.ok,
      detail: clickResult.ok ? `clicked ${clickResult.matched_selector}` : clickResult.detail,
      provider_domain: providerDomain,
      gate_required_by_policy: false,
      matched_selector: clickResult.matched_selector,
      selector_index: clickResult.selector_index,
      duration_ms: Date.now() - started,
      screenshot_before_path: null,
      screenshot_after_path: null,
      fallback_trail: clickResult.fallback_trail,
    };
  }

  if (step.action === "type") {
    const value = await resolveTypeValue(step);
    const fillResult = await applyWithFallback(page, step, async (selector) => {
      await page.locator(selector).first().fill(value, { timeout: 10_000 });
    });
    let detail = fillResult.ok ? `filled ${fillResult.matched_selector}` : fillResult.detail;
    let matchedSelector = fillResult.matched_selector;
    let selectorIndex = fillResult.selector_index;
    let fallbackTrail = fillResult.fallback_trail;
    if (!fillResult.ok) {
      const stripeField = detectStripeField(step);
      if (stripeField) {
        const stripeFallback = await fillStripeViaFrames(page, stripeField, value);
        fallbackTrail = [...fallbackTrail, ...stripeFallback.trail];
        if (stripeFallback.selector) {
          detail = `filled ${stripeFallback.selector}`;
          matchedSelector = stripeFallback.selector;
          selectorIndex = -1;
        } else {
          detail = `${detail}; stripe frame fallback failed`;
        }
      }
    }
    return {
      step_id: step.step_id,
      action: step.action,
      ok: Boolean(matchedSelector),
      detail,
      provider_domain: providerDomain,
      gate_required_by_policy: false,
      matched_selector: matchedSelector,
      selector_index: selectorIndex,
      duration_ms: Date.now() - started,
      screenshot_before_path: null,
      screenshot_after_path: null,
      fallback_trail: fallbackTrail,
    };
  }

  throw new Error(`unsupported action "${step.action}"`);
}
