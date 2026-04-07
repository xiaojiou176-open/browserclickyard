# Prompt 3 Handoff

## What Prompt 2 Actually Delivered

### Reused From Prompt 1

- enhancement inventory
- master execution plan
- direction decision memo
- Prompt 2 handoff

### Newly Productized In Prompt 2

- one operator journey across docs and the app
- stronger first-use lane explanation
- clearer command lane vs workflow lane semantics
- stronger Manual Gate action wording
- stronger Review Board role framing
- first AI release brief summary layer
- Wave 1 delivery note
- product surface note

## Wave 1 Status

### Completed

- lane clarity and first-use map
- Task Center wording cleanup
- Manual Gate wording cleanup
- Review Board explanatory entry state
- AI release brief v1
- docs/API wording alignment for these surfaces

### Still Open In Wave 1

- fuller Review Board release-candidate workflow
- Manual Gate Inbox beyond the current summary layer
- template-promotion assistant
- target-feasibility frontload in primary run-start flow
- deeper runtime/E2E validation of the new operator journey

## Best Next Product Moves

1. strengthen Review Board as a true release candidate workspace
2. deepen Manual Gate into a clearer inbox/workbench
3. add richer AI review grouping/severity/recommendation structure
4. frontload target feasibility where the user starts runs
5. add runtime validation for the whole path:
   Quick Launch -> Task Center -> Manual Gate / Review Board

## Best Next Technical Moves

- split `apps/command-center/src/hooks/useApiClient.ts`
- reinforce `services/api/app/services/universal_platform_service.py` boundaries
- add ledger consistency diagnostics/tests
- build a fresh runtime validation pack that covers:
  - Review Board
  - Manual Gate
  - MCP/backend switching

## Route-Dependent Work Still Deferred

- Route A packaging:
  - release-decision-plane hero/SEO/demo
  - stronger Review Board-first public positioning
- Route B packaging:
  - URL-first entry
  - stress/load/synthetic/resilience-first homepage
  - stress-lab report center

## Current Blockers

- docs-gate still fails on pre-existing root/workspace pollution:
  - `.venv`
  - `workspace`
  - multiple runtime outputs already sitting in the repo tree
- no fresh runtime/E2E proof yet for the new operator journey wording

## Pull These Subagents First In Prompt 3

1. `l2-explorer`
   - inspect current Review Board gaps and primary workflow entry points
2. `l2-explorer`
   - inspect Manual Gate / Task Center / validation gaps
3. `l2-designer`
   - shape Review Board v2 and Manual Gate inbox v2 after reading the new
     product-surface note
4. `l2-implementer`
   - one frontend product-surface worker
5. `l2-implementer`
   - one shared-boundary / validation worker
6. `l2-reviewer`
   - blocker-only review before closeout

## Touch These Files First In Prompt 3

- `apps/command-center/src/views/ReviewBoardView.tsx`
- `apps/command-center/src/hooks/useProofApi.ts`
- `apps/command-center/src/views/TaskCenterView.tsx`
- `apps/command-center/src/features/manual-gates/ManualGateDesk.tsx`
- `apps/command-center/src/hooks/useApiClient.ts`
- `services/api/app/services/proof_service.py`
- `services/api/app/services/universal_platform_service.py`
- relevant tests under `apps/command-center/src/views/*.test.tsx`

## Do Not Rebuild These Again

- the archive-derived enhancement inventory
- the master execution plan
- the direction decision memo

Use them as the planning base unless a new conflicting direction is explicitly
introduced.
