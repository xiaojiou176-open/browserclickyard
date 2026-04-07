# MCP Server

`services/mcp-server/` exposes orchestrator capabilities and controlled run
evidence through the MCP protocol. It is an adapter boundary, not the product
frontend or the main backend business surface.

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

## Gate Commands

- `pnpm mcp:check`
- `pnpm mcp:smoke`
- `pnpm mcp:test`
