# How-To: MCP Agent Review Loop

Use this page when you want to connect **Codex**, **Claude Code**, or another
**MCP-capable client** to Prooflane's deeper review layer without turning the
product into a generic chat assistant.

## What This Integration Is

- a read-mostly MCP workflow over the same runtime the UI already uses
- a way to inspect release briefs, similar failures, manual-gate context, and
  template feasibility from an MCP-capable client
- a truthful protocol story for Codex, Claude Code, or another MCP host

## What This Integration Is Not

- not an official partnership claim
- not a hosted SaaS copilot
- not a write-capable approval channel for risky release decisions
- not a replacement for Stress Lab, Runs & Blocks, or Advanced Review

## Best Fit

Use this loop after a result already exists.

Think of it like asking a well-prepared operator to hand you the clipboard,
not like opening a second control room.

Prooflane still starts from:

1. **Stress Lab** for the target and experiment mode
2. **Runs & Blocks** for the latest result and manual-gate state
3. **Advanced Review** for governed comparison

MCP comes in after that result path exists.

## The Fast Review Loop

1. `uiq_run_overview`
2. `uiq_generate_release_brief`
3. `uiq_find_similar_failures`
4. `uiq_list_manual_gates`
5. `uiq_explain_template_feasibility`

What this gives you in plain English:

- `uiq_run_overview` tells the client what run it is looking at
- `uiq_generate_release_brief` drafts the same governed summary the UI exposes
- `uiq_find_similar_failures` finds historical failure cases that resemble the
  current run
- `uiq_list_manual_gates` shows whether a paused run still needs operator help
- `uiq_explain_template_feasibility` explains whether a reusable journey is a
  good fit for another target family
- The Command Center now drafts a copy-ready **agent handoff prompt** in
  Advanced Review, so a human operator can paste the same governed run context
  into Codex, Claude Code, or another MCP-capable client without rewriting the
  brief manually.

## Why This Is A Truthful Claim

These capabilities are backed by repo-owned surfaces today:

- ReviewBoard loads an **AI release brief** and **similar failures**
- Runs & Blocks exposes a **Manual Gate inbox** and **report surface**
- MCP registers:
  - `uiq_generate_release_brief`
  - `uiq_find_similar_failures`
  - `uiq_list_manual_gates`
  - `uiq_explain_template_feasibility`
- MCP resources expose:
  - `uiq://review/latest-release-brief`
  - `uiq://manual-gates/inbox-summary`

So the truthful statement is:

> Prooflane works with Codex, Claude Code, and other MCP-capable clients
> through a governed, read-mostly MCP surface.

That is very different from claiming a native chat product or a hosted AI
assistant.

## Minimal MCP Config Reminder

```json
{
  "mcpServers": {
    "uiq": {
      "command": "pnpm",
      "args": ["mcp:start"],
      "cwd": "/ABSOLUTE/PATH/TO/REPO"
    }
  }
}
```

If you want the optional review-oriented tool groups, add:

```json
{
  "UIQ_MCP_TOOL_GROUPS": "advanced,analysis,proof"
}
```

## Where To Go Next

- Setup details: [docs/how-to/mcp-clients-setup.md](./mcp-clients-setup.md)
- Fast command path: [docs/how-to/mcp-quickstart-1pager.md](./mcp-quickstart-1pager.md)
- Full tool contract: [docs/mcp.md](../mcp.md)
- Product front door: [README.md](../../README.md)
