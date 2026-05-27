from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse


def default_generator_outputs(generated_dir: Path, preview_id: str) -> dict[str, str]:
    target_dir = generated_dir / preview_id
    return {
        "flow_draft": str(target_dir / "flow-draft.json"),
        "playwright_spec": str(target_dir / "generated-playwright.spec.ts"),
        "api_spec": str(target_dir / "generated-api.spec.ts"),
        "readiness_report": str(target_dir / "run-readiness-report.json"),
    }


def persist_preview(preview_dir: Path, preview_id: str, preview_payload: dict[str, Any]) -> None:
    preview_dir.mkdir(parents=True, exist_ok=True)
    target = preview_dir / f"{preview_id}.json"
    target.write_text(json.dumps(preview_payload, ensure_ascii=False, indent=2), encoding="utf-8")


def materialize_generated_outputs(
    generated_dir: Path,
    preview_id: str,
    flow_draft: dict[str, Any],
    *,
    build_manual_gate_report: Callable[
        [list[dict[str, Any]]], tuple[list[str], dict[str, Any], dict[str, Any]]
    ],
    compute_replay_sla: Callable[[datetime, Path], dict[str, Any]],
) -> dict[str, str]:
    output_paths = default_generator_outputs(generated_dir, preview_id)
    target_dir = generated_dir / preview_id
    target_dir.mkdir(parents=True, exist_ok=True)

    flow_path = Path(output_paths["flow_draft"])
    flow_path.write_text(json.dumps(flow_draft, ensure_ascii=False, indent=2), encoding="utf-8")

    playwright_path = Path(output_paths["playwright_spec"])
    playwright_path.write_text(build_generated_playwright(flow_draft), encoding="utf-8")

    api_path = Path(output_paths["api_spec"])
    api_path.write_text(build_generated_api(flow_draft), encoding="utf-8")

    readiness_path = Path(output_paths["readiness_report"])
    now = datetime.now(UTC)
    steps = flow_draft.get("steps")
    normalized_steps = steps if isinstance(steps, list) else []
    manual_gate_reasons, manual_gate_reason_matrix, manual_gate_stats_panel = (
        build_manual_gate_report(normalized_steps)
    )
    replay_attempt = {
        "attempted": False,
        "success": None,
        "status": "not_attempted",
    }
    replay_sla = compute_replay_sla(now, readiness_path)
    bootstrap_steps = flow_draft.get("bootstrap_sequence", [])
    action_endpoint = flow_draft.get("action_endpoint")
    readiness_path.write_text(
        json.dumps(
            {
                "generated_at": now.isoformat(),
                "preview_id": preview_id,
                "flow_id": flow_draft.get("flow_id"),
                "step_count": len(normalized_steps),
                "ready": True,
                "api_replay_ready": isinstance(action_endpoint, dict)
                and bool(action_endpoint.get("path")),
                "required_bootstrap_steps": len(bootstrap_steps)
                if isinstance(bootstrap_steps, list)
                else 0,
                "replay_attempt": replay_attempt,
                "replay_success_rate_7d": replay_sla["replay_success_rate_7d"],
                "replay_success_samples_7d": replay_sla["replay_success_samples_7d"],
                "replay_sla": replay_sla,
                "manual_gate_reasons": manual_gate_reasons,
                "manual_gate_reason_matrix": manual_gate_reason_matrix,
                "manual_gate_stats_panel": manual_gate_stats_panel,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return output_paths


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
  // env-waiver: process_env_template reason=generated_template_env scope=generated-template
  input: process.env.RECON_PARAM_INPUT ?? 'demo-input',
};
const secrets: Record<string, string> = {
  // env-waiver: process_env_template reason=generated_template_env scope=generated-template
  password: process.env.RECON_SECRET_PASSWORD ?? '',
  // env-waiver: process_env_template reason=generated_template_env scope=generated-template
  input: process.env.RECON_SECRET_INPUT ?? '',
};

function resolveValue(reference: string | null | undefined): string {
  if (!reference) return '';
  const normalized = reference.trim();
  const match = normalized.match(/^\\$\\{(params|secrets)\\.([^}]+)\\}$/);
  if (!match) return normalized;
  const [, scope, key] = match;
  if (scope === 'params') return params[key] ?? '';
  const secret = secrets[key] ?? '';
  if (!secret) throw new Error(`missing required secret: ${key}`);
  return secret;
}

function buildLocator(page: Page, selector: SelectorCandidate): Locator {
  switch (selector.kind) {
    case 'role': {
      const rolePattern = selector.value.match(/^([a-zA-Z0-9_-]+)(?:\\[name=['\"](.+)['\"]\\])?$/);
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
      return page.locator(`[name="${selector.value.replace(/"/g, '\\\\"')}"]`);
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
        if isinstance(raw_index, int):
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
    return pathOrFull;
  }}
  return `${{BASE_ORIGIN}}${{pathOrFull}}`;
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

  // env-waiver: process_env_template reason=generated_template_env scope=generated-template
  const password = (process.env.RECON_SECRET_PASSWORD ?? '').trim();
  if (!password) {{
    throw new Error('Missing required secret: RECON_SECRET_PASSWORD');
  }}
  const payload: Record<string, unknown> = {{
    email: `generated+${{Date.now()}}@example.com`,
    password,
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
