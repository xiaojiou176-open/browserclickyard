# Changelog

## Unreleased

- Promoted `services/mcp-server` into the only publish-ready MCP artifact
  target for this repo by completing scoped package metadata
  (`@uiq/mcp-server`), the `browserclickyard-mcp` bin contract, prepack + pack-smoke
  verification, truthful repo/package launch docs, and a generic in-repo Skill
  scaffold under `docs/skills/browserclickyard-mcp/` without overclaiming registry or
  marketplace publication.
- Refreshed the transitive security baseline again after the first GitHub
  release by advancing `hono` to `4.12.12`, `@hono/node-server` to `1.19.13`,
  and hard-pinning vulnerable `vite@6.4.1` / `vite@7.3.1` resolution paths to
  the patched `6.4.2` / `7.3.2` lines in the root override policy.
- Replaced the legacy weekly verification lane with a nightly-first contract,
  made the fast/light local entrypoints explicit, and added cleanup coverage
  for stale `.runtime-cache/container-runs` scratch bridges so the default
  repo-side verification path now matches the current stress-lab-first closure
  model.
- Taught `smoke-root-cleanliness` to establish the governed workspace
  `node_modules` topology before taking its root snapshot, then reuse that
  shared-link repair while nested repo-governance helpers skip duplicate repair
  and relink work.
- Split the default local quality commands from their parity counterparts so
  `pnpm test:matrix`, `pnpm verify:all`, and `pnpm prepush:quality-gate`
  stay fast/light by default, while `:full` / `:parity` entrypoints remain the
  explicit heavy path for closeout-grade revalidation.
- Absorbed the current Dependabot dependency tail into the closeout line by
  advancing the Vite baseline to `7.3.2`, refreshing the locked `mypy` line to
  `1.20.0`, and closing the associated security/update drift on the canonical
  shipping branch instead of leaving the PRs hanging.
- Recovered the MCP core registry/redaction sources from accidental mutation
  residue, aligned the mutation sandbox to use repo-safe command and dependency
  inputs, and fixed the coverage gate so backend XML output paths remain stable
  even when the workspace path contains spaces.
- Added dedicated Dependency Review, Trivy filesystem audit, and zizmor
  workflow-security audit workflows so dependency deltas, tracked repo
  surfaces, and GitHub Actions policy, including local composite actions under
  `.github/`, are rechecked on modern GitHub-native paths instead of relying
  only on local gates.
- Extended `pnpm audit:oss:redaction` so it now audits the tracked worktree,
  git history, a fresh clone, and GitHub issue/PR text surfaces when GitHub
  credentials are available, while recording both mainline and fresh-clone
  `trufflehog` summaries when the binary exists.
- Extended `pnpm gate:github:security-alerts` to fail on open Dependabot alerts
  in addition to secret-scanning and code-scanning findings.
- Refreshed the Python patch baseline to `fastapi 0.135.3`, `requests 2.33.1`,
  `ruff 0.15.9`, `schemathesis 4.15.0`, and `sqlalchemy 2.0.49`, and aligned
  the JS tooling line around `@commitlint/config-conventional 20.5.0`,
  `react-router-dom 7.14.0`, `@types/node 25.5.2`, and Playwright `1.59.1`.
- Rejected `@vitejs/plugin-react 5.2.x` for now and pinned Dependabot to skip
  that line after fresh local frontend smoke evidence showed a runtime
  regression on the current operator toolchain.
- Hardened desktop and runtime host-safety execution paths so operator-manual
  desktop flows fail closed without broad host cleanup, invalid or foreign pid
  signaling is refused, and regression tests now assert the safer contract
  rather than legacy kill-fallback behavior.
- Added repo-level sensitive-surface gates across docs, lint, nightly, release,
  live-realism, and system-audit flows so tracked secrets, raw runtime
  artifacts, personal identifiers, and machine-local absolute paths are blocked
  before publication, and redacted the public-facing Docker socket path in the
  final acceptance note.
- Added the first release-decision-plane slice: canonical proof APIs,
  Review Board frontend surface, typed manual-gate resume flow, versioned
  template asset lifecycle primitives, and driver-capability registry hardening.
- Closed the remaining public hosted-first governance tail items: sensitive
  live, desktop, and privileged branch-protection workflows now require
  workflow_dispatch plus the `owner-approved-sensitive` protected environment,
  and repo governance no longer treats legacy shared-runner bootstrap metadata
  as current truth.
- Renamed automation command-lane script-pipeline examples and contracts to the
  current `script-pipeline-*` family so public docs and API examples match the
  live allowlisted command ids.
- Isolated CI container-gate image tags per run so concurrent self-hosted jobs
  no longer race to publish the same `uiq-ci-base:local` / `uiq-ci-browser:local`
  image names.
- Hardened the dependency security baseline by pinning vulnerable
  `path-to-regexp` transitive lines through root `pnpm.overrides`
  (`0.1.12 -> 0.1.13`, `8.3.0 -> 8.4.0`) and refreshing `uv.lock` toward the
  patched `cryptography` line.
- Recorded the current `Pygments` advisory as an upstream-blocked residual risk
  because `2.19.2` is still the latest published release at the time of this
  remediation cycle.
- Aligned the root `ajv` dependency with the MCP SDK's Ajv v8 expectation so
  `mcp:smoke` no longer fails during test-harness client initialization when
  `ajv-formats` is loaded.
- Closed the freshly surfaced GitHub Dependabot alerts for transitive
  `lodash` and `lodash-es` by pinning both lines to `4.18.1` in the root
  `pnpm.overrides` block and refreshing `pnpm-lock.yaml` so the default branch
  no longer resolves the vulnerable `4.17.23` runtime path or the deprecated
  `4.18.0` bad publish.
- Refreshed the root `pnpm-lock.yaml` metadata after the lodash override landed
  so frozen CI installs now recognize the current override baseline without
  tripping `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

## 0.1.0 - 2026-03-25

- Reframed the public README around product outcomes, differentiated positioning,
  public proof surfaces, and a result-first quickstart.
- Added a real Command Center screenshot and a new 30-second first-look path to
  the public README and `docs/get-started.md`.
- Added `docs/releases/v0.1.0-public-launch.md` as the first public release
  draft so the repo now has a tracked launch story before the first GitHub
  release is published.
- Added new public docs for evaluation and navigation: `docs/get-started.md`,
  `docs/why-browserclickyard.md`, `docs/proof-center.md`, and `docs/faq.md`.
- Rebuilt `docs/index.md` as a layered navigation hub instead of a governance-only router.
- Added public visual assets and social preview source files under `docs/assets/`,
  including an alt-text registry for reuse across README, docs, releases, and discussions.
- Added a repo-root `uv.lock` so `./scripts/setup.sh` can complete on a fresh
  checkout instead of failing before dependency installation starts.
- Fixed local launch tooling so `./scripts/dev-up.sh` now uses the repo-safe
  pnpm entrypoint, path-stable Alembic invocation, and an absolute SQLite
  runtime path.
- Aligned the Command Center product identity with the public Browserclickyard brand
  across the visible UI header, browser title, and related frontend assertions.
- Enabled GitHub Discussions and aligned the public interaction model around
  discussions for questions, ideas, announcements, and show-and-tell posts.
- Added `.github/release.yml` so future release notes can read like product
  shipping notes instead of raw commit dumps.
- Patched vulnerable npm transitive dependencies via root `pnpm.overrides`, including `axios`, `undici`, `form-data`, `fast-xml-parser`, `flatted`, `socket.io-parser`, `file-type`, `underscore`, `hono`, and `esbuild`.
- Hardened package-script recursion by routing critical self-invocations through `scripts/lib/pnpm-safe.sh`, reducing false failures in containerized verify gates.
- Re-synced generated web-harness API client artifacts after `contracts:generate` so contract-derived fetch wrappers stay committed with their source-of-truth changes.
- Hardened automation security and task isolation.
- Hardened Vonage inbound signature verification by requiring `timestamp` in signed payloads to reduce replay risk.
- Governed `uiq_read_repo_doc` under workspace allowlist/rate-limit/session-budget and added regression coverage for blocked workspaces.
- Expanded MCP redaction coverage for `Authorization: Basic`, `X-API-Key`, and `Cookie`-style sensitive headers.
- Removed dynamic `Function(...)` evaluation from contract validation tests and replaced it with deterministic operation-list parsing.
- Tightened CI IaC consistency gate: compose validation skip on CI now requires explicit `UIQ_ALLOW_COMPOSE_SKIP=1`.
- Hardened hosted fallback dispatcher transparency: dispatch failures now retry and can be escalated to hard-fail via `UIQ_FALLBACK_DISPATCH_STRICT=1`; duplicate detection now ignores failed/completed retries while still skipping already-successful runs.
- Tightened local pre-push light mode: code changes now require explicit heavy parity (`UIQ_PREPUSH_HEAVY=1`) or explicit bypass (`UIQ_ALLOW_LIGHT_PREPUSH=1`).
- Refined fallback dispatch: added retry attempts and dedupe now also skips already-successful completed fallback runs for the same SHA.
- Refined local pre-push change detection: now checks push-range diffs (with staged fallback) instead of relying only on `--cached`.
- Tightened local pre-push anti-fake-green posture: heavy pre-push now disables `test-matrix` command overrides and treats `.github/` + `scripts/` changes as code-impacting.
- Expanded MCP redaction header coverage to include `x-vonage-inbound-token`.
- Fixed heavy pre-push execution path by applying command-override hardening through `env` invocation (prevents `command not found` on heavy mode).
- Expanded MCP redaction coverage to include Vonage legacy fallback headers (`x-vonage-token`, `x-inbound-token`) and applied redaction when reading artifacts/docs via MCP read tools.
- PR gate aggregate now treats `upstream-binding-check` as optional for fork PRs by accepting `skipped` in addition to `success`.
- `verify-all` now fails on untracked generated contract artifacts and enables strict branch-protection verification by default in CI.
- `test-matrix` command override is now default-off in all environments (must be explicitly enabled), reducing local fake-green injection surface.
- PR aggregate gate now requires `upstream-binding-check=success` for non-fork PRs, while still allowing `skipped` only for fork PRs.
- `verify-all` branch-protection strict mode is now context-aware in CI (`push/workflow_dispatch` strict, `pull_request` advisory).
- Contract validation parser now tolerates formatting/field-order shifts without re-introducing dynamic `Function(...)` evaluation.
- Fixed PR aggregate gate to allow `upstream-binding-check=skipped` for non-PR triggers (for example `workflow_dispatch`) while keeping non-fork PRs strict.
- Hardened `uiq_read_manifest` by applying the same sensitive-text redaction used by artifact/doc read tools.
- Refined local pre-push code-change detection to include critical root files (`package.json`, lockfiles, compose files, `Dockerfile`, `.pre-commit-config.yaml`).
- Fixed Vonage inbound endpoint audit fidelity: auth failures now preserve canonical `audit_reason` (for example `auth_query_token_disabled`) instead of collapsing to `token_invalid`.
- Expanded redaction coverage to include `sig`/`signature` fields in query-style and JSON-style payloads.
- Hardened `test-matrix` self-tests: fail-fast test now validates kill behavior within the same wave, and defaults test now asserts `test-truth-gate` remains default-on.
- IaC consistency gate now accepts either `docker-compose.yml` or `docker-compose.yaml` as required compose file naming.
- IaC compose-skip override in CI now requires explicit `UIQ_ALLOW_COMPOSE_SKIP_REASON` for auditable exemptions.
- Added docs governance baseline and docs CI gate.
- Migrated this repo to Org-level shared GCP runner pool and unified CI/PR
  self-hosted routing labels to `[self-hosted, e2-core, spot, shared-pool]`.
- Standardized naming to `UIQ` as canonical term and moved `recon` usage to legacy mapping docs.
- Added reconstruction pipeline: profile resolve, preview, generate, and orchestrate-from-artifacts endpoints.
- Added video/HAR/HTML reconstruction services with compliance `manual_gate` behavior.
- Added MCP tool packaging for reconstruction (`recon_profile_resolve`, `recon_preview`, `recon_generate`, `recon_orchestrate_from_artifacts`).
- Added automation reconstruction scripts/tests and CI core gates for contract + k6 smoke.
- Updated `CI` workflow runner routing: `pull_request` now uses `ubuntu-latest`, while non-PR events use `e2-core` self-hosted runner.
- Rebalanced `CI` queue pressure by pinning lightweight and aggregate jobs (`residue_gate`, `workflow_lint`, `docs`, `security`, `lint_*`, `*_gate`) to `ubuntu-latest` and reserving `e2-core` for heavy workloads.
- Strengthened CI cache performance without relaxing gates: `setup-node-pnpm` now enables lockfile-based `pnpm` cache, and `setup-python-smart` restores `uv/pip` caches keyed by `uv.lock`.
- Fixed CI hosted-runner bootstrap for pnpm cache: `setup-node-pnpm` now activates pnpm via corepack before restoring store cache with `actions/cache`.
- Fixed CI acceptance regressions: `live_smoke` now installs automation deps before Gemini live tests, and `harness_web_ct` process cleanup script no longer trips actionlint shellcheck (`SC2015`).
- Fixed additional CI regressions found during live acceptance: `core_contract_load` now validates compose config with `docker compose config --quiet`, `precommit_parity_gate` retries once after clearing corrupted pre-commit cache manifests, and frontend UI audit auto-detects Playwright Chromium for `CHROME_PATH`.
- Updated CI runner routing to fully self-hosted for this repo: both `CI` and `PR Gate` now run on `[self-hosted, e2-core]` so required checks remain executable even when `ubuntu-latest` capacity or policy is unavailable; gate logic and thresholds are unchanged.
- Added hosted-runner fallback orchestration: `CI` / `PR Gate` now support `workflow_dispatch` input `force_self_hosted`, and workflow `hosted-fallback-dispatch.yml` automatically triggers self-hosted rerun when failure signature indicates hosted runner infrastructure/scheduler issues.
- Rebalanced runner topology to match workload tiers: lightweight governance gates default to `ubuntu-latest` with fallback support, while heavy test/build gates are pinned to GCP self-hosted (`[self-hosted, e2-core]`) and the heaviest lanes (`live_smoke`, `mutation_report`, `prepush_heavy_parity`, automation profile) are pinned to Spot-capable labels (`[self-hosted, e2-core, spot]`).
- Enforced strict real-secret execution for Gemini-backed CI gates: `CI` and `PR Gate` now fail fast when `GEMINI_API_KEY` is missing instead of emitting skip markers, preserving full live-provider strictness; local `pre-push` now defaults to light mode (`UIQ_PREPUSH_HEAVY=0`) to keep heavy validation focused in remote CI.
- Updated env contract undeclared allowlist for platform-injected runtime variables (`CHROME_PATH`, `GITHUB_WORKSPACE`) so `verify-all` env governance gate remains strict without false-positive drift.
- Expanded strict Gemini secret enforcement beyond CI/PR to `nightly.yml`, `weekly.yml`, and `live-realism.yml`; all Gemini-backed live gates now fail fast when `GEMINI_API_KEY` is missing, and `PR Gate` now includes blocking `pnpm env:check`.
- Hardened mutation governance: raised TS/PY mutation break thresholds to `85%`, improved mutation summary observability (top survived mutants + markdown summary), and stabilized TS mutation execution by scoping `mcp:test:mutation` to registry-focused tests.
- Strengthened false-green defenses: `uiq-test-truth-gate` now detects additional anti-patterns (`.only`, hard waits via `waitForTimeout`, `expect.assertions(0)`, `pytest xfail` usage) with regression tests.
- Kept local pre-push default in lightweight mode (`UIQ_PREPUSH_HEAVY=0`) so heavy compute stays in CI while strict mandatory local gates remain enforced.
- Hardened same-run hosted fallback in `CI` and `PR Gate`: added `hosted_runner_probe` and dynamic runner routing so lightweight jobs prefer `ubuntu-latest` but auto-fallback to `[self-hosted, e2-core]` in the same workflow run when hosted capacity fails.
