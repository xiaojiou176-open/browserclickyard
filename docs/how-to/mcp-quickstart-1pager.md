# MCP Quickstart (1 Pager)

## Use This Page For

- Fast execution when you do not want to bounce between MCP docs.
- A clear default path plus failure branches.
- Getting to a result first, then drilling into advanced/internal docs.
- Running the same read-mostly loop from Codex, Claude Code, or another
  MCP-capable client without pretending Pagestress is a generic assistant.

## Installation Truth

- Repo-native start today: `pnpm mcp:start`
- Publish-ready package target: `@uiq/mcp-server`
- Planned CLI / bin name: `pagestress-mcp`
- Protocol today: **stdio only**
- Local stdio startup does **not** use OAuth
- `npx -y @uiq/mcp-server` / `pnpm dlx @uiq/mcp-server` is the truthful
  package-launch shape, but it is **not published yet**

## Layering Map

- Default: this page + the standard path in `docs/how-to/mcp-clients-setup.md`.
- Advanced: quality analysis, automation APIs, and proof campaigns.
- Internal: the full tool inventory and `runOverrideSchema` contract in `docs/mcp.md`.

## Core 12 Tools (Recommended Working Set)

1. `uiq_server_selfcheck`
2. `uiq_catalog`
3. `uiq_backend_runtime`
4. `uiq_api_sessions`
5. `uiq_api_flows`
6. `uiq_api_templates`
7. `uiq_api_runs`
8. `uiq_run_profile`
9. `uiq_run_stream`
10. `uiq_run_overview`
11. `uiq_read_artifact`
12. `uiq_gate_failures`

## Run Lane Map

- `uiq_api_runs` = workflow `/api/runs` lane
- `uiq_api_automation_run` = automation command `/api/automation/run` lane
- `uiq_run_profile` / `uiq_run_stream` = governed `pnpm uiq run` lane

Treat these as separate surfaces. They are connected, but they are not the same
run contract.

## Typical Call Chains

### 1) Default Deep-Load (Most Common)

`uiq_server_selfcheck -> uiq_run_profile -> uiq_run_stream -> uiq_run_overview -> uiq_read_artifact`

### 2) Manual Breakdown (Need Fine Control)

`uiq_backend_runtime -> uiq_server_selfcheck -> uiq_run_stream -> uiq_run_overview -> uiq_read_artifact`

### 3) Quality Loop (Audit + Autofix + Rerun)

`uiq_run_stream -> uiq_run_overview -> uiq_gate_failures -> uiq_read_manifest`

### 4) Release Review Loop (Wave 2)

`uiq_run_proof_campaign -> uiq_generate_release_brief -> uiq_read_run_ai_review -> uiq_find_similar_failures`

### 5) Manual Gate Triage Loop (Wave 2)

`uiq_run_overview -> uiq_list_manual_gates -> uiq://manual-gates/inbox-summary`

### 6) Codex / Claude Code Review Loop

`uiq_run_overview -> uiq_generate_release_brief -> uiq_find_similar_failures -> uiq_list_manual_gates -> uiq_explain_template_feasibility`

Use this when an MCP-capable client needs a fast answer to:

- What happened in the latest run?
- Is there a similar historical failure?
- Is a paused run waiting on a manual gate?
- Will this reusable journey drift when it moves to another target family?

## Failure Branches (Fast Decision)

- If `uiq_server_selfcheck` fails:
  - Stop run pipeline.
  - Fix runtime/services/api/token wiring.
  - Re-run `uiq_server_selfcheck`.
- If `uiq_run_overview.gateStatus != "passed"`:
  - Call `uiq_gate_failures`.
  - Read evidence via `uiq_read_artifact` (from failed check paths).
  - Optional deep drill with `uiq_read_manifest`.
- If artifact path is unclear:
  - Use `uiq_run_overview` first to confirm current/last run context.
  - If you enabled `advanced` group, use `uiq_list_runs` + `uiq_read_manifest` for deep trace.
- If run behavior needs stronger control:
  - Switch to manual chain (`uiq_run_profile -> uiq_run_stream -> uiq_run_overview`).

## Minimal Inputs To Remember

- Default env (client side):
  - `UIQ_MCP_PERFECT_MODE=true`
- Backend lane:
  - `UIQ_MCP_API_BASE_URL=http://127.0.0.1:18080`
- Optional groups (only when needed):
  - `UIQ_MCP_TOOL_GROUPS=advanced,register,proof,analysis`
- Provider policy: Gemini-only.

## Minimal Config Seed

### Repo-native today

```json
{
  "mcpServers": {
    "uiq": {
      "command": "pnpm",
      "args": ["mcp:start"],
      "cwd": "/ABSOLUTE/PATH/TO/REPO",
      "env": {
        "UIQ_MCP_API_BASE_URL": "http://127.0.0.1:18080",
        "UIQ_MCP_TOOL_GROUPS": "advanced,analysis,proof"
      }
    }
  }
}
```

### Publish-ready package shape (not live yet)

```json
{
  "mcpServers": {
    "uiq": {
      "command": "npx",
      "args": ["-y", "@uiq/mcp-server"],
      "env": {
        "UIQ_MCP_API_BASE_URL": "http://127.0.0.1:18080",
        "UIQ_MCP_TOOL_GROUPS": "advanced,analysis,proof"
      }
    }
  }
}
```

## Next Docs

- Agent loop walkthrough: `docs/how-to/mcp-agent-review-loop.md`
- Setup details: `docs/how-to/mcp-clients-setup.md`
- Contract details: `docs/mcp.md`
