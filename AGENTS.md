# Agent Guide Entry

## Project Purpose

This repository maintains a browser automation governance and verification
platform. It combines the command center frontend, the FastAPI control plane,
the orchestrator CLI, and the repo-side quality and publication gates.

## Tech Stack

- TypeScript
- Python 3.12
- Playwright
- FastAPI
- pnpm workspace

## Navigation

- Canonical execution rules: `docs/ai/agent-guide.md`
- Canonical architecture contract: `docs/architecture.md`
- Documentation entrypoint: `docs/index.md`
- Public boundary truth: `docs/reference/public-readiness.md`
- CI and branch protection truth: `docs/reference/ci-governance.md`

## Gate Commands

- `bash scripts/docs-gate.sh`
- `bash scripts/lint-all.sh`
- `bash scripts/test-matrix.sh`
- `bash scripts/verify-all.sh`

## Execution Notes

- This file is an adapter only. The canonical rules live in
  `docs/ai/agent-guide.md`.
- Keep runtime and agent state untracked:
  `.agents/`, `.agent/`, `.codex/`, `.claude/`, `.runtime-cache/`, `logs/`,
  nested log directories, and `*.log`.
- `AGENTS.md` and `CLAUDE.md` stay tracked.
- Delivery is blocked if a hard gate fails or if supporting docs drift from the
  implemented behavior.

## Host Safety

- Worker-safe mode is the default for repo automation.
- `killall`, `pkill -f`, negative/zero PID signals, and broad desktop cleanup
  are forbidden in first-party automation paths.
- Desktop UI control must stay operator-manual and auditable; if ownership or
  scope is unclear, fail closed instead of steering the host session.
- Run `bash scripts/ci/host-safety-gate.sh` before merge whenever work touches
  desktop, browser, orchestrator, service lifecycle, or cleanup logic.
- Host safety is now hard policy:
  - `killall`, `pkill`, `killpg(...)`, negative/zero PID signaling,
    `loginwindow` / Force Quit APIs, and unattended AppleScript or
    desktop-wide `System Events` app-control are forbidden in repo-owned
    worker/test/orchestrator paths
  - desktop smoke/e2e/business/soak flows are operator-manual only and require
    `UIQ_DESKTOP_AUTOMATION_MODE=operator-manual` plus
    `UIQ_DESKTOP_AUTOMATION_REASON=<auditable reason>`
  - cleanup must stay exact-scope: a recorded positive repo-owned PID,
    recorded browser root/profile, or another repo-owned runtime record only
  - detached browser launch is operator-manual / review-required only; repo
    automation must not depend on `detached: true` + `.unref()`
