# Prompt 4 Handoff

## What Prompt 3 Delivered

### Prompt 2 Was Properly Inherited

- Prompt 2 handoff, delivery note, product surface note, and Wave 1 changes
  were read and reused.
- Wave 2 work stayed on the current mainline rather than reopening the route
  debate.

### Newly Landed In Prompt 3

- backend `release-brief` projection
- backend `similar-failures` retrieval over governed run evidence
- frontend Review Board now consumes those two Wave 2 surfaces
- Manual Gate now exposes a clearer copilot/checklist layer
- MCP now exposes new Wave 2 tools/resources:
  - `uiq_read_run_ai_review`
  - `uiq_generate_release_brief`
  - `uiq_find_similar_failures`
  - `uiq_explain_template_feasibility`
  - `uiq_list_manual_gates`
  - `uiq://review/latest-release-brief`
  - `uiq://manual-gates/inbox-summary`
- MCP docs now have role-based reading paths
- Wave 2 delivery note and AI/MCP surface note now exist

## What Is Still Open

### Wave 2 Still Open

- richer AI review grouping/severity/category presentation
- deeper Manual Gate inbox/workbench UX
- stronger frontend use of retrieval results
- feasibility/frontload integration closer to the run-start path
- deeper MCP harness verification in the current local environment

### Verification And Environment Blockers

- `docs-gate` still fails on pre-existing root/workspace pollution:
  - `.venv`
  - `workspace`
  - existing runtime outputs in the repo tree
- MCP harness tests are currently blocked by a local MCP SDK/Ajv client
  initialization error:
  - `Cannot read properties of undefined (reading 'code')`
  - seen in `mcp-smoke`, `mcp-success`, and `mcp-description-contract`
- registry and docs contract tests pass, so the current blocker is not “tool
  names drifted”; it is a lower-level local harness issue

## Best Next Moves

1. **Prompt 4 should start the original-vision realignment discussion**
   - decide whether Route B gets promoted now, or whether Route A continues
     longer
2. **If Wave 2 continues first**
   - deepen Manual Gate inbox
   - deepen Review Board release candidate workflow
   - make retrieval more actionable in the UI
3. **If Prompt 4 pivots to Route B**
   - keep the Wave 2 AI/MCP surfaces as supporting capabilities only
   - do not let them dominate the stress-lab homepage story

## Pull These Subagents First In Prompt 4

1. `l2-explorer`
   - map Route B surfaces that still exist in code (`load/perf/explore/chaos`, targets, reports)
2. `l2-librarian`
   - refresh stress-lab product and IA comparables only if needed
3. `l2-designer`
   - design the first Route B front door without destroying the current operator shell
4. `l2-implementer`
   - frontend/product worker for Route B surface or continued Wave 2 UI depth
5. `l2-implementer`
   - backend/contract worker for Route B data surfaces or MCP harness fix
6. `l2-reviewer`
   - blocker-only review before closeout

## Touch These Files First In Prompt 4

### If Continuing Wave 2 Depth

- `apps/command-center/src/views/ReviewBoardView.tsx`
- `apps/command-center/src/features/manual-gates/ManualGateDesk.tsx`
- `services/api/app/services/proof_service.py`
- `services/mcp-server/src/tools/register-tools/register-run-tools.ts`
- `services/mcp-server/src/tools/register-tools/register-resources.ts`

### If Starting Route B Realignment

- `README.md`
- `docs/why-prooflane.md`
- `apps/command-center/src/views/QuickLaunchView.tsx`
- `packages/orchestrator/src/commands/load.ts`
- `packages/orchestrator/src/commands/perf.ts`
- `configs/profiles/*.yaml`
- `configs/targets/*.yaml`

## Do Not Rebuild Again

- enhancement inventory
- master execution plan
- direction decision memo
- Wave 1 delivery note
- product surface note

Use them as the planning base for Prompt 4.
