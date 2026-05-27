from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

from app.services.engine_adapters import GeminiAdapter
from app.services.engine_adapters.gemini_adapter import GeminiExtractionInput

from .types import ResolvedArtifacts


def _int_or_default(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _bounded_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 0.0
    return max(0.0, min(1.0, numeric))


def pick_action_endpoint(har_entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not har_entries:
        return None
    latest_host: str | None = None
    for entry in reversed(har_entries):
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        latest_host = parsed.netloc
        break
    best: dict[str, Any] | None = None
    best_score = float("-inf")
    for entry in har_entries:
        method = str(entry.get("method") or "").upper()
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        path = parsed.path.lower()
        status = _int_or_default(entry.get("status"), 0)
        score = 0
        if method in {"POST", "PUT", "PATCH", "DELETE"}:
            score += 60
        elif method == "GET":
            score += 5
        if latest_host and parsed.netloc == latest_host:
            score += 8
        if status in {0, 200, 201, 202, 204, 302, 303}:
            score += 10
        if re.search(r"register|signup|sign-up|create|submit|auth|account|user|graphql", path):
            score += 10
        if re.search(r"\.(png|jpg|jpeg|css|js|svg|woff2?)$", path):
            score -= 40
        if score > best_score:
            best_score = score
            best = {
                "method": method or "POST",
                "fullUrl": url,
                "path": parsed.path or "/",
                "contentType": entry.get("content_type"),
            }
    return best


def derive_bootstrap_sequence(
    har_entries: list[dict[str, Any]],
    action_endpoint: dict[str, Any] | None,
) -> list[dict[str, str]]:
    if not action_endpoint:
        return []
    action_url = str(action_endpoint.get("fullUrl") or "")
    action_method = str(action_endpoint.get("method") or "").upper()
    if not action_url:
        return []
    action_path = str(action_endpoint.get("path") or "")
    action_host = urlparse(action_url).netloc
    sequence: list[dict[str, str]] = []
    for entry in har_entries:
        url = str(entry.get("url") or "")
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.netloc != action_host:
            continue
        path = parsed.path
        method = str(entry.get("method") or "").upper()
        if path == action_path and method == action_method:
            continue
        reason = "context-bootstrap"
        if re.search(r"csrf|xsrf|token", path, flags=re.IGNORECASE):
            reason = "token-bootstrap"
        elif re.search(r"captcha|challenge|turnstile|verify|otp|mfa", path, flags=re.IGNORECASE):
            reason = "protection-bootstrap"
        elif method != "GET":
            continue
        sequence.append(
            {
                "method": method or "GET",
                "fullUrl": url,
                "path": path or "/",
                "reason": reason,
            }
        )
    return sequence[-3:]


def extract_steps(
    artifacts: ResolvedArtifacts,
    strategy: str,
    gemini: GeminiAdapter,
) -> list[dict[str, Any]]:
    return gemini.extract_steps(
        GeminiExtractionInput(
            start_url=artifacts.start_url,
            har_entries=artifacts.har_entries,
            html_content=artifacts.html_content,
            extractor_strategy=strategy,
        )
    )


def normalize_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for idx, step in enumerate(steps, start=1):
        normalized.append(
            {
                "step_id": str(step.get("step_id") or f"s{idx}"),
                "action": str(step.get("action") or "manual_gate"),
                "url": step.get("url"),
                "value_ref": step.get("value_ref"),
                "target": step.get("target") or {"selectors": []},
                "selected_selector_index": step.get("selected_selector_index"),
                "preconditions": step.get("preconditions") or [],
                "evidence_ref": step.get("evidence_ref"),
                "confidence": _bounded_confidence(step.get("confidence", 0.0)),
                "source_engine": str(step.get("source_engine") or "gemini"),
                "manual_handoff_required": bool(step.get("manual_handoff_required", False)),
                "unsupported_reason": step.get("unsupported_reason"),
            }
        )
    return normalized


def calculate_quality(steps: list[dict[str, Any]]) -> int:
    if not steps:
        return 0
    avg = sum(float(step.get("confidence", 0.0)) for step in steps) / len(steps)
    return int(round(avg * 100))


def normalize_codegen_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list):
        return []
    normalized: list[dict[str, Any]] = []
    for index, raw_step in enumerate(raw_steps, start=1):
        if not isinstance(raw_step, dict):
            continue
        step_id = str(raw_step.get("step_id") or f"s{index}")
        action = str(raw_step.get("action") or "manual_gate")
        selectors: list[dict[str, str]] = []
        target = raw_step.get("target")
        if isinstance(target, dict):
            raw_selectors = target.get("selectors")
            if isinstance(raw_selectors, list):
                for candidate in raw_selectors:
                    if not isinstance(candidate, dict):
                        continue
                    kind = str(candidate.get("kind") or "").strip().lower()
                    value = str(candidate.get("value") or "").strip()
                    if kind and value:
                        selectors.append({"kind": kind, "value": value})
        selected_selector_index: int | None = None
        raw_index = raw_step.get("selected_selector_index")
        if isinstance(raw_index, int) and 0 <= raw_index < len(selectors):
            selected_selector_index = raw_index
        preconditions = raw_step.get("preconditions")
        normalized_preconditions = (
            [str(item) for item in preconditions] if isinstance(preconditions, list) else []
        )
        normalized.append(
            {
                "step_id": step_id,
                "action": action,
                "url": raw_step.get("url"),
                "value_ref": raw_step.get("value_ref"),
                "selectors": selectors,
                "selected_selector_index": selected_selector_index,
                "preconditions": normalized_preconditions,
                "unsupported_reason": raw_step.get("unsupported_reason"),
            }
        )
    return normalized


def build_generated_playwright(flow_draft: dict[str, Any]) -> str:
    start_url = str(flow_draft.get("start_url") or "https://example.com")
    generated_steps = normalize_codegen_steps(flow_draft.get("steps"))
    start_url_literal = json.dumps(start_url, ensure_ascii=False)
    steps_literal = json.dumps(generated_steps, ensure_ascii=False, indent=2)
    template = """import { test, expect, type Locator, type Page } from '@playwright/test';

type SelectorCandidate = { kind: string; value: string };
type GeneratedFlowStep = {
  step_id: string;
  action: string;
  url?: string | null;
  value_ref?: string | null;
  selectors: SelectorCandidate[];
  selected_selector_index?: number | null;
  preconditions: string[];
  unsupported_reason?: string | null;
};

const START_URL: string = __START_URL__;
const FLOW_STEPS: GeneratedFlowStep[] = __FLOW_STEPS__;

const params: Record<string, string> = {
  email: `generated+${Date.now()}@example.com`,
  input: process.env.RECON_PARAM_INPUT ?? 'demo-input',
};

function readRequiredEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value) return value;
  throw new Error(`missing required env: ${name}`);
}

function resolveSecretValue(key: string): string {
  if (key === 'password') {
    return readRequiredEnv('RECON_SECRET_PASSWORD');
  }
  if (key === 'input') {
    return readRequiredEnv('RECON_SECRET_INPUT');
  }
  return readRequiredEnv(`RECON_SECRET_${key.toUpperCase()}`);
}

function resolveValue(reference: string | null | undefined): string {
  if (!reference) return '';
  const normalized = reference.trim();
  const match = normalized.match(/^\\$\\{(params|secrets)\\.([^}]+)\\}$/);
  if (!match) return normalized;
  const [, scope, key] = match;
  if (scope === 'params') return params[key] ?? '';
  return resolveSecretValue(key);
}

function buildLocator(page: Page, selector: SelectorCandidate): Locator {
  switch (selector.kind) {
    case 'role': {
      const rolePattern = selector.value.match(/^([a-zA-Z0-9_-]+)(?:\\[name=['"](.+)['"]\\])?$/);
      if (rolePattern) {
        const [, role, name] = rolePattern;
        if (name) {
          return page.getByRole(role as Parameters<Page['getByRole']>[0], { name });
        }
        return page.getByRole(role as Parameters<Page['getByRole']>[0]);
      }
      return page.getByRole('button', { name: selector.value });
    }
    case 'text':
      return page.getByText(selector.value);
    case 'testid':
      return page.getByTestId(selector.value);
    case 'id':
      return page.locator(selector.value.startsWith('#') ? selector.value : `#${selector.value}`);
    case 'name':
      return page.locator(`[name="${selector.value.replace(/"/g, '\\\"')}"]`);
    case 'xpath':
      return page.locator(`xpath=${selector.value}`);
    case 'css':
      return page.locator(selector.value);
    default:
      return page.locator(selector.value);
  }
}

async function resolveLocator(page: Page, step: GeneratedFlowStep): Promise<Locator | null> {
  const selectors = Array.isArray(step.selectors) ? step.selectors : [];
  if (selectors.length === 0) return null;
  const preferred =
    typeof step.selected_selector_index === 'number' && step.selected_selector_index >= 0
      ? step.selected_selector_index
      : null;
  const ordered = preferred === null ? selectors : [selectors[preferred], ...selectors.filter((_, i) => i !== preferred)];
  for (const candidate of ordered) {
    const locator = buildLocator(page, candidate).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

async function executeStep(page: Page, step: GeneratedFlowStep): Promise<void> {
  if (step.action === 'manual_gate') {
    throw new Error(step.unsupported_reason || `manual gate at ${step.step_id}`);
  }
  if (step.action === 'navigate') {
    await page.goto(step.url || START_URL);
    return;
  }
  const locator = await resolveLocator(page, step);
  switch (step.action) {
    case 'click':
      if (!locator) throw new Error(`selector not found for click step ${step.step_id}`);
      await locator.click();
      return;
    case 'type': {
      if (!locator) throw new Error(`selector not found for type step ${step.step_id}`);
      await locator.fill(resolveValue(step.value_ref));
      return;
    }
    case 'select': {
      if (!locator) throw new Error(`selector not found for select step ${step.step_id}`);
      await locator.selectOption(resolveValue(step.value_ref));
      return;
    }
    case 'wait_for':
      if (locator) {
        await expect(locator).toBeVisible();
      } else {
        await page.waitForLoadState('domcontentloaded');
      }
      return;
    case 'assert':
      if (locator) {
        await expect(locator).toBeVisible();
      } else {
        throw new Error(`selector not found for assert step ${step.step_id}`);
      }
      return;
    case 'extract':
      if (!locator) throw new Error(`selector not found for extract step ${step.step_id}`);
      await locator.textContent();
      return;
    case 'branch':
      return;
    default:
      throw new Error(`unsupported action "${step.action}" at ${step.step_id}`);
  }
}

test('generated reconstruction flow', async ({ page }) => {
  if (!FLOW_STEPS.some((step) => step.action === 'navigate')) {
    await page.goto(START_URL);
  }
  for (const step of FLOW_STEPS) {
    await test.step(`${step.step_id}:${step.action}`, async () => {
      await executeStep(page, step);
    });
  }
});
"""
    return template.replace("__START_URL__", start_url_literal).replace(
        "__FLOW_STEPS__", steps_literal
    )


def build_generated_api(flow_draft: dict[str, Any]) -> str:
    start_url = str(flow_draft.get("start_url") or "https://example.com")
    parsed = urlparse(start_url)
    base_origin = (
        f"{parsed.scheme}://{parsed.netloc}"
        if parsed.scheme and parsed.netloc
        else "https://example.com"
    )
    action_endpoint = flow_draft.get("action_endpoint")
    if not isinstance(action_endpoint, dict):
        action_endpoint = {
            "method": "POST",
            "fullUrl": f"{base_origin}/api/register",
            "path": "/api/register",
            "contentType": "application/json",
        }
    bootstrap_sequence = (
        flow_draft.get("bootstrap_sequence")
        if isinstance(flow_draft.get("bootstrap_sequence"), list)
        else []
    )
    endpoint_literal = json.dumps(action_endpoint, ensure_ascii=False, indent=2)
    bootstrap_literal = json.dumps(bootstrap_sequence, ensure_ascii=False, indent=2)
    base_literal = json.dumps(base_origin, ensure_ascii=False)
    return f"""import {{ test, expect }} from '@playwright/test';

type EndpointSpec = {{
  method: string
  fullUrl: string
  path: string
  contentType: string | null
}}

type BootstrapStep = {{
  method: string
  fullUrl: string
  path: string
  reason: string
}}

const BASE_ORIGIN = {base_literal};
const ACTION_ENDPOINT: EndpointSpec = {endpoint_literal};
const BOOTSTRAP_SEQUENCE: BootstrapStep[] = {bootstrap_literal};

function buildUrl(pathOrFull: string): string {{
  if (pathOrFull.startsWith('http://') || pathOrFull.startsWith('https://')) {{
    const parsed = new URL(pathOrFull);
    const base = new URL(BASE_ORIGIN);
    if (parsed.origin !== base.origin) {{
      throw new Error(`cross-origin replay endpoint is not allowed: ${{parsed.origin}}`);
    }}
    return parsed.toString();
  }}
  return `${{BASE_ORIGIN}}${{pathOrFull}}`;
}}

function readRequiredEnv(name: string): string {{
  const value = (process.env[name] ?? '').trim();
  if (value) return value;
  throw new Error(`missing required env: ${{name}}`);
}}

test('generated reconstruction api replay', async ({{ request }}) => {{
  let csrfToken: string | null = null;
  for (const step of BOOTSTRAP_SEQUENCE) {{
    const response = await request.fetch(buildUrl(step.fullUrl || step.path), {{
      method: step.method || 'GET',
    }});
    expect(response.status()).toBeLessThan(500);
    const contentType = response.headers()['content-type'] ?? '';
    if (contentType.includes('application/json')) {{
      const body = (await response.json()) as Record<string, unknown>;
      const token = body.csrf_token ?? body.token;
      if (typeof token === 'string' && token.trim()) {{
        csrfToken = token;
      }}
    }}
  }}

  const payload: Record<string, unknown> = {{
    email: `generated+${{Date.now()}}@example.com`,
    password: readRequiredEnv('RECON_SECRET_PASSWORD'),
  }};
  const headers: Record<string, string> = {{
    'content-type': ACTION_ENDPOINT.contentType ?? 'application/json',
  }};
  if (csrfToken) {{
    headers['x-csrf-token'] = csrfToken;
  }}

  const response = await request.fetch(buildUrl(ACTION_ENDPOINT.fullUrl || ACTION_ENDPOINT.path), {{
    method: (ACTION_ENDPOINT.method || 'POST').toUpperCase(),
    headers,
    data: payload,
  }});
  expect(response.status()).toBeLessThan(500);
  expect([200, 201, 202, 204]).toContain(response.status());
}});
"""
