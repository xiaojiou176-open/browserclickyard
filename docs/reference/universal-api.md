# Universal Platform API

Default server (canonical): `http://127.0.0.1:17380`. API base path: `/api`.

Loopback host policy: contract/docs/examples standardize on `127.0.0.1` to avoid
string drift in env/doc gates. `localhost` may still work locally, but is not the
canonical contract literal.

## Operator Surface Map

The product uses several operator-facing surfaces that are related but not
interchangeable:

- **Stress Lab starts work** through target-first command or template-backed
  entry points.
- **Runs & Blocks tracks work** through run records, command records, logs, and
  manual-gate states.
- **Advanced Review compares governed work** once review-ready evidence exists.
- **Command Tower projects runtime detail** for flow drafts, evidence timelines,
  and replay helpers, but it is not the primary workflow or proof ledger.

Use this map before assuming every endpoint that mentions a run is talking about
the same truth surface.

## Common Headers

- `x-automation-client-id`: client correlation id for audit/replay traceability. When token auth is enabled, requests that carry `x-automation-token` must also include `x-automation-client-id` (otherwise `400`).
- `x-automation-token`: shared secret header for token-protected APIs.

## Generated Web Client Contract

- `tests/web-harness/src/api-gen/core/request.ts` treats empty success bodies as `undefined`.
- Non-empty success responses are parsed as JSON only when `content-type` includes `application/json`; otherwise the generated client returns response text.
- `pnpm contracts:generate` is the only accepted way to refresh `tests/web-harness/src/api-gen/**`.
  If gate runs regenerate those files, the generated client bundle must be committed together with the source-of-truth contract change.
- The March 22, 2026 closure hardening pass re-synced the generated harness client after contract generation.
  This was a generated-surface alignment update, not a semantic API route change.

Current scope note:

- the generated client is real, but it currently emits harness-facing modules
  under `tests/web-harness/src/api-gen/**`
- it is **not** a published SDK package
- it currently covers `health`, `automation`, and `command-tower` modules, not
  the full OpenAPI surface

If you need proof, template, or workflow-run integrations today, call the HTTP
contract directly or mirror the first-party fetch pattern from
`apps/command-center/src/hooks/useApiClient.ts` and
`apps/command-center/src/hooks/useProofApi.ts`.

## Builder Integration Entry

Use this API page together with
[docs/reference/integration-entrypoints.md](./integration-entrypoints.md).

Today the honest builder rule is:

- **OpenAPI + direct HTTP** is the primary public integration path
- **generated harness client** is a repo-internal helper path
- **frontend hooks** are first-party app wiring, not a supported external SDK

That is similar to the difference between:

- a public train line map
- a staff-only operations panel

Both are useful, but they are not the same promise.

## Service & Health

- `GET /`
- `GET /metrics` (Prometheus text)
- `GET /health/`
- `GET /health/metrics` (Prometheus text, same payload as `/metrics`)
- `GET /health/diagnostics`
- `GET /health/alerts`
- `POST /health/rum`

Health payload contracts:

- `GET /health/diagnostics` main fields:
  - `status`, `uptime_seconds`, `storage_backend`, `task_counts`, `task_total`, `metrics`
  - compatibility fields (deprecated): `generated_at`, `diagnostics_index`, `alerts`
- `GET /health/alerts` main fields:
  - `state`, `failure_rate`, `threshold`, `completed`, `failed`
  - compatibility fields (deprecated): `alerts`, `total`

Metrics/observability notes:

- `/metrics` and `/health/metrics` expose minimal RED + automation counters:
  - `uiq_http_requests_total`, `uiq_http_request_errors_total`
  - `uiq_http_request_duration_seconds_*` (histogram buckets/sum/count)
  - `uiq_http_active_requests`
  - tooling/automation/rate-limit/task-store counters and task-status gauges
  - RUM counters (`uiq_rum_samples_total`, `uiq_rum_metric_*`)

RUM ingest:

- Endpoint: `POST /health/rum`
- Body example:

  ```json
  {
    "metric": "LCP",
    "value": 1820.1,
    "rating": "good",
    "path": "/",
    "navigationType": "navigate",
    "timestampMs": 1739999999999
  }
  ```

- Accepted metrics include browser web-vitals (`LCP`, `CLS`, `INP`, `FCP`, `TTFB`).
- Server persists aggregate summary for gate consumption at `.runtime-cache/metrics/rum-summary.json`.

## Register Bootstrap

- `GET /api/csrf`
- `POST /api/register`

Route `/register` exists but is excluded from API schema (`include_in_schema=false`) and only redirects to frontend register page.

## Automation Command Lane

- `GET /api/automation/commands`
- `GET /api/automation/tasks`
- `GET /api/automation/tasks/{task_id}`
- `POST /api/automation/run`
- `POST /api/automation/tasks/{task_id}/cancel`

Automation lane semantics:

- `POST /api/automation/run` queues an allowlisted automation command and
  returns an `AutomationTask` snapshot.
- This is the **automation command lane**, not the workflow `/api/runs` lane.
- Some command ids in this lane intentionally wrap the script pipeline
  (`./scripts/run-pipeline.sh`).
- Current script-pipeline command ids use the `script-pipeline-*` family, for
  example `script-pipeline-capture`, `script-pipeline-capture-midscene`,
  `script-pipeline-full`, and `script-pipeline-full-midscene`.
- This lane does **not** define the governed proof contract of `pnpm uiq run`.

## Computer Use

- `POST /api/computer-use/sessions`
- `POST /api/computer-use/sessions/{session_id}/preview`
- `POST /api/computer-use/sessions/{session_id}/confirm/{action_id}`
- `POST /api/computer-use/sessions/{session_id}/execute/{action_id}`
- `GET /api/computer-use/sessions/{session_id}/evidence`

Computer Use ownership and execution guarantees:

- Session/action/evidence endpoints enforce owner checks. Cross-actor access returns `403`.
- `POST /api/computer-use/sessions/{session_id}/execute/{action_id}` is mutex + idempotent per action. Concurrent duplicate execute calls do not re-run the underlying Playwright action; repeated calls return the same execution snapshot.

## Embeddings

- `POST /api/embeddings/batch`

## Sessions

- `GET /api/sessions`
- `POST /api/sessions/start`
- `POST /api/sessions/{session_id}/finish`

## Computer Use (Session APIs Mirror)

- `POST /api/computer-use/sessions`
- `POST /api/computer-use/sessions/{session_id}/preview`
- `POST /api/computer-use/sessions/{session_id}/confirm/{action_id}`
- `POST /api/computer-use/sessions/{session_id}/execute/{action_id}`
- `GET /api/computer-use/sessions/{session_id}/evidence`

## Flows

- `GET /api/flows`
- `POST /api/flows/import-latest`
- `POST /api/flows`
- `GET /api/flows/{flow_id}`
- `PATCH /api/flows/{flow_id}`

## Templates

- `GET /api/templates`
- `POST /api/templates`
- `POST /api/templates/from-artifacts`
- `POST /api/templates/promote`
- `GET /api/templates/{template_id}`
- `PATCH /api/templates/{template_id}`
- `GET /api/templates/{template_id}/export`
- `GET /api/templates/{template_id}/history`
- `POST /api/templates/{template_id}/fork-version`
- `POST /api/templates/{template_id}/mark-recommended`

Template lifecycle notes:

- `POST /api/templates/promote` creates a versioned template asset from a flow
  or an existing run context.
- `GET /api/templates/{template_id}/history` lists all versions in one template
  family.
- `POST /api/templates/{template_id}/fork-version` creates a new version in the
  same family.
- `POST /api/templates/{template_id}/mark-recommended` switches the family's
  recommended version.
- `PATCH /api/templates/{template_id}` still exists for compatibility and
  shallow edits, but it is no longer the preferred path for structural version
  upgrades.

## Workflow Run Lane

- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/{run_id}`
- `POST /api/runs/{run_id}/otp`
- `POST /api/runs/{run_id}/resume`
- `POST /api/runs/{run_id}/cancel`

Workflow lane semantics:

- `/api/runs` manages operator-facing workflow runs created from saved
  templates and parameters.
- A workflow run is stored in the universal workflow ledger, then bridged to an
  underlying `AutomationTask` when execution is required.
- `/api/runs` is therefore related to `/api/automation/run`, but it is not the
  same lane and should not be documented as equivalent.
- Use the governed `pnpm uiq run --profile ... --target ...` lane when you need
  manifest/summary/evidence-index bundle semantics.

Run status model in current backend implementation:

- `queued|running|waiting_user|waiting_otp|success|failed|cancelled`
- `waiting_otp`: run paused for OTP/3DS input.
- `waiting_user`: run paused by manual gate (including protected payment provider flows and protection challenges that require user intervention).

Compatibility note:

- `blocked` remains in OpenAPI enum for downstream compatibility but is currently not emitted by backend run records.
- `artifacts_ref` may appear in current response models and frontend types, but
  it should be treated as a run artifact pointer surface rather than the primary
  workflow truth source.
- `RunCreateRequest.session_id` is accepted for contract compatibility but is
  not the current authoritative selector for run execution in backend behavior.

Truth-source note:

- `Run` is not the execution engine itself.
- The current backend creates an `AutomationTask` to perform the underlying
  replay/execution work, then synchronizes `Run.status`, `wait_context`, and
  progress from task state and runtime output parsing.
- For operator debugging, `command-tower` endpoints and reconstruction outputs
  should be read as runtime projections, not as the primary run ledger.
- A practical rule of thumb:
  - use `Stress Lab` or `/api/runs` to start work,
  - use `Runs & Blocks` or `/api/runs` + `/api/automation/*` to track work,
  - use `Advanced Review` or `/api/proof/*` when you need governed evidence for
    a deeper comparison,
  - use `command-tower` only when you need draft/replay/runtime projection data.

`RunOtpSubmitRequest.otp_code` is optional in v2 contract:

- For `waiting_otp`, provide `otp_code`.
- For `waiting_user`, `otp_code` may be omitted when the gate does not require OTP-form input.

## Manual Gate For Protected Payment Providers

This section documents the v2 manual-gate flow for protected payment providers.

Trigger conditions:

- Payment provider introduces protected challenge steps (for example 3DS or similar out-of-band verification).
- Runtime/reconstruction detects protection signals and pauses run for human intervention.
- Run enters `waiting_user` when a manual gate is required beyond normal OTP polling.

`wait_context` fields on `Run`:

- `reason_code`: machine-readable reason of the wait state (for example `provider_protected_payment_step`).
- `at_step_id`: step id where pause is detected.
- `after_step_id`: last completed step id before pause.
- `resume_from_step_id`: explicit resume anchor step id.
- `resume_hint`: human-readable operator hint.
- `provider_domain`: optional provider hint (for example `stripe.com`).
- `gate_required_by_policy`: whether pause is enforced by explicit gate policy.

Canonical continue execution flow:

1. Poll `GET /api/runs/{run_id}` until status becomes `waiting_otp` or `waiting_user`.
2. Inspect `wait_context` for pause reason and resume anchor (`resume_from_step_id`).
3. Call `POST /api/runs/{run_id}/resume`:
   - `waiting_otp` example: `{"kind":"otp","otp_code":"123456"}`.
   - `waiting_user` example for manual approval: `{"kind":"approval","approved":true}`.
   - `waiting_user` example for supplemental input: `{"kind":"input","input_text":"continue"}`.
4. Continue polling `GET /api/runs/{run_id}` until terminal status (`success|failed|cancelled`).

Compatibility note:

- `POST /api/runs/{run_id}/otp` remains as a compatibility wrapper for legacy
  clients, but first-party callers should move to `/resume`.

## Proof And Review

- `GET /api/proof/campaigns`
- `POST /api/proof/campaigns`
- `GET /api/proof/campaigns/{campaign_id}`
- `POST /api/proof/campaigns/{campaign_id}/diff`
- `POST /api/proof/runs/compare`
- `GET /api/proof/runs/{run_id}/ai-review`
- `GET /api/proof/runs/{run_id}/release-brief`
- `GET /api/proof/runs/{run_id}/similar-failures?limit=<n>`
- `GET /api/proof/templates/{template_id}/feasibility?target=<target>`

Proof/review semantics:

- Proof campaigns are operator-facing decision bundles built from one or more
  existing governed runs.
- `POST /api/proof/runs/compare` compares two run bundles and returns gate,
  metric, and failed-check deltas.
- `GET /api/proof/runs/{run_id}/ai-review` returns the operator-facing AI
  review projection for one run, rather than forcing clients to parse raw
  artifact files.
- `GET /api/proof/runs/{run_id}/release-brief` summarizes one run into an
  operator-facing brief with recommendation, observed failed checks, AI finding
  counts, and the next suggested decision step.
- `GET /api/proof/runs/{run_id}/similar-failures` ranks governed historical
  failure cases for one run and returns why each candidate matched.
- `GET /api/proof/templates/{template_id}/feasibility` answers whether a
  template is realistically supportable on a given target based on current
  driver capabilities.

Builder note:

- these proof endpoints are part of the real HTTP surface today
- they are not yet generated into the current harness client bundle
- if you need them from outside the first-party app, use the OpenAPI contract
  and direct HTTP

## Integrations

- `GET /api/integrations/vonage/inbound-sms`
- `POST /api/integrations/vonage/inbound-sms`

Vonage inbound auth notes:

- Preferred auth gate: header `x-vonage-inbound-token: <VONAGE_INBOUND_TOKEN>`.
- Legacy fallback headers `x-vonage-token` and `x-inbound-token` are accepted only when `VONAGE_INBOUND_TOKEN_HEADER_ENABLED=true`.
- Query token fallback `?token=...` is no longer supported (always rejected with `401`).
- Signature verify env: `VONAGE_SIGNATURE_SECRET`, `VONAGE_SIGNATURE_ALGO` (current implementation only accepts `sha256`).
- Duplicate `messageId` callbacks are idempotently accepted and marked as `duplicate=true`.

## Profiles & Reconstruction

- `POST /api/profiles/resolve`
- `POST /api/reconstruction/preview`
- `POST /api/reconstruction/generate`

## Embeddings (Profiles & Reconstruction Mirror)

- `POST /api/embeddings/batch`

## Command Tower

- `GET /api/command-tower/overview`
- `GET /api/command-tower/latest-flow`
- `GET /api/command-tower/latest-flow-draft`
- `PATCH /api/command-tower/latest-flow-draft`
- `POST /api/command-tower/replay-latest`
- `POST /api/command-tower/replay-latest-from-step`
- `POST /api/command-tower/replay-latest-step`
- `POST /api/command-tower/orchestrate-from-artifacts`
- `GET /api/command-tower/evidence`
- `GET /api/command-tower/evidence-timeline`

Command-tower query semantics:

- `session_id` is optional on `latest-flow*`, `replay*`, and `evidence-timeline`.
- `step_id` is required on `/api/command-tower/evidence`.
- Omit `session_id` to resolve to latest owned session.
- Empty `session_id` returns `422`.
- Unknown/unowned session or missing session directory returns `404`.
