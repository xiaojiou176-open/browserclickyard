# Integration Entry Points

This page is the public builder map for Pagestress.

Use it when you need a direct answer to three practical questions:

1. **Where do I integrate today?**
2. **Which surfaces are real and supported enough to build on now?**
3. **Which pieces are later, internal-only, or intentionally not promised yet?**

Think of it like an airport signboard:

- **HTTP/OpenAPI** is the public road network.
- **MCP** is the agent adapter terminal.
- **frontend hooks** are the current in-app plumbing, not a public SDK shelf.
- **generated client code** is a test-harness workbench, not a polished external starter kit.

## The Four Real Entry Paths Today

| Entry path | What it is for today | Current truth | Good fit |
| --- | --- | --- | --- |
| `contracts/openapi/api.yaml` + HTTP | Direct service, CLI, or builder integration | Canonical API contract | Builders who want the most portable and explicit path |
| `pnpm mcp:start` | Agent-facing adapter over existing ledgers and governed artifacts | Real MCP server with stdio transport and read-mostly review/runtime tools; publish-ready package target is `@uiq/mcp-server` with planned `pagestress-mcp` CLI shape | MCP-capable agents and operator copilots |
| `apps/command-center/src/hooks/useApiClient.ts` + `useProofApi.ts` | First-party frontend wiring | Real internal client layer used by the product UI | Repo contributors who want examples of current fetch/header patterns |
| `tests/web-harness/src/api-gen/**` | Generated fetch wrappers for shared harness/test surfaces | Real generated code, but scoped to the web harness and selected API families | Contributors extending tests, mocks, or contract checks inside this repo |

## Recommended Path By Job

### If you are building an external integration

Start from:

- `contracts/openapi/api.yaml`
- [Universal Platform API](./universal-api.md)

Why:

- OpenAPI is the canonical HTTP truth.
- It is the easiest path to port across languages and runtimes.
- It keeps you off internal frontend wiring that may change for product reasons.

### If you are connecting an agent

Start from:

- `pnpm mcp:start`
- [MCP Server](../mcp.md)

Why:

- MCP already exposes a real adapter layer.
- It is the cleanest path for agents that need runtime, artifact, proof, or review context.
- It avoids scraping UI screens or reverse-engineering product state.

Packaging truth:

- repo-native entry today: `pnpm mcp:start`
- publish-ready artifact target: `@uiq/mcp-server`
- planned CLI / bin name: `pagestress-mcp`
- protocol today: **stdio only**
- local stdio startup does **not** use OAuth
- the package command shape is documented, but **not published yet**

Search-friendly but still truthful phrasing:

- Pagestress can act as an **MCP server for coding agents** such as Codex,
  Claude Code, or any other MCP-capable client.
- That is a protocol-compatibility statement about the adapter surface, not an
  official partnership claim.

### If you are contributing inside this repo

Use these as examples, not as a public dependency contract:

- `apps/command-center/src/hooks/useApiClient.ts`
- `apps/command-center/src/hooks/useProofApi.ts`

Why:

- They show how the first-party app currently builds URLs, headers, and fetch calls.
- They are closer to “the house plumbing” than “the public faucet”.

### If you need generated TypeScript helpers today

Use:

- `pnpm contracts:generate`
- `tests/web-harness/src/api-gen/client.ts`

But use them with the right expectation:

- this is a **generated harness client**
- not a **versioned Pagestress SDK**

## Current Generated Client Reality

The generated client path exists, but it is intentionally narrower than the full OpenAPI surface.

Today `contracts/scripts/generate-client.ts` writes generated files under:

- `tests/web-harness/src/api-gen/core/request.ts`
- `tests/web-harness/src/api-gen/api/health.ts`
- `tests/web-harness/src/api-gen/api/automation.ts`
- `tests/web-harness/src/api-gen/api/command-tower.ts`
- `tests/web-harness/src/api-gen/client.ts`

That means:

- the generator is **real**
- the generated fetch core is **real**
- the output is **currently harness-scoped**
- the output does **not** yet cover the entire HTTP surface such as proof, templates, or workflow runs

So the honest sentence is:

> Pagestress has a real OpenAPI contract and a real generated harness client, but it does **not** yet ship a full public SDK package.

## Shared Types: What Exists And What Does Not

Current type layers are real, but they are not one public SDK package yet.

| Type layer | Current role | Boundary |
| --- | --- | --- |
| `contracts/openapi/api.yaml` | Canonical HTTP contract | Public contract truth |
| `apps/command-center/src/types.ts` | First-party UI types for the product app | Internal app-facing types |
| `tests/web-harness/src/api-gen/**` | Generated request helpers for harness/test flows | Internal generated integration layer |

What does **not** exist yet:

- no published `@pagestress/sdk`
- no stable cross-package public TypeScript types module for builders
- no semver-backed promise that frontend hooks or harness generators are the long-term external API

## MCP Reality For Builders

MCP is real, but it is still an **adapter layer**.

That means:

- it reuses backend truth and governed artifacts
- it gives agents a structured entry
- it is not a second truth system
- it is not the promised future of every integration

The current builder rule of thumb:

- choose **HTTP/OpenAPI** when you want portable product integration
- choose **MCP** when you want agent-ready runtime and review access

## Scripts That Matter For Builders

These are the repo-owned commands that define or verify the integration surface:

| Command | What it tells you |
| --- | --- |
| `pnpm mcp:start` | Boot the MCP adapter layer |
| `pnpm mcp:doc:contract` | Check that MCP docs stay aligned with registered tools/resources |
| `pnpm mcp:smoke` | Smoke-test the MCP harness path |
| `pnpm contracts:generate` | Regenerate the harness client from OpenAPI |
| `pnpm doctor:repo` | Repo-wide governance and integration sanity sweep |

## Future SDK Path

If Pagestress grows a real builder SDK later, the least-surprising path is:

1. keep `contracts/openapi/api.yaml` as the source of truth
2. widen generation beyond the current harness-only modules
3. move generated or curated client code out of `tests/web-harness/`
4. publish a dedicated package with explicit versioning and support boundaries

That future path is plausible because the contract and generation machinery already exist.

But it is still **future path**, not **current promise**.

## Later / No-Go Boundaries

### Later

- a full public SDK package
- full generated coverage for proof, templates, and workflow-run families
- stronger shared public type modules for builders
- higher-level builder kits on top of MCP and HTTP

### No-go for current claims

- do **not** describe MCP as write-capable governance control
- do **not** describe the generated harness client as the official SDK
- do **not** treat frontend hooks as a supported external import surface
- do **not** assume arbitrary public-web onboarding is open by default

## The Short Version

If you only need one paragraph:

> Today the safest builder entry is the HTTP/OpenAPI contract, the cleanest agent entry is MCP, the frontend hooks are internal examples, and the generated client is real but still harness-scoped rather than a formal SDK.
