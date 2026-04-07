import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PROTECTED_PROVIDER_DOMAINS,
  type FlowDraft,
  type FlowStep,
  PROVIDER_PROTECTED_PAYMENT_REASON,
  RUNTIME_ROOT,
} from "./replay-flow-types.js";

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

export async function maybeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch {
    return null;
  }
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

export function extractHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function resolveProviderDomainFromUrl(
  url: string,
  protectedDomains: string[],
): string | null {
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

export function resolveFromStepIndex(flow: FlowDraft): number {
  const fromStepId = (process.env.FLOW_FROM_STEP_ID ?? "").trim();
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
