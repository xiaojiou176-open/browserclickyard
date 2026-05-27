# Distribution Status

This page keeps the public distribution story short, truthful, and easy to
reuse.

## Canonical Repo

- Canonical repo URL:
  `https://github.com/xiaojiou176-open/pagestress`
- Public homepage:
  `https://xiaojiou176-open.github.io/pagestress/`
- Public release channel:
  `https://github.com/xiaojiou176-open/pagestress/releases`

## Primary lane vs companion lanes

- **Primary lane:** the Pagestress stress-lab front door, localhost-first
  product path, and governed run flow
- **Companion integration lane:** the repo-native MCP server in
  `services/mcp-server/`
- **Companion packet lane:** the generic in-repo skill packet under
  `docs/skills/pagestress-mcp/`

Important boundary:

> companion MCP/package/skill status belongs to those surfaces only.
> it does not turn Pagestress into a browser extension product, an already
> listed marketplace package, or a hosted SaaS.

## Repo-owned today

- Localhost-first stress-lab product path
- Governed run lane through `pnpm uiq run ...`
- Repo-native MCP server through `pnpm mcp:start`
- Public-safe guided demo and proof docs

## Remote GitHub routes (audit-backed)

- Public GitHub repository under `xiaojiou176-open`
- GitHub Pages site
- GitHub Issues and Discussions
- Public release route for `Pagestress v0.1.0`

Use `docs/reference/public-readiness.md` and the latest audit artifacts before
restating those remote GitHub surfaces as freshly verified current state.

## Ready In Repo, But Not Published As Separate Distributions

- Publish-ready MCP package `@uiq/mcp-server`
- Planned CLI entry `pagestress-mcp`
- Planned package-launch shape `npx -y @uiq/mcp-server` /
  `pnpm dlx @uiq/mcp-server`
- MCP integration docs and config snippets for Codex, Claude Code, OpenClaw,
  and other MCP-capable clients
- Generic in-repo skill packet at `docs/skills/pagestress-mcp/`
- Release-ready docs, CI governance, and security gate surfaces

## Companion Skill Host State

- ClawHub listing for the companion skill packet is live at
  `https://clawhub.ai/xiaojiou176/pagestress-mcp`
- OpenHands/extensions remains `review-pending` via PR `#161`
- Those receipts apply to `docs/skills/pagestress-mcp/` only; they do **not**
  prove npm/PyPI publication, main-product marketplace listing, or hosted SaaS
  availability

## Not Published Yet

- npm package
- PyPI package
- Official plugin marketplace listing
- Additional public Skills marketplace listings beyond the ClawHub companion packet
- Separate starter bundle distribution
- Public Docker image
- Hosted multi-tenant SaaS claim

## Docker Truth Today

- The repo contains Dockerfiles and `docker-compose.yml`.
- Those files describe a **from-source local stack**, not a published image
  distribution channel.
- There is **no public Pagestress Docker image published today**.
- Docker is useful for local composition, but it is **not** the primary public
  distribution entry in this pass.

## Truthful Claim Boundary

It is truthful to say that:

- the repo is public and ready for evaluation
- the product runs locally today
- the governed run and MCP surfaces exist today
- the publish-ready MCP artifact target is `@uiq/mcp-server`
- the planned CLI name is `pagestress-mcp`
- MCP and skill packet surfaces are companion lanes, not the primary product
  identity
- Pagestress is browser-adjacent, but it is not a browser-extension product

It is **not** truthful to say that:

- an npm or PyPI package is already published
- an official Codex or Claude Code marketplace plugin is already listed
- a public Skill marketplace listing already exists
- a public Docker image already exists
- the product is already a hosted SaaS service

## Read Next

- Public front door: [README.md](./README.md)
- First-success path: [docs/get-started.md](./docs/get-started.md)
- Integration truth: [INTEGRATIONS.md](./INTEGRATIONS.md)
- Public proof map: [docs/proof-center.md](./docs/proof-center.md)
