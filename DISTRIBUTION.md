# Distribution Status

This page keeps the public distribution story short, truthful, and easy to
reuse.

## Canonical Repo

- Canonical repo URL:
  `https://github.com/xiaojiou176-open/ui-automation-control-plane`
- Public homepage:
  `https://xiaojiou176-open.github.io/ui-automation-control-plane/`
- Public release channel:
  `https://github.com/xiaojiou176-open/ui-automation-control-plane/releases`

## Live Now

- Public GitHub repository under `xiaojiou176-open`
- GitHub Pages site
- GitHub Issues and Discussions
- Public release `Prooflane v0.1.0`
- Localhost-first stress-lab product path
- Governed run lane through `pnpm uiq run ...`
- Repo-native MCP server through `pnpm mcp:start`
- Generic in-repo skill scaffold at `docs/skills/prooflane-mcp/`

## Ready In Repo, But Not Published As Separate Distributions

- Publish-ready MCP package `@uiq/mcp-server`
- Planned CLI entry `prooflane-mcp`
- Planned package-launch shape `npx -y @uiq/mcp-server` /
  `pnpm dlx @uiq/mcp-server`
- MCP integration docs and config snippets for Codex, Claude Code, OpenClaw,
  and other MCP-capable clients
- Public-safe guided demo and proof-center docs
- Release-ready docs, CI governance, and security gate surfaces

## Not Published Yet

- npm package
- PyPI package
- Official plugin marketplace listing
- Public Skills marketplace listing
- Separate starter bundle distribution
- Public Docker image
- Hosted multi-tenant SaaS claim

## Docker Truth Today

- The repo contains Dockerfiles and `docker-compose.yml`.
- Those files describe a **from-source local stack**, not a published image
  distribution channel.
- There is **no public Prooflane Docker image published today**.
- Docker is useful for local composition, but it is **not** the primary public
  distribution entry in this pass.

## Truthful Claim Boundary

It is truthful to say that:

- the repo is public and ready for evaluation
- the product runs locally today
- the governed run and MCP surfaces exist today
- the publish-ready MCP artifact target is `@uiq/mcp-server`
- the planned CLI name is `prooflane-mcp`

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
