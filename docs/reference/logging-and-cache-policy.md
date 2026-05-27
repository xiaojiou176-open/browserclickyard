# Reference: Logging And Cache Policy

This document explains the practical logging and cache boundary used by the
runtime-governance checks.

## Logging Boundary

- Canonical runtime logs live under `.runtime-cache/logs`.
- CI logs, dev logs, automation logs, and test-matrix logs all stay under the
  runtime root instead of leaking into ad-hoc top-level paths.
- Root-level wildcard log surfaces remain forbidden outside the governed
  runtime root.
- Service-local log roots such as `services/**/.runtime-cache/logs` are drift;
  repo-owned writers must resolve back to the root `.runtime-cache/logs/**`
  contract instead of keeping nested runtime log trees alive.

## Cache Boundary

- Repo-owned runtime cache stays under `.runtime-cache`.
- Machine/shared caches must stay outside the repo worktree.
- The authoritative dependency root for this repo is the repo-local
  `node_modules` directory.
- Container gate runner-temp bridges live under `.runtime-cache/container-runs`
  and are treated as scratch, not as long-lived evidence.
- Repo-local install sandboxes under `.runtime-cache/pnpm-install-safe.*` are
  unmanaged drift, not legitimate steady-state cache roots.
- The main shared cache families currently relevant to this repo are:
  - `${XDG_CACHE_HOME:-$HOME/.cache}/uiq/node-modules`
  - `${XDG_CACHE_HOME:-$HOME/.cache}/uiq/python-env`
  - `${HOME}/Library/Caches/ms-playwright`
  - `${XDG_CACHE_HOME:-$HOME/.cache}/uv`
  - `${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack`
  - `${HOME}/.npm/_cacache`
  - `${HOME}/.docker`

## Cleanup Rules

- `evidence_keep` surfaces are not routine-GC targets.
- `runtime_state` surfaces need active-use validation before cleanup.
- `disposable_generated` and `scratch` are the default runtime-GC candidates.
- `./scripts/runtime-gc.sh --scope automation` only targets `pytest-*`
  leftovers under `.runtime-cache/automation`; it does not touch ledgers,
  databases, or universal-platform runtime state.
- `./scripts/cleanup-runtime.sh` refuses direct cleanup of `runtime_state` and
  `evidence_keep` directories.
- Shared external layers must never be re-labeled as repo-owned releasable
  bytes in machine-readable space reports.

## Source-tree Hygiene

- Python `__pycache__`, `.pyc`, `.coverage*`, `.mutmut-cache`, and `mutants`
  should not remain in governed workspace source trees as steady-state
  artifacts.
- Mutation summaries belong under `.runtime-cache/reports/mutation/...`,
  temporary mutation workspaces belong under `.runtime-cache/temp/mutation-workspaces/...`,
  and coverage belongs under `.runtime-cache/coverage/...`; none of these
  should remain inside `services/api` source paths.
