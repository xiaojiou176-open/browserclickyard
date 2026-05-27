# Wave 2 Delivery Note

## Scope

This round deepened the existing AI and MCP surfaces without creating a second
truth owner.

The chosen Wave 2 slice was:

- AI Release Brief v2
- minimal similar-failure retrieval over governed evidence
- stronger Manual Gate copilot guidance
- higher-level MCP tools/resources over existing backend truth
- role-based MCP docs

## What Changed

### Backend Proof And Retrieval

- `services/api/app/models/proof.py`
- `services/api/app/api/proof.py`
- `services/api/app/services/proof_service.py`
- `services/api/tests/test_proof_api.py`

New backend-backed surfaces:

- `GET /api/proof/runs/{run_id}/release-brief`
- `GET /api/proof/runs/{run_id}/similar-failures`

What these do:

- summarize governed evidence into a release brief
- keep AI in a summary/interpretation role
- rank similar historical failures from existing run artifacts

### Command Center Product Surface

- `apps/command-center/src/hooks/useProofApi.ts`
- `apps/command-center/src/hooks/useProofApi.test.tsx`
- `apps/command-center/src/types.ts`
- `apps/command-center/src/views/ReviewBoardView.tsx`
- `apps/command-center/src/views/ReviewBoardView.test.tsx`
- `apps/command-center/src/features/manual-gates/ManualGateDesk.tsx`
- `apps/command-center/src/views/TaskCenterView.tsx`
- `apps/command-center/src/views/TaskCenterView.a11y.test.tsx`
- `apps/command-center/src/views/TaskCenterView.waiting-state.test.tsx`

What changed in plain language:

- Review Board now reads a backend `AI release brief` instead of relying only
  on local UI heuristics.
- Review Board can now look up similar past failure cases from governed
  artifacts.
- Manual Gate now has a clearer copilot-style checklist layer that explains the
  current pause and recommended next step.

### MCP Surface

- `services/mcp-server/src/core/types.ts`
- `services/mcp-server/src/core/registry.ts`
- `services/mcp-server/src/tools/register-tools/register-run-tools.ts`
- `services/mcp-server/src/tools/register-tools/register-resources.ts`
- `services/mcp-server/tests/helpers/stub-backend.ts`
- `services/mcp-server/tests/helpers/mcp-client.ts`
- `services/mcp-server/tests/mcp-smoke.test.ts`
- `services/mcp-server/tests/mcp-success.test.ts`

New or strengthened MCP capabilities:

- `uiq_read_run_ai_review`
- `uiq_generate_release_brief`
- `uiq_find_similar_failures`
- `uiq_explain_template_feasibility`
- `uiq_list_manual_gates`
- `uiq://review/latest-release-brief`
- `uiq://manual-gates/inbox-summary`

### MCP Docs

- `docs/mcp.md`
- `docs/how-to/mcp-clients-setup.md`
- `docs/how-to/mcp-quickstart-1pager.md`
- `docs/index.md`

What changed:

- role-based reading paths for operators, agents, and release reviewers
- Wave 2 quickstart sequences
- new tool/resource inventory
- explicit approval/truth-owner policy wording

## Why These Changes Came First

These changes were chosen because they increase the value of the current
release-review product line without changing the route decision:

- AI is now more usable as a decision-support layer.
- MCP is now more useful as an agent-ready workspace entrypoint.
- retrieval is tied to existing governed evidence, not a new AI side system.

## What This Round Did Not Try To Do

- It did not turn AI into the final truth owner.
- It did not create a new vector store or retrieval ledger.
- It did not expand into stress-lab route packaging.
- It did not attempt hosted demo or broad branding work.

## Evidence

- frontend targeted vitest: pass
- backend proof API test: pass
- MCP registry/doc-contract tests: pass
- MCP harness tests: blocked by current local SDK/Ajv client initialization issue
