# MCP Server

## Start

```bash
pnpm mcp:start
```

Server entrypoint: `services/mcp-server/src/server.ts` (stdio transport).

Default backend note:

- MCP defaults to the managed backend lane at `http://127.0.0.1:18080`.
- If you want MCP to attach to the local `./scripts/dev-up.sh` stack instead,
  set `UIQ_MCP_API_BASE_URL=http://127.0.0.1:17380`.

## Builder Entry

If you are deciding whether to integrate through MCP or HTTP, read
[docs/reference/integration-entrypoints.md](./reference/integration-entrypoints.md)
first.

Short version:

- use **MCP** when the caller is an agent or copilot
- use **HTTP/OpenAPI** when the caller is a builder, service, or CLI that wants
  a portable contract
- use frontend hooks only as first-party examples inside this repo

## Run Lane Map

- `uiq_api_runs` talks to the workflow `/api/runs` lane.
- `uiq_api_automation_run` talks to the automation command
  `/api/automation/run` lane.
- `uiq_run_profile` and `uiq_run_stream` invoke the governed
  `pnpm uiq run --profile ... --target ...` lane.

These tools are related, but they do not share a single execution ledger or a
single output contract.

Proof/review ownership note:

- Proof campaigns, run compare, AI review projection, and template feasibility
  now belong to the backend proof domain (`/api/proof/*`).
- MCP exposes them as tools, but it is no longer the primary truth owner for
  those decision surfaces.

## What MCP Is And Is Not

MCP is a real adapter layer in this repo.

That means:

- it is implemented
- it is tested
- it exposes real tools/resources over the existing runtime

It does **not** mean:

- MCP is the canonical truth owner
- MCP is the only integration path
- MCP becomes a write-capable governance platform for approvals or policy overrides

Think of it like a translator booth at a conference:

- the booth is real
- the booth helps people join the same conversation
- the booth does not become the law being discussed

## Default Tool Surface (Core 12)

Only the 12 core tools are exposed by default:

1. `uiq_backend_runtime`
2. `uiq_api_sessions`
3. `uiq_api_flows`
4. `uiq_api_templates`
5. `uiq_api_runs`
6. `uiq_catalog`
7. `uiq_server_selfcheck`
8. `uiq_run_profile`
9. `uiq_run_stream`
10. `uiq_run_overview`
11. `uiq_read_artifact`
12. `uiq_gate_failures`

## Optional Tool Groups

Enable optional groups only when needed: `advanced/register/proof/analysis`.

```bash
# analysis + proof only
UIQ_MCP_TOOL_GROUPS=analysis,proof

# all optional groups
UIQ_MCP_TOOL_GROUPS=all
```

Legacy compatibility: `UIQ_MCP_EXPOSE_ADVANCED_TOOLS=true` or `UIQ_MCP_ENABLE_ADVANCED_TOOLS=true` enables every optional group.

## Full Registered Tool Inventory (40)

Wave 2 note:

- Release-review and manual-gate helpers stay in the MCP adapter layer.
- They summarize backend truth and governed artifacts; they do not become a new
  proof owner.

1. `uiq_a11y_top`
2. `uiq_api_automation_cancel`
3. `uiq_api_automation_commands`
4. `uiq_api_automation_run`
5. `uiq_api_automation_task`
6. `uiq_api_automation_tasks`
7. `uiq_api_flows`
8. `uiq_api_runs`
9. `uiq_api_sessions`
10. `uiq_api_templates`
11. `uiq_backend_runtime`
12. `uiq_catalog`
13. `uiq_compare_perf`
14. `uiq_computer_use_run`
15. `uiq_diff_proof_campaign`
16. `uiq_export_proof_bundle`
17. `uiq_gate_failures`
18. `uiq_list_runs`
19. `uiq_model_target_capabilities`
20. `uiq_perf_metrics`
21. `uiq_read_artifact`
22. `uiq_read_manifest`
23. `uiq_read_proof_report`
24. `uiq_read_repo_doc`
25. `uiq_register_orchestrate`
26. `uiq_register_state`
27. `uiq_run_command`
28. `uiq_run_overview`
29. `uiq_run_profile`
30. `uiq_run_proof_campaign`
31. `uiq_run_stream`
32. `uiq_security_summary`
33. `uiq_server_selfcheck`
34. `uiq_summarize_failures`
35. `uiq_visual_status`
36. `uiq_read_run_ai_review`
37. `uiq_generate_release_brief`
38. `uiq_find_similar_failures`
39. `uiq_explain_template_feasibility`
40. `uiq_list_manual_gates`

## Role Paths

### Operator Path

Use this path when you need to inspect status, clear manual blockers, and read
release summaries without leaving the governed runtime.

1. `uiq_server_selfcheck`
2. `uiq_run_profile` or `uiq_run_stream`
3. `uiq_run_overview`
4. `uiq_list_manual_gates`
5. `uiq_generate_release_brief`

### Agent Path

Use this path when an MCP-capable agent needs read-mostly context before asking
for any sensitive action.

1. `uiq_catalog`
2. `uiq_read_artifact`
3. `uiq_read_run_ai_review`
4. `uiq_generate_release_brief`
5. `uiq_find_similar_failures`

Builder note:

- this is the best current path for agent users
- it is not a promise that every future builder integration should go through
  MCP instead of HTTP

### Release Reviewer Path

Use this path when the job is to compare governed evidence and decide whether a
candidate is ready for a human decision.

1. `uiq_run_proof_campaign`
2. `uiq_read_proof_report`
3. `uiq_diff_proof_campaign`
4. `uiq_generate_release_brief`
5. `uiq_explain_template_feasibility`

## Recommended Sequence

1. `uiq_server_selfcheck`
2. `uiq_catalog`
3. `uiq_run_profile` or `uiq_run_stream`
4. `uiq_run_overview`
5. `uiq_gate_failures` (when a gate is not passing)
6. `uiq_read_artifact`

For decision-plane workflows:

1. `uiq_run_proof_campaign`
2. `uiq_read_proof_report`
3. `uiq_diff_proof_campaign`
4. `uiq_compare_perf`
5. `uiq_generate_release_brief`
6. `uiq_list_manual_gates`
7. `uiq_find_similar_failures`

## Approval And Truth-Owner Policy

- **Resources are read-only context**. Use them to inspect the latest governed
  brief or the current manual-gate inbox summary.
- **Tools request actions or summaries**. Even when a tool only summarizes
  existing evidence, it still stays in the adapter layer and must not become a
  new truth owner.
- **Manual gate approval remains human-owned**. A tool may list or explain
  manual gates, but high-risk continuation should still require explicit
  approval in the backend truth surface.
- **Tool annotations and descriptions are guidance, not enforcement**. Actual
  safety still depends on allowlists, approval policy, logging, access control,
  and governed execution.

## Later / No-Go

### Later

- broader builder kits on top of MCP
- clearer packaging for role-specific agent bundles
- possible future SDK alignment between OpenAPI and MCP-facing helper layers

### No-go for current claims

- do not call MCP the public SDK
- do not call MCP the primary proof owner
- do not promise write-capable MCP approval flows
- do not describe optional tool groups as stable forever across future releases

## run override fields accepted (runOverrideSchema)

- `baseUrl`
- `app`
- `bundleId`
- `diagnosticsMaxItems`
- `exploreBudgetSeconds`
- `exploreMaxDepth`
- `exploreMaxStates`
- `chaosSeed`
- `chaosBudgetSeconds`
- `chaosClickRatio`
- `chaosInputRatio`
- `chaosScrollRatio`
- `chaosKeyboardRatio`
- `loadVus`
- `loadDurationSeconds`
- `loadRequestTimeoutMs`
- `loadEngine`
- `a11yMaxIssues`
- `a11yEngine`
- `perfPreset`
- `perfEngine`
- `visualMode`
- `soakDurationSeconds`
- `soakIntervalSeconds`
- `autostartTarget`

## Legacy Fields (Not in run override)

Legacy fields `browser/platform/device/headless/timeout/env` are intentionally excluded.

## URL Policy Boundary

Use CLI-side explicit opt-in when URL policy must be opened: `allowAllUrls=true`.
MCP run override input does not expose `allowAllUrls` to callers.

## Resources

- `uiq://runs/latest/manifest`
- `uiq://runs/latest/summary`
- `uiq://review/latest-release-brief`
- `uiq://manual-gates/inbox-summary`
