# Prompt 2 Handoff

## What Landed In This Round

### Planning Artifacts

- `docs/plans/2026-03-31-enhancement-inventory.md`
- `docs/plans/2026-03-31-master-execution-plan.md`
- `docs/plans/2026-03-31-direction-decision-memo.md`
- `docs/plans/2026-03-31-prompt-2-handoff.md`

### Direction-Neutral Product Surface Fixes

- The front door now explains one operator journey:
  start in Quick Launch, track in Task Center, decide in Review Board.
- `docs/get-started.md`, `docs/why-browserclickyard.md`, `docs/proof-center.md`, and
  `docs/reference/universal-api.md` now share the same lane/truth-language.
- The app shell now exposes one route-neutral lane map across:
  - `ConsoleHeader`
  - `QuickLaunchView`
  - `OnboardingTour`
  - `HelpPanel`
  - `App` welcome notice
- Task surfaces now clarify:
  - command lane vs workflow lane,
  - more actionable loading/empty states,
  - more explicit Manual Gate action copy.
- Review Board now includes a stronger “when to use this page” explainer so it
  feels like a decision room with prerequisites instead of a broken advanced
  page.

## What Is Still Open

### Wave 0 Still Open

- `META-01` direction choice is still unresolved.
- `FND-04` deeper split of `useApiClient.ts` and
  `universal_platform_service.py` is still pending.
- `FND-05` ledger consistency guard and reconciliation diagnostics are still
  pending.
- `FND-06` fresh runtime validation pack is still pending.
- `FND-07` deployment runbook is still pending.
- `FND-08` AI/MCP truth-owner guardrails still need explicit product-surface
  wording and, if needed, tests/docs parity.

### Wave 1+ Still Open

- Manual Gate Inbox and stronger Task Center operator workflow.
- Review Board as a fuller release candidate workspace.
- Template promotion assistant and target-feasibility frontloading.
- Public-safe decision demo.
- AI Release Brief / Manual Gate Copilot / embedding-backed retrieval.
- Route-specific branding, SEO, public demo, and homepage packaging.

## Route-Dependent Items

These remain blocked on the route decision and must not be silently merged into
one fuzzy roadmap:

- `RDP-*` items in the enhancement inventory
- `STR-*` items in the enhancement inventory
- `GTM-04` homepage/SEO/distribution copy pack
- `GTM-05` hosted public demo surface

## Current Blockers

### Decision Blocker

- The user explicitly restated the original “any WebUI stress testing” vision
  after multiple rounds that pushed the repo toward a release decision plane.
- The next round should either:
  - confirm Route A,
  - confirm Route B, or
  - keep both visible while continuing only direction-neutral work.

### Verification Blockers

- `bash scripts/docs-gate.sh` currently fails for **pre-existing workspace
  pollution**, not for this round's content:
  - top-level `.serena`
  - top-level `.venv`
  - top-level `workspace`
  - generated pollution such as `apps/command-center/dist`,
    multiple `__pycache__` trees,
    `services/mcp-server/workspace/node_modules`,
    `tooling/automation/workspace/node_modules`,
    and `tests/web-harness/tests/ct/template/.cache`
- Treat these as repo-environment blockers, not regressions introduced by this
  round's patches.

## Wave Mapping For Prompt 2

### Wave 0

- direction decision
- `useApiClient.ts` / service-boundary cleanup
- ledger consistency guard
- fresh runtime validation pack
- deployment runbook
- AI/MCP truth-owner copy/contract hardening

### Wave 1

- Manual Gate Inbox
- stronger Review Board campaign workflow
- stronger Task Center-to-Review transition
- template promotion assistant
- target-feasibility frontload

### Wave 2

- AI Release Brief
- Manual Gate Copilot
- embedding-backed retrieval
- template migration advisor
- MCP role docs and higher-order review tools

### Wave 3

- Route A: release decision plane deepen
- Route B: universal WebUI stress lab realignment

### Wave 4

- route-specific hero/SEO/distribution/demo packaging

### Wave 5

- hardening, acceptance, cleanup, compatibility pruning

## Best Next Subagents To Pull First

1. `l2-reviewer`
   - blocker-only review of this round's UI/docs changes
2. `l2-implementer`
   - if continuing Wave 0: split `useApiClient.ts` / reinforce shared boundaries
3. `l2-implementer`
   - if continuing Wave 0: ledger consistency diagnostics and/or runtime
     validation pack
4. `l2-designer`
   - only after route choice, to rework hero/IA around the chosen route
5. `l2-librarian`
   - only if route-specific external positioning needs a fresh source refresh

## First Files Or Modules To Touch Next

### If Continuing Direction-Neutral Work

- `apps/command-center/src/hooks/useApiClient.ts`
- `services/api/app/services/universal_platform_service.py`
- `services/api/app/services/proof_service.py`
- `services/mcp-server/src/core/proof-campaign.ts`
- `scripts/docs-gate.sh`
- relevant diagnostics or contract checks under `scripts/ci/`

### If Route A Is Confirmed

- `apps/command-center/src/views/ReviewBoardView.tsx`
- `apps/command-center/src/views/TaskCenterView.tsx`
- `apps/command-center/src/features/manual-gates/**`
- `services/api/app/api/proof.py`
- `services/api/app/services/proof_service.py`

### If Route B Is Confirmed

- `README.md`
- `docs/why-browserclickyard.md`
- `apps/command-center/src/views/QuickLaunchView.tsx`
- `packages/orchestrator/src/commands/load.ts`
- `packages/orchestrator/src/commands/perf.ts`
- `configs/profiles/*.yaml`
- `configs/targets/*.yaml`

## Prompt 2 Starting Point

Use the enhancement inventory and direction memo as the source of truth for all
remaining route-dependent work. Do not rebuild the backlog from the archive
again unless new conflicting evidence appears.
