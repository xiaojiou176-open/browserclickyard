# Architecture (Canonical SSOT)

This document is the only canonical contract source for architecture-level
behavior.

## SSOT Boundary Contract

- Contract definitions must be authored only in `docs/architecture.md`.
- `docs/reference/dependency-governance.md` is an operational reference and may
  not redefine architectural contracts.

## Canonical Boundaries

- `README.md` is the public front door.
- `docs/index.md` is the documentation router.
- `docs/ai/agent-guide.md` defines execution rules.
- `docs/architecture.md` defines architecture contracts.
- Generated docs under `docs/reference/` remain valid only when they are in sync
  with their source governance configs and render checks.

## System Contract

- Contract-first: `contracts/openapi/api.yaml` is the API source of truth.
- Contract generation: `pnpm contracts:generate` emits typed fetch wrappers and
  MSW handlers.
- Current generated-client scope:
  `contracts/scripts/generate-client.ts` writes into
  `tests/web-harness/src/api-gen/**`, which is a harness/test integration
  surface rather than a published builder SDK package.
- Frontend entry: `apps/command-center/` is the product UI command center
  runtime/build/test entry.
- Frontend root contract: repo-level runners that boot the command center from
  the repository root must still resolve Vite `root` to
  `apps/command-center/` so `/` serves the product frontend instead of the repo
  root directory.
- Command-center first-use shell contract: the above-the-fold onboarding path is
  intentionally launch-first. Operators should configure the target in
  `Stress Lab`, choose one lab mode, launch the run, then move into
  `Runs & Blocks` to read the result before branching into `Flow Studio` or
  `Advanced Review`.
- Restart-onboarding contract: global restart actions must switch the active
  command-center view back to `launch` before replaying the first-use tour, so
  launch-only tour steps keep real anchors instead of falling back to a centered
  dialog on `tasks`, `workshop`, or `review`.
- `tests/web-harness` positioning: UIQ web harness for orchestrator-driven unit/ct/e2e
  and CI shared runtime, not the primary product frontend.
- Component-test runtime contract: `tests/web-harness/tests/ct` uses
  `@playwright/test` with Playwright CT core fixtures/register wiring, while
  `tests/frontend-e2e` remains the product-frontend E2E surface.
- Orchestrator-first governed pagestress: `pnpm uiq <command>` composes
  profile + target and writes one evidence bundle per run.
- Manifest-first: every run writes
  `.runtime-cache/artifacts/runs/<runId>/manifest.json`.
- Manifest schema contract:
  `packages/core/src/manifest/manifest.schema.json` (`v1.1`).
- Profile/target schema contract:
  `configs/schemas/profile.v1.schema.json` and
  `configs/schemas/target.v1.schema.json`.
- Summary-first: every run writes
  `.runtime-cache/artifacts/runs/<runId>/reports/summary.json`.
- Diagnostics index: every run writes
  `.runtime-cache/artifacts/runs/<runId>/reports/diagnostics.index.json`.
- Evidence index: every run writes
  `.runtime-cache/artifacts/runs/<runId>/reports/evidence.index.json`.
- CI ops summary: workflows write
  `.runtime-cache/artifacts/ci/uiq-<profile>-ops-summary.{json,md}` from
  manifest data.
- CI evidence verifier: workflows run `scripts/ci/verify-run-evidence.mjs` as a
  hard gate before summary publishing.
- Driver abstraction: platform differences are isolated in `packages/drivers/*`.
- MCP-ready boundary: `services/mcp-server` is the adapter boundary for exposing
  `uiq` as tools/resources (design-ready, no MCP rollout required in this
  track).
- Desktop host-safety contract: repo-owned desktop business/E2E/smoke/soak
  flows are operator-manual only. They must fail closed unless
  `UIQ_DESKTOP_AUTOMATION_MODE=operator-manual` and
  `UIQ_DESKTOP_AUTOMATION_REASON=<auditable reason>` are present, and teardown
  must use repo-owned positive PIDs instead of broad host cleanup or
  name-based force kill behavior.
- Builder entry boundary:
  `docs/reference/integration-entrypoints.md` is the public map for choosing
  between HTTP/OpenAPI, MCP, frontend hooks, and generated harness helpers.
- Dependency boundary enforcement:
  `configs/governance/dependency-boundaries.yaml` +
  `scripts/ci/check-dependency-boundaries.mjs`.

## Integration Substrate Contract

Pagestress currently exposes three different integration substrate layers on
purpose.

| Layer | Current role | Contract level |
| --- | --- | --- |
| OpenAPI + HTTP | Primary builder-facing contract | Public and canonical |
| MCP server | Agent-facing adapter over existing truth surfaces | Public adapter contract |
| Frontend hooks + generated harness client | First-party and test-harness wiring | Repo-internal implementation layer |

This means:

- builders should start from `contracts/openapi/api.yaml`
- agent users should start from `pnpm mcp:start`
- repo contributors may reuse `useApiClient`, `useProofApi`, and
  `tests/web-harness/src/api-gen/**` as examples

It does **not** mean:

- there is already one stable SDK that covers every surface
- frontend hooks are a promised external import surface
- MCP replaces the HTTP contract

Future SDK path, if it is added later, should grow from the OpenAPI source of
truth and move generation or curated client code out of the current
`tests/web-harness/` location into an explicitly versioned package.

## Run Lane Contract

The repository intentionally keeps multiple run surfaces. They are related, but
they are not interchangeable and must not be collapsed into a single mental
model.

| Lane | Entry | Primary intent | Primary truth / output | Notes |
| --- | --- | --- | --- | --- |
| Local product lane | `./scripts/dev-up.sh` | Boot the operator UI and FastAPI locally | `.runtime-cache/dev/*`, `.runtime-cache/logs/*` | Local first-look path only. It does not write a governed proof bundle. |
| Automation command lane | `POST /api/automation/run` | Queue allowlisted command execution | `AutomationTask` ledger | May invoke script-pipeline commands such as `script-pipeline-full` and `script-pipeline-capture`. Deprecated `run*` aliases are no longer the current contract. |
| Workflow run lane | `POST /api/runs` | Create operator-facing runs from saved templates | Universal workflow ledger (`Session -> Flow -> Template -> Run`) | Bridges to `AutomationTask` through `Run.task_id`. |
| Script pipeline lane | `./scripts/run-pipeline.sh` | Run record/extract/generate/replay flow automation | Runtime-side automation session files and generated flow/test assets | This lane currently backs specific automation commands. It is not the governed pagestress. |
| Governed pagestress | `pnpm uiq run --profile <profile> --target <target>` | Produce release / gate evidence bundles | `.runtime-cache/artifacts/runs/<runId>/manifest.json` | Canonical pagestress for manifest/summary/evidence-index output. |
| MCP adapter lane | `pnpm mcp:start` | Expose API, governed proof, and artifact reads as MCP tools/resources | Reuses existing ledgers and governed proof artifacts | Adapter only. It is not an independent execution model. |

Canonical wording in docs and UI should follow this table:

- **governed run / governed proof** means the `pnpm uiq run` lane unless a
  document explicitly says otherwise.
- **workflow run** means the `/api/runs` lane backed by the universal workflow
  ledger.
- **automation command** means the `/api/automation/run` lane backed by
  `AutomationTask`.
- **script pipeline** means `scripts/run-pipeline.sh` and the commands that
  wrap it.

## Primary Path / Extension Registry / Migration Matrix

- Canonical script-pipeline path is `Flow -> Template -> Run`, executed by
  `scripts/run-pipeline.sh`.
  - Flow: record and extract source interactions.
  - Template: generate and validate reusable template/spec.
  - Run: replay generated flow as deterministic script-pipeline evidence.
- Canonical governed proof path is
  `Profile -> Target -> Evidence Bundle`, executed by
  `pnpm uiq run --profile <profile> --target <target>`.
  - Profile: choose the governed check mix and thresholds.
  - Target: bind runtime capability and environment-specific launch details.
  - Evidence Bundle: write manifest, summary, diagnostics index, and evidence
    index under `.runtime-cache/artifacts/runs/<runId>/`.
- `POST /api/runs` is the canonical operator-facing workflow run surface. It
  creates `Run` records and may dispatch underlying `AutomationTask`
  execution, but it does not replace the governed pagestress.
- `scripts/run-register-flow.sh` is historical only and must not be used in
  new automation or CI wiring.

## Runtime Truth Map

The system keeps two different ledgers on purpose:

- **Execution ledger (`AutomationTask`)**:
  the source of truth for queued/running/success/failed command execution.
  Backed by SQL `automation_tasks` when `DATABASE_URL` is set, otherwise
  `.runtime-cache/automation/tasks.json`.
- **Universal workflow ledger (`Session -> Flow -> Template -> Run`)**:
  the source of truth for reusable workflow authoring and operator-facing run
  state. Backed by `.runtime-cache/automation/universal/{sessions,flows,templates,runs}.json`.

These ledgers are related but not interchangeable:

- `Run` is an operator/business record, not the underlying process executor.
- `Run.task_id` links a workflow run to an `AutomationTask`.
- Current run status is synchronized from task execution state plus runtime
  output parsing; it is not an independent execution engine.

The decision plane keeps two additional canonical surfaces:

- **Proof campaign ledger**:
  the source of truth for operator-facing proof bundles that group one or more
  governed runs for review.
  Backed by `.runtime-cache/automation/universal/proof-campaigns.json`.
- **Proof campaign artifacts**:
  machine-readable report/index/diff outputs for the decision plane.
  Backed by `.runtime-cache/artifacts/proof-campaigns/<campaignId>/`.

Template lifecycle is also versioned at the workflow layer:

- `TemplateRecord` is a versioned asset, not just a mutable CRUD row.
- `template_family_id` groups versions of the same promoted asset.
- `PATCH /api/templates/{template_id}` remains compatibility support; structural
  evolution must move through promotion/fork-version APIs instead of treating
  in-place patching as the canonical version path.

Projection layers must not be treated as primary truth:

- `services/api/app/api/command_tower.py` reads latest flow drafts, evidence
  timeline, and step evidence from runtime-side files under the automation
  session directories.
- `services/api/app/services/video_reconstruction_service.py` writes preview and
  generated reconstruction outputs under `.runtime-cache/automation/reconstruction/`.
- These surfaces are runtime artifacts and operator views, not the canonical
  workflow ledger.

Compatibility boundary:

- OpenAPI keeps some compatibility-only fields and enums for downstream
  consumers.
- Current backend run status does **not** emit `blocked`; current runtime emits
  `queued|running|waiting_user|waiting_otp|success|failed|cancelled`.
- Fields such as `artifacts_ref`, `artifacts_index`, and
  `validated_params_snapshot` should not be interpreted as primary truth unless
  a concrete active write path is documented.

### Extension Registry Contract

- Orchestrator schema keys registry:
  - Source of truth:
    `configs/schemas/profile.v1.schema.json`,
    `configs/schemas/target.v1.schema.json`.
- Gate-check registry:
  - Primary source: built-in `CROSS_TARGET_KEY_GATE_CHECK_IDS`.
- Profile registry:
  - Source of truth: `configs/profiles/*.yaml`.
- Driver capability registry:
  - Source of truth: `configs/drivers/capabilities.registry.json` (or
    `UIQ_DRIVER_CAPABILITIES_REGISTRY_FILE` when explicitly overridden).
  - Test-only fallback exists in `packages/drivers/capabilities.ts`, but only
    for explicit fallback mode in tests or controlled diagnostics. Normal
    runtime treats a missing or invalid registry as a blocking contract
    violation.
  - Repo-default runtime must read the tracked registry file above; any
    in-code fallback map is test-only compatibility support and is not
    contract truth.
- Step-scope registry:
  - Source of truth:
    `UIQ_WEB_ONLY_STEPS` / `UIQ_DESKTOP_ONLY_STEPS`.

Registry load failures are blocking contract violations.

### Migration Matrix (Platform Capability)

| Platform target | Default driver | Capability baseline | Migration note |
| --- | --- | --- | --- |
| `web` | `web-playwright` | `navigate/interact/capture/logs/network/trace` | Full Flow/Template/Run path supported; preferred baseline for template authoring. |
| `tauri` | `tauri-webdriver` | `navigate/interact/capture/logs/lifecycle` | Requires `app` runtime binding; desktop-only checks rely on lifecycle capability. |
| `swift` | `macos-xcuitest` | `interact/capture/logs/lifecycle` | Requires `bundleId` binding; navigation/network/trace are intentionally non-baseline. |

Migration rule: when adding a new driver/platform, register capability contract
first, then enable profile/target usage. Missing registry data is blocking.

## Runtime Artifact Layout

`uiq` writes all evidence under `.runtime-cache/artifacts/runs/<runId>/`.

- `manifest.json`
- Required `manifest.json` fields in v1.1:
  - `schemaVersion`
  - `execution`
  - `evidenceIndex`
- `reports/summary.json`
- `reports/diagnostics.index.json`
- `reports/evidence.index.json`
- `.runtime-cache/artifacts/ci/uiq-<profile>-ops-summary.json`
- `.runtime-cache/artifacts/ci/uiq-<profile>-ops-summary.md`
- `logs/`
- `network/`
- `screenshots/`
- `traces/`
- `a11y/`
- `perf/`
- `visual/`
- `security/`
- `metrics/`

## Profile Contract

- Source of truth: `configs/profiles/*.yaml` (profile name must match filename stem).
- `pr`: `unit + contract + ct + e2e + capture + a11y + perf + visual + report`
- `nightly`:
  `unit + contract + ct + e2e + capture + explore + chaos + a11y + perf + visual + load + security + report`
- `tauri.smoke`:
  `desktop_readiness + desktop_smoke + desktop_e2e + security + report`
- `swift.smoke`:
  `desktop_readiness + desktop_smoke + desktop_e2e + security + report`
- `tauri.soak`:
  `desktop_readiness + desktop_smoke + desktop_e2e + desktop_soak + security + report`
- `swift.soak`:
  `desktop_readiness + desktop_smoke + desktop_e2e + desktop_soak + security + report`

## Gate Status Contract

- Source of truth: `manifest.gateResults.status`.
- Check list: `manifest.gateResults.checks[]`.
- Non-pass checks (`failed` or `blocked`) include canonical `reasonCode`.
- CLI exit behavior for `uiq run`:
  - `passed` returns process exit `0`.
  - `failed` or `blocked` returns non-zero exit (CI hard fail).

## CI Reliability Notes

- Execution environment truth source is containerized:
  `docker/ci/base.Dockerfile` + `docker/ci/browser.Dockerfile` +
  `docker/compose.ci.yml` + `scripts/ci/run-gate-in-container.sh`.
- Local standard shell is DevContainer; host-local ad-hoc execution is
  troubleshooting-only and not parity truth.
- Repo CI runner routing contract: `.github/workflows/ci.yml` and
  `.github/workflows/pr.yml` run on GitHub-hosted runners for required jobs.
  Manual live lanes use protected environments rather than any legacy shared
  runner pool.
- Secret-backed live, desktop, and privileged branch-protection audit lanes
  are workflow_dispatch-only and bind the `owner-approved-sensitive`
  protected environment before they can reach external or privileged
  surfaces.
- The manual desktop smoke lane now requires both workflow_dispatch inputs:
  `tauri_app_path` for the tauri matrix leg and `swift_bundle_id` for the
  swift matrix leg. These inputs are part of the current contract, not
  optional hints.
- Default local verification contract:
  `pnpm test:matrix`, `pnpm verify:all`, and `pnpm prepush:quality-gate`.
- Explicit parity contract:
  `bash scripts/ci/run-gate-in-container.sh <docs-gate|lint-all|test-matrix|verify-all>`,
  `pnpm test:matrix:full`, `pnpm verify:all:parity`, and
  `pnpm prepush:quality-gate:parity`.
- Shared-link repair verdict contract: `scripts/lib/node-toolchain.sh` is the
  single owner for deciding whether shared-link repair failures are
  hard-blocking or degradable, and wrapper/gate scripts must consume that
  helper verdict instead of matching stderr text ad hoc.
- Container gate install contract: `scripts/ci/pnpm-install-safe.sh` may refresh
  direct dependency links first, but containerized verify/test lanes still must
  materialize any root-resolved transitive CT modules before CT or governed
  proof runs rely on them; when the install step already leaves the required
  root-resolution targets in place, the container gate may skip the direct-link
  refresh entirely, and only when that shortcut path is still insufficient
  should the install path continue into the full shared-link topology repair.
- Proof run artifact access contract: `/api/proof/runs/compare` and
  `/api/proof/runs/{run_id}/ai-review` must enforce the verified automation
  actor's run ownership before reading `.runtime-cache/artifacts/runs/<runId>/`
  bundles; proof routes may not bypass run-level access checks just because the
  artifact files are repo-local.
- Manual gate resume contract: `checkpoint_ack` is not a supported first-party
  resume kind yet. Until an end-to-end checkpoint acknowledgement path exists,
  `/api/runs/{run_id}/resume` must reject that kind explicitly instead of
  silently treating it like generic input.
- Container-gate AI credential adapter: local/manual container gates may
  normalize `LIVE_GEMINI_API_KEY` into the canonical `GEMINI_API_KEY` before
  running `verify-all`, but the application/runtime contract itself still
  treats `GEMINI_API_KEY` as the formal Gemini key input.
- `verify-all` frontend non-stub contract: the gate reuses the backend boot
  path owned by `tests/frontend-e2e/playwright.config.ts` instead of starting a
  second API process inside `scripts/verify-all.sh`.
- `verify-all` auth contract: frontend non-stub gates must inject one
  non-placeholder automation token into both backend and frontend env; weak
  placeholders such as `replace-with-strong-token` are invalid for this lane.
- `pnpm prepush:quality-gate` is the default fast/light local entry and is
  explicitly non-parity; `pnpm prepush:quality-gate:parity` is the explicit
  full-parity path. Low-level script execution still requires the same explicit
  light override contract (`UIQ_ALLOW_LIGHT_PREPUSH=1` +
  `UIQ_ALLOW_LIGHT_PREPUSH_REASON`) whenever code changes bypass heavy parity.
- Tool caches must stay off the checkout worktree during CI runs.
  Repo-owned artifacts and reports may live under `.runtime-cache/`, but
  `pre-commit`, pnpm store, `uv`/`pip`, Playwright browser caches, and runner
  tool caches must resolve via `runner.temp`-backed paths instead.
  Governance applies to both environment variables and `actions/cache` `path:`
  entries so literal `~/.cache/*`, `${{ github.workspace }}`, and relative
  checkout paths cannot silently creep back into current workflows.
  Container gate commands that depend on runner-scoped caches, such as
  `PRE_COMMIT_HOME`, must be forwarded explicitly into `docker compose run`
  rather than assumed to exist inside the container by default.
  The `ci-browser` image uses the image-native `/ms-playwright` browser cache,
  while the shared Node toolchain still resolves through the runner-temp
  workspace link repair flow.
  The shared-link shortcut is valid only when direct `node_modules` bridges
  satisfy the current root `package.json` dependency versions; otherwise
  `scripts/lib/node-toolchain.sh` must refresh those direct links from the
  shared `.pnpm` store before falling back to a full repair.
  If the shared store is already valid but the local repair stamp is missing,
  the repair flow records the current fingerprint and skips the unnecessary
  full rebuild path.
  Python entrypoints that depend on the repo-managed virtual environment, such
  as Alembic migrations inside container gates, should run through
  `scripts/lib/python-exec.sh` so the selected interpreter stays aligned with
  the same runtime contract used by repo-side gates.
  Long-lived background services started inside CI must also declare explicit
  cleanup so shared runners do not retain orphaned processes across jobs.
  This keeps hard gates executable when GitHub-hosted `ubuntu-latest` is
  unavailable by policy/quota, without changing gate thresholds.
- PR/static gates may execute environment checks without generating
  `.runtime-cache/artifacts/config/env-reduction-report.json`; `env:tail:decisions` treats this
  as a documented skip path and requires `pnpm env:governance:reduction` before
  strict tail-decision enforcement.
- Workflow dependency policy is enforced by
  `scripts/release/check-workflow-pnpm-version-guard.sh`:
  external actions must pin full commit SHA (40 hex), `pnpm/action-setup` is
  forbidden, and Node workflows must activate pnpm via `corepack prepare` from
  root `packageManager`.
- CI `docs` threshold sync compares against a merge-base when available and
  falls back to direct `origin/<base>..HEAD` diff when merge-base is not
  resolvable in detached PR merge refs.
- CI `security` gate requires `pull-requests: read` permission so secret-scan
  actions can enumerate PR commits.
- Frontend non-stub Playwright lanes must boot `apps/command-center` through
  its own Vite config with an explicit app root so repo-root webServer launches
  still serve `/` correctly during `verify-all` and PR gates.
- Frontend non-stub Playwright lanes must restrict test discovery to
  `non-stub-*.spec.ts` so live-backend validation does not silently mix in
  stub-only frontend suites.
- Non-stub frontend gates must share one non-placeholder automation token across
  backend (`AUTOMATION_API_TOKEN`) and frontend (`VITE_AUTOMATION_TOKEN` /
  `UIQ_AUTOMATION_TOKEN`) boot env. Weak placeholder-like tokens are invalid for
  live non-stub verification even in local diagnostic runs.
- The web CT lane relies on the Playwright CT core runtime plugin plus the local
  `tests/web-harness/tests/ct/playwright-ct-runtime.js` shim so component tests
  mount against the same CT runtime contract in local and CI execution.

## Cross References

- Dependency lifecycle operations:
  `docs/reference/dependency-governance.md`
- Builder integration map:
  `docs/reference/integration-entrypoints.md`
- Public boundary reference:
  `docs/reference/public-readiness.md`
- CI governance reference:
  `docs/reference/ci-governance.md`
- Public artifact policy:
  `docs/reference/public-artifact-policy.md`
