# Reference: Dependency Governance

This document is the canonical dependency-governance reference for the public
repository and must move together with manifest and lockfile changes.

## Security Patch Baseline

- Vulnerability-driven transitive npm fixes are pinned through root `pnpm.overrides`.
- The current override baseline includes patched releases for `axios`, `undici`,
  `form-data`, `fast-xml-parser`, `flatted`, `socket.io-parser`, `file-type`,
  `underscore`, `hono`, `esbuild`, and the currently-governed
  `path-to-regexp` vulnerable transitive lines (`0.1.12 -> 0.1.13`,
  `8.3.0 -> 8.4.0`).
- The current npm security baseline also pins `basic-ftp` to `5.2.1` so the
  root workspace no longer carries the command-injection advisory from the
  previous `5.2.0` line.
- The current security baseline pins `lodash` and `lodash-es` to `4.18.1`
  because GitHub advisories `GHSA-f23m-r3pf-42rh` and `GHSA-r5fr-rjxr-66jc`
  surfaced through Dependabot for the transitive runtime lines used by
  Lighthouse and Artillery, and `4.18.1` is the current non-deprecated npm
  release after the short-lived `4.18.0` bad publish.
- When that override baseline changes, refresh `pnpm-lock.yaml` with the same
  pnpm major line used by CI so frozen installs do not fail with
  `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` before repo gates even start.
- The root workspace keeps `ajv` on the Ajv v8 line because the MCP SDK and
  `ajv-formats` validation chain require that major version during test-harness
  client initialization.
- The current closeout baseline also advances root `vite` to `7.3.2` so the
  default shipping branch no longer carries the open GitHub advisories tied to
  the older `7.3.1` line.
- When GitHub Dependabot reports a vulnerable transitive npm dependency, update
  the override baseline, regenerate `pnpm-lock.yaml`, and rerun repo gates
  before merge.
- When a Python advisory has a patch release available only in `uv.lock`
  transitive resolution, refresh the lock with `uv lock --upgrade-package <name>`
  and record the accepted residual advisories, if any, in `CHANGELOG.md` until
  the upstream package publishes a fixed release.
- The current Python transitive security baseline advances `cryptography` to
  `46.0.7` through `uv.lock`, which is the first patched release after the
  buffer-overflow advisory that affected `46.0.6`.

## Active Closeout Baseline

### Current Python lock snapshot

| Package | Current locked version |
| --- | --- |
| `fastapi` | `0.135.3` |
| `cryptography` | `46.0.7` |
| `mypy` | `1.20.0` |
| `requests` | `2.33.1` |
| `ruff` | `0.15.9` |
| `schemathesis` | `4.15.0` |
| `sqlalchemy` | `2.0.49` |

### Current JS tooling snapshot

| Workspace | `@types/node` | `@vitejs/plugin-react` | `playwright` family | Extra governed note |
| --- | --- | --- | --- | --- |
| repo root (`package.json`) | `25.5.2` | `4.7.0` | `1.59.1` (`playwright`, `@playwright/test`, `@playwright/experimental-ct-react`) | `@commitlint/config-conventional=20.5.0`, `react-router-dom=7.14.0`, `vite=7.3.2` |
| `apps/command-center/package.json` | n/a | `4.7.0` | `1.59.1` (`playwright`) | `@vitejs/plugin-react 5.x` is intentionally rejected for now after local smoke regression evidence |
| `tooling/automation/package.json` | `25.5.2` | n/a | `1.59.1` (`playwright`, `@playwright/test`) | automation runtime stays on the same Playwright baseline as root |
| `services/mcp-server/package.json` | `25.5.2` | n/a | n/a | MCP server keeps the same Node type baseline as root |

## Scope

This policy governs baseline, upgrades, and lockfiles for:

- Ajv
- React
- TypeScript
- Playwright (`playwright` + `@playwright/test`)
- Vitest

## Baseline Matrix (Current SSOT)

| Workspace | Ajv | React | TypeScript | Playwright | Vitest |
| --- | --- | --- | --- | --- | --- |
| repo root (`package.json`) | `8.18.0` | `19.1.1` | `5.9.2` | `1.59.1` | `3.2.4` |
| `apps/command-center/package.json` | n/a | `19.1.1` | `5.9.2` | `1.59.1` | `3.2.4` |
| `tooling/automation/package.json` | n/a | n/a | `5.9.2` | `1.59.1` | n/a |
| `services/mcp-server/package.json` | n/a | n/a | `5.9.2` | n/a | n/a |

## Baseline Strategy

- Root baseline is the release baseline for new work.
- Root `ajv` must stay on the v8 line expected by the MCP SDK and
  `ajv-formats`; downgrading it reintroduces MCP client bootstrap failures in
  the current harness/runtime combination.
- `apps/command-center/` and `tooling/automation/` must track the same TypeScript/Playwright baseline as root.
- React/Vitest are aligned between root and `apps/command-center/`.
- For Playwright, `playwright`, `@playwright/test`, and
  `@playwright/experimental-ct-react` must stay aligned by major/minor in the
  same workspace when those packages coexist.
- Node typing and build-plugin upgrades that cross root/app/tooling/MCP
  boundaries must move together in the same governed PR so workspace toolchain
  truth does not fragment.
- The current closeout cycle intentionally rejects `@vitejs/plugin-react 5.2.x`
  until the frontend smoke path can be reverified on a compatible operator
  Node/Vite baseline without the observed runtime regression.
- Any temporary drift must be documented in PR with blocker + target convergence cycle.

## Upgrade Cadence

- Dependabot version updates are reopened on a weekly cadence with an open PR cap of `5` per governed ecosystem in `.github/dependabot.yml`.
- Weekly: security patch triage (CVE/high severity dependency alerts).
- Monthly: minor + patch upgrades for the four governed dependency groups.
- Quarterly: major version evaluation with migration validation and rollback plan.

## Upgrade Playbook

1. Create a dedicated branch and choose one dependency group.
2. Bump versions only in relevant `package.json` files.
3. Refresh lockfiles with deterministic install:
   - Root: `pnpm install --frozen-lockfile` (expect fail before bump), then `pnpm install`
   - Workspace-only bumps: `pnpm -C apps/command-center install` or `pnpm -C tooling/automation install`
4. Run validation gates:
   - `pnpm typecheck`
   - `pnpm test:unit`
   - `pnpm test:ct` when React/Vitest/Playwright surfaces changed
   - `pnpm test:e2e:frontend` for runtime-impacting upgrades
5. Document outcome in PR:
   - baseline delta
   - risk notes
   - rollback command and evidence paths

## Upgrade Rules (Hard Requirements)

1. Upgrade one dependency group per PR when possible (React or TypeScript or Playwright or Vitest).
2. Regenerate lockfiles only via package manager commands; no manual lockfile edits.
3. Every dependency PR must include:
   - changed package manifests
   - corresponding lockfile diff
   - validation evidence (`pnpm typecheck` + relevant test suite)
4. If a workspace cannot move with root baseline in the same cycle, document blocker and target cycle in the PR description.

## Lockfile Policy

Tracked lockfiles:

- `pnpm-lock.yaml` (repo root)
- `uv.lock` (Python toolchain)

CI and bootstrap baselines that move with dependency governance:

- `docker/ci/base.Dockerfile` and `docker/ci/browser.Dockerfile` define the
  pinned CI runtime dependency baseline for Node, Python, pnpm, Playwright, and
  related bootstrap tooling.
- Changes to CI base images, root lockfiles, or package-manager bootstrap
  scripts must update this document in the same change so container/runtime
  dependency truth does not drift from the public governance surface.
- Repo doctor wiring in `package.json` is also part of that bootstrap truth:
  changes to package-manager-driven gate composition must keep dependency and
  workflow-governance expectations aligned in the same public reference.
- Decision-plane dependency wiring now also falls under this rule:
  changes to package-manager scripts, generated client surfaces, MCP proof
  adapter packaging, or frontend/backend contract entrypoints that move with
  dependency manifests must update this document in the same change so the repo
  does not drift into \"code changed but dependency/governance story stayed stale\".

Rules:

- CI/install must prefer frozen lockfiles (`pnpm install --frozen-lockfile`, `uv sync --frozen` when applicable).
- `pnpm-lock.yaml` is the single Node lockfile truth source; nested `apps/command-center/` and `tooling/automation/` lockfiles are forbidden.
- Resolve pnpm lockfile conflicts by rerunning root `pnpm install` and recommitting deterministic output.
- Dependency bumps without lockfile updates are invalid.

## Shared Dependency Roots

- The current `/public-repo` workspace uses repo-local `node_modules` as the
  authoritative Node root for repo-local installs.
- Repo-family fallback caches such as `~/.cache/uiq/node-modules` are tolerated
  as shared recovery layers, not the primary workspace truth.
- Runtime-only bridges such as `/tmp/uiq-runner/uiq-node-modules` must not be
  left behind as dangling steady-state symlinks.
- Gate wrappers may continue after a shared-link repair miss only when the
  remaining issue is a non-essential dependency gap and the wrapper's required
  binaries or selected suites still resolve.
- Shared-link hard failures such as repair-lock timeouts or invalid governed
  roots remain blocking and must still fail fast before lint/test execution.

## Dependency Boundary Contract

- Architectural boundary source of truth:
  `configs/governance/dependency-boundaries.yaml`
- Enforcement gate:
  `node scripts/ci/check-dependency-boundaries.mjs`
- Hard rules:
  - `packages/` must not import `apps/`, `apps/command-center/`, `services/api/`, `tooling/automation/`, or `tests/`
  - business code must not import test helpers/fixtures
  - `apps/` and `apps/command-center/` must consume `packages/` and `contracts/` surfaces, not backend internals

## Failure Handling Flow

### Install fails after version bump

- Confirm failing workspace:
  `pnpm -r --filter ./... list --depth 0`
- Remove stale install state and reinstall:
  `bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile`
- If failure persists, revert the bump commit and split by smaller scope.

### Typecheck or build fails

- Run targeted diagnostics:
  `pnpm typecheck --filter apps/command-center...`
- Add migration-compatible code changes in the same PR.
- If incompatible upstream regression is confirmed, roll back dependency and open a tracking issue.

### Runtime or E2E regressions

- Reproduce with deterministic command:
  `pnpm test:e2e:frontend -- --reporter=line`
- Capture artifacts under `.runtime-cache/artifacts/runs/<runId>/`.
- Decide:
  - fix app code and keep upgrade
  - or revert dependency bump and defer to next cadence

### Security advisory with no safe upgrade available

- Pin to highest non-vulnerable patch if available.
- If no fix exists, document accepted risk window and mitigation in PR.
- Revisit in next weekly security triage.

## Validation Gate for Dependency PRs

- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:ct` (when Playwright/React/Vitest changes affect UI test surface)
- `pnpm test:e2e:frontend` (when frontend runtime/testing stack changes)

## Rollback Playbook

1. Revert dependency bump commit.
2. Reinstall lockfiles with `pnpm install`.
3. Re-run `pnpm typecheck` and `pnpm test:unit`.
4. Attach rollback evidence to PR and reschedule upgrade in next cycle.

## Related

- Runtime data cleanup and retention follow the repo-owned runtime boundary described in `docs/quality-gates.md` and `docs/reference/public-artifact-policy.md`.
- Architecture SSOT: `docs/architecture.md`
