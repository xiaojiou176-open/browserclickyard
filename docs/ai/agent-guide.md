# Agent Guide

## Canonical Policy

- This document is the canonical execution standard for the repository.
- `AGENTS.md`, `CLAUDE.md`, and `docs/index.md` are adapter or routing surfaces
  only.
- If any adapter conflicts with this file, this file wins.

## Project Scope

- Frontend: product command center in `apps/command-center/`
- Backend: FastAPI control plane in `services/api/`
- Protocol adapter: MCP server in `services/mcp-server/`
- Orchestration: `pnpm uiq <command>`

## Hard Gates

1. Live tests must use real keys, real browsers, and real external targets.
2. Lint and type errors must be zero before delivery.
3. Coverage remains mandatory at the configured repo thresholds.
4. Placebo tests are forbidden.
5. Parallelizable work must run in parallel.
6. Long-running tasks must emit heartbeat progress.
7. Short suites must run before long suites.
8. Code and docs must move together.
9. Root `AGENTS.md` and `CLAUDE.md` must stay present and current.
10. Task routing must load the minimum necessary rule set.
11. Search before writing is mandatory with both text and structural search.
12. Canonical rules live in one place only.
13. Delivery must include command, exit code, artifact, and gate evidence.
14. A hard-gate failure means the task is blocked.
15. Host-process safety outranks desktop convenience: worker/test/orchestrator paths must not use broad host cleanup, name-based quits, or unattended host-wide input automation.
16. Public-safe repo content must not include real secrets, raw runtime logs, personal emails, or machine-local absolute paths.

## Host Safety

- Desktop smoke, E2E, business, and soak flows are operator-manual only.
- The only supported opt-in is:
  - `UIQ_DESKTOP_AUTOMATION_MODE=operator-manual`
  - `UIQ_DESKTOP_AUTOMATION_REASON=<auditable reason>`
- Even in operator-manual mode, teardown must stay repo-owned. If a flow cannot prove ownership with repo-local state, it must block instead of guessing or force-killing.
15. Host safety is a hard gate: broad process kills and unattended desktop-wide
    automation are forbidden outside explicit operator-manual flows.

## Search Before Writing

1. `rg -n "<keyword>" docs scripts backend frontend packages`
2. `sg -p '<AST_PATTERN>' backend frontend packages`
3. `bash scripts/dev/ast-search.sh '<AST_PATTERN>' backend frontend packages`
4. `rg --files docs | rg "agent|guide|gate|readme"`

If `sg` is unavailable, record the waiver and use the unified fallback command.

## Task Routing

| Task type | Read first | Required command |
| --- | --- | --- |
| Docs and governance work | `docs/ai/agent-guide.md` + `docs/index.md` | `bash scripts/docs-gate.sh` |
| Code changes | `docs/ai/agent-guide.md` + `docs/architecture.md` | `bash scripts/lint-all.sh` |
| Test-system changes | `docs/ai/agent-guide.md` + `docs/reference/ci-governance.md` | `pnpm test:matrix` |
| Pre-delivery acceptance | `docs/ai/agent-guide.md` | `pnpm verify:all` |

## Canonical Gate Commands

- `pnpm gate:repo:fast`
- `pnpm test:matrix`
- `pnpm test:matrix:full`
- `pnpm doctor:repo`
- `pnpm verify:all`
- `pnpm verify:all:parity`
- `pnpm prepush:quality-gate`
- `pnpm prepush:quality-gate:parity`
- `pnpm gate:github:security-alerts`
- `pnpm gate:workflow:zizmor`
- `pnpm gate:security:trivy`
- `pnpm gate:sensitive-surfaces`
- `pnpm gate:delivery:fast`
- `pnpm gate:delivery:full`
- `pnpm audit:oss:redaction`

`pnpm gate:repo:fast` must stay runnable on minimal GitHub runners, so the
conflict-marker guard intentionally uses `git grep` instead of assuming `rg`
is preinstalled.

## Delivery Evidence Template

```text
Delivery Evidence
- Task Route:
  - <task_type> -> <loaded_docs_or_rules> -> <actions>
- Commands:
  - <command> => exit <code>
- Artifacts:
  - <path/to/report-or-log>
- Gates:
  - docs-gate: pass/fail
  - lint-all: pass/fail
  - test-matrix: pass/fail
  - verify-all: pass/fail
- Notes:
  - <waiver or risk note if any>
```
