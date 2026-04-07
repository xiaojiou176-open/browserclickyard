# How-To: MCP Client Setup

## Prerequisites

- Run from repo root.
- `pnpm install` completed.
- MCP-capable client enabled.

This setup works with MCP-capable clients such as **Codex**, **Claude Code**,
or any other MCP host that can launch a stdio server. That is a protocol
compatibility statement, not a partnership claim.

## Default Behavior: Core 12

By default the server exposes only the 12 core tools below. No extra env is required:

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

## Enable Optional Tool Groups

Use `UIQ_MCP_TOOL_GROUPS` to enable optional groups on demand: `advanced/register/proof/analysis`.

```bash
# Example: enable only register + proof
UIQ_MCP_TOOL_GROUPS=register,proof

# Example: enable every optional group
UIQ_MCP_TOOL_GROUPS=all
```

Legacy compatibility switches are still accepted:

- `UIQ_MCP_EXPOSE_ADVANCED_TOOLS=true`
- `UIQ_MCP_ENABLE_ADVANCED_TOOLS=true`

Either legacy switch enables every optional group.

## MCP Config Template

```json
{
  "mcpServers": {
    "uiq": {
      "command": "pnpm",
      "args": ["mcp:start"],
      "cwd": "/ABSOLUTE/PATH/TO/REPO",
      "env": {
        "UIQ_MCP_TOOL_GROUPS": "advanced,analysis"
      }
    }
  }
}
```

## Full Registered Tool Inventory (40)

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

## Role-Based Starting Paths

### Operator

Use this path when you need to run work, inspect the current manual-gate inbox,
and read a release summary without inventing a second truth surface.

1. `uiq_server_selfcheck`
2. `uiq_run_profile` or `uiq_run_stream`
3. `uiq_run_overview`
4. `uiq_list_manual_gates`
5. `uiq_generate_release_brief`

### Agent / MCP Client

Use this path when an agent needs governed read context before proposing the
next action.

1. `uiq_catalog`
2. `uiq_read_run_ai_review`
3. `uiq_generate_release_brief`
4. `uiq_find_similar_failures`
5. `uiq_explain_template_feasibility`

## Recommended MCP Review Loop

Use this loop when a Codex session, Claude Code session, or another MCP-capable
client needs to understand the latest result without turning Prooflane into a
generic chat tool:

1. `uiq_run_overview`
2. `uiq_generate_release_brief`
3. `uiq_find_similar_failures`
4. `uiq_list_manual_gates`
5. `uiq_explain_template_feasibility`

Why this loop is truthful:

- `uiq_generate_release_brief` is a read-only summary over governed evidence
- `uiq_find_similar_failures` reuses historical failure artifacts instead of
  inventing a second memory system
- `uiq_list_manual_gates` and `uiq://manual-gates/inbox-summary` expose the
  same paused-run context shown in Runs & Blocks
- `uiq_explain_template_feasibility` exposes the same migration hints that the
  UI now surfaces in Advanced Review

### Release Reviewer

Use this path when you want to compare existing governed evidence and inspect
why a candidate is blocked, ready, or still missing proof.

1. `uiq_run_proof_campaign`
2. `uiq_read_proof_report`
3. `uiq_diff_proof_campaign`
4. `uiq_generate_release_brief`
5. `uiq_compare_perf`

## Suggested Operating Sequence

1. `uiq_server_selfcheck`
2. `uiq_catalog`
3. `uiq_run_profile` or `uiq_run_stream`
4. `uiq_run_overview`
5. `uiq_gate_failures` (if not passed)
6. `uiq_read_artifact`

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

## Resources

- `uiq://runs/latest/manifest`
- `uiq://runs/latest/summary`
- `uiq://review/latest-release-brief`
- `uiq://manual-gates/inbox-summary`
