# Integrations

This page keeps the integration story truthful and compact.

## What Exists Today

| Surface | Truthful status | Entry point |
| --- | --- | --- |
| GitHub Pages | Live | `https://xiaojiou176-open.github.io/pagestress/` |
| HTTP / OpenAPI | Live, repo-native | `docs/reference/integration-entrypoints.md`, `docs/reference/universal-api.md` |
| MCP server | Live, repo-native | `pnpm mcp:start` |
| MCP package shape | Publish-ready, not published | `@uiq/mcp-server` -> `pagestress-mcp` |
| Codex / Claude Code / other MCP hosts | Supported through MCP config, not a marketplace listing | `docs/how-to/mcp-clients-setup.md` |
| Companion skill packet | ClawHub live; OpenHands review-pending | `docs/skills/pagestress-mcp/SKILL.md` |

## What Does Not Exist Yet

| Surface | Current truth |
| --- | --- |
| npm package | Not published |
| PyPI package | Not published |
| Official plugin marketplace listing | Not published |
| Additional public Skills marketplace listings beyond the companion ClawHub packet | Not published |
| Public Docker image | Not published |
| Separate starter bundle distribution | Not published |

## MCP Transport And Auth Truth

- Publish-ready MCP package target: `@uiq/mcp-server`
- Planned CLI / bin name: `pagestress-mcp`
- MCP transport today: **stdio only**
- Auth boundary today: local stdio startup does **not** use OAuth; protected
  HTTP/API and automation surfaces keep the existing token/header contract

## MCP Client Setup

### Repo-native today

Use the local repo as the MCP server source of truth.

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

That package command shape is **ready**, but it is **not published yet**. The
package keeps the scoped name `@uiq/mcp-server` in this pass, while the bin
inside it remains `pagestress-mcp`.

## Truthful Wording

It is truthful to say:

- Pagestress works with Codex, Claude Code, OpenClaw, and other MCP-capable
  clients through a repo-owned MCP server.
- The publish-ready MCP artifact target is `@uiq/mcp-server`.
- The planned CLI name is `pagestress-mcp`.
- MCP today means **stdio**, not SSE or Streamable HTTP.

It is **not** truthful to say:

- there is already an official marketplace plugin
- there is already a published `pagestress-mcp` package
- there is already a separately distributed starter bundle
- there is already a public Docker image
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
