# Integrations

This page keeps the integration story truthful and compact.

## What Exists Today

| Surface | Truthful status | Entry point |
| --- | --- | --- |
| GitHub Pages | Live | `https://xiaojiou176-open.github.io/ui-automation-control-plane/` |
| HTTP / OpenAPI | Live, repo-native | `docs/reference/integration-entrypoints.md`, `docs/reference/universal-api.md` |
| MCP server | Live, repo-native | `pnpm mcp:start` |
| Codex / Claude Code / other MCP hosts | Supported through MCP config, not a marketplace listing | `docs/how-to/mcp-clients-setup.md` |

## What Does Not Exist Yet

| Surface | Current truth |
| --- | --- |
| npm package | Not published |
| PyPI package | Not published |
| Official plugin marketplace listing | Not published |
| Separate starter bundle distribution | Not published |

## MCP Client Setup

Use the local repo as the MCP server source of truth.

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

If you need the deeper review-oriented tools:

```json
{
  "mcpServers": {
    "uiq": {
      "command": "pnpm",
      "args": ["mcp:start"],
      "cwd": "/ABSOLUTE/PATH/TO/REPO",
      "env": {
        "UIQ_MCP_TOOL_GROUPS": "advanced,analysis,proof"
      }
    }
  }
}
```

## Truthful Wording

It is truthful to say:

- Prooflane works with Codex, Claude Code, and other MCP-capable clients
  through a repo-owned MCP server.

It is **not** truthful to say:

- there is already an official marketplace plugin
- there is already a separately distributed starter bundle
- MCP is the only supported integration path

## Canonical References

- MCP quickstart:
  [docs/how-to/mcp-quickstart-1pager.md](./docs/how-to/mcp-quickstart-1pager.md)
- MCP client setup:
  [docs/how-to/mcp-clients-setup.md](./docs/how-to/mcp-clients-setup.md)
- MCP review loop:
  [docs/how-to/mcp-agent-review-loop.md](./docs/how-to/mcp-agent-review-loop.md)
- Integration entrypoints:
  [docs/reference/integration-entrypoints.md](./docs/reference/integration-entrypoints.md)
