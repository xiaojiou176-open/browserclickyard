# MCP Server

`services/mcp-server/` exposes orchestrator capabilities and controlled run
evidence through the MCP protocol. It is an adapter boundary, not the product
frontend or the main backend business surface.

In plain language:

> this package is the companion translator booth for MCP-capable clients.
> it is not the main Prooflane exhibit and it is not a browser-extension
> product.

This package is the **publish-ready MCP artifact target** for Prooflane.
Today it still ships from the repository. It is **not** yet published to npm or
another registry.

## Tech Stack

- TypeScript
- MCP SDK
- tsx
- pnpm workspace

## Navigation

- Canonical rules: `docs/ai/agent-guide.md`
- Architecture contract: `docs/architecture.md`
- Service entrypoint: `services/mcp-server/src/server.ts`
- Tests: `services/mcp-server/tests`
- Build config: `services/mcp-server/tsconfig.build.json`

## Gate Commands

- `pnpm --filter @uiq/mcp-server build`
- `pnpm mcp:check`
- `pnpm mcp:smoke`
- `pnpm mcp:test`

## Package Truth

- Package name: `@uiq/mcp-server`
- Binary name: `prooflane-mcp`
- Protocol today: **stdio**
- Auth model today: local stdio startup does not use OAuth; protected HTTP/API
  surfaces keep the existing token/header contract

## Local Start Today

```bash
pnpm mcp:start
```

## Minimal Client Config

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

## Publish-Ready Shape (Not Published Yet)

Once this package is actually published, the intended entry shape is:

```bash
npx -y @uiq/mcp-server
```

or:

```bash
pnpm dlx @uiq/mcp-server
```

That command shape is **ready**, but it is not truthful to claim it is already
published today. The package keeps the scoped name `@uiq/mcp-server` in this
pass, while the bin inside it remains `prooflane-mcp`.
