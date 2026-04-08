# Docs Index

This is the public navigation map for Prooflane. Start with the layer that
matches the WebUI-testing job you actually want to do, then go deeper only when
you need more detail.

## Distribution Truth Today

Prooflane is already publishable through **GitHub + GitHub Pages + public-safe
docs**, but it is not claiming package-registry or marketplace distribution
that has not happened yet.

- **Live now**: GitHub repository, GitHub Pages, Discussions, release notes,
  MCP docs, public-safe guided demo, and proof docs.
- **Ready but not live yet**: PyPI, npm, plugin marketplaces, public Skills
  registry packaging, and other external distribution listings.
- Distribution-ready summaries live in [DISTRIBUTION.md](../DISTRIBUTION.md)
  and [INTEGRATIONS.md](../INTEGRATIONS.md).

Use these two short pages when you want the truth without reading the full
architecture stack:

- [../DISTRIBUTION.md](../DISTRIBUTION.md)
- [../INTEGRATIONS.md](../INTEGRATIONS.md)

## Start Here

| If you are trying to... | Read this first | Then go here |
| --- | --- | --- |
| Understand the product without local setup | [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md) | [README.md](../README.md) |
| Understand the stress-lab story in 30 seconds | [README.md](../README.md) | [docs/why-prooflane.md](./why-prooflane.md) |
| Get a localhost-first result fast | [docs/get-started.md](./get-started.md) | [docs/how-to/mcp-quickstart-1pager.md](./how-to/mcp-quickstart-1pager.md) |
| Connect Codex, Claude Code, or another MCP-capable client | [docs/how-to/mcp-agent-review-loop.md](./how-to/mcp-agent-review-loop.md) | [docs/how-to/mcp-clients-setup.md](./how-to/mcp-clients-setup.md) |
| See bilingual operator guidance in the Command Center | [README.md](../README.md) | [docs/get-started.md](./get-started.md) |
| Understand the testing pyramid and coverage gates | [docs/reference/testing-strategy.md](./reference/testing-strategy.md) | [docs/quality-gates.md](./quality-gates.md) |
| Review the public launch story | [docs/releases/v0.1.0-public-launch.md](./releases/v0.1.0-public-launch.md) | [docs/releases/v0.1.0-public-closure.md](./releases/v0.1.0-public-closure.md) (historical snapshot) |
| Judge whether the repo is credible | [docs/proof-center.md](./proof-center.md) | [docs/reference/ci-governance.md](./reference/ci-governance.md) |
| Understand the runtime and architecture | [docs/architecture.md](./architecture.md) | [docs/reference/universal-api.md](./reference/universal-api.md) |

## Stress Lab Front Door

- [README.md](../README.md): public front door
- [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md): no-setup guided demo
- [docs/get-started.md](./get-started.md): localhost-first quickstart
- [docs/why-prooflane.md](./why-prooflane.md): product story and differentiation
- [docs/releases/v0.1.0-public-launch.md](./releases/v0.1.0-public-launch.md): first public release notes
- [docs/releases/v0.1.0-public-closure.md](./releases/v0.1.0-public-closure.md): historical closure snapshot
- [docs/faq.md](./faq.md): evaluation FAQ

## Current Truth

- Canonical rules: [docs/ai/agent-guide.md](./ai/agent-guide.md)
- Architecture contract: [docs/architecture.md](./architecture.md)
- Public boundary:
  [docs/reference/public-readiness.md](./reference/public-readiness.md)
- CI and branch-protection truth:
  [docs/reference/ci-governance.md](./reference/ci-governance.md)
- Public artifact policy:
  [docs/reference/public-artifact-policy.md](./reference/public-artifact-policy.md)

## Proof And Trust

- [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md): public-safe walkthrough of the product layers
- [docs/proof-center.md](./proof-center.md): public proof map for the deeper governed layer
- [docs/reference/public-readiness.md](./reference/public-readiness.md):
  public boundary
- [docs/reference/public-artifact-policy.md](./reference/public-artifact-policy.md):
  public-safe artifact rules
- [docs/reference/ci-governance.md](./reference/ci-governance.md):
  required CI topology and thresholds
- [docs/quality-gates.md](./quality-gates.md): compact gate semantics
- [docs/reference/root-governance.md](./reference/root-governance.md):
  allowed root structure
- [docs/reference/logging-governance.md](./reference/logging-governance.md):
  log sinks and retention
- [docs/reference/compatibility-matrix.md](./reference/compatibility-matrix.md):
  third-party contract map
- [docs/reference/upstream-customizations.md](./reference/upstream-customizations.md):
  tracked third-party source customizations and local override record
- [docs/reference/resolution-overrides.md](./reference/resolution-overrides.md):
  dependency override registry

## Runtime And Extension

- [docs/architecture.md](./architecture.md): canonical architecture contract
- [docs/reference/integration-entrypoints.md](./reference/integration-entrypoints.md): builder map for HTTP, MCP, frontend hooks, and generated client surfaces
- [docs/reference/universal-api.md](./reference/universal-api.md): API contract
- [docs/reference/configuration.md](./reference/configuration.md):
  environment and configuration
- [docs/reference/testing-strategy.md](./reference/testing-strategy.md):
  testing pyramid, coverage thresholds, and the fastest verification entry
- [docs/reference/dependency-governance.md](./reference/dependency-governance.md):
  dependency policy
- [docs/reference/runtime-storage-policy.md](./reference/runtime-storage-policy.md):
  runtime storage boundary
- [docs/reference/cache-governance.md](./reference/cache-governance.md):
  cache classes and retention
- [docs/reference/runtime-paths.md](./reference/runtime-paths.md):
  runtime path contract
- [docs/reference/logging-and-cache-policy.md](./reference/logging-and-cache-policy.md):
  operator-facing storage policy

## MCP

- [docs/reference/integration-entrypoints.md](./reference/integration-entrypoints.md):
  builder entry map before you choose HTTP vs MCP vs repo-internal client code
- [docs/how-to/mcp-agent-review-loop.md](./how-to/mcp-agent-review-loop.md):
  the quickest truthful path for Codex, Claude Code, or another MCP-capable
  client
- [docs/how-to/mcp-quickstart-1pager.md](./how-to/mcp-quickstart-1pager.md):
  fastest MCP path
- [docs/how-to/mcp-clients-setup.md](./how-to/mcp-clients-setup.md):
  client setup
- [docs/mcp.md](./mcp.md): full MCP contract

Suggested roles:

- Operators: start in the quickstart, then follow the operator path in
  `docs/how-to/mcp-clients-setup.md`
- Agents / MCP clients: use the agent path in
  `docs/how-to/mcp-clients-setup.md`
- Advanced reviewers: start in `docs/mcp.md` for proof, brief, and campaign
  tools

## Task Routing

| Task type | Read first | Gate path |
| --- | --- | --- |
| Docs and public-surface work | [docs/ai/agent-guide.md](./ai/agent-guide.md) + [docs/index.md](./index.md) | [docs/quality-gates.md](./quality-gates.md) for gate semantics, then the exact repo fast command from `docs/ai/agent-guide.md` / `package.json` |
| Code changes | [docs/ai/agent-guide.md](./ai/agent-guide.md) + [docs/architecture.md](./architecture.md) | [docs/quality-gates.md](./quality-gates.md) for delivery-gate semantics, then the exact fast/full command from `docs/ai/agent-guide.md` / `package.json` |
| Full acceptance | [docs/ai/agent-guide.md](./ai/agent-guide.md) | [docs/quality-gates.md](./quality-gates.md) for parity expectations, then the exact full-acceptance command from `docs/ai/agent-guide.md` / `package.json` |
| Public release review | [docs/proof-center.md](./proof-center.md) + [docs/reference/public-readiness.md](./reference/public-readiness.md) | [docs/quality-gates.md](./quality-gates.md) plus the release-boundary commands recorded in `docs/ai/agent-guide.md` / `package.json` |

## Search Before Writing

1. `rg -n "<keyword>" docs scripts backend frontend packages`
2. `sg -p '<AST_PATTERN>' backend frontend packages`
3. `bash scripts/dev/ast-search.sh '<AST_PATTERN>' backend frontend packages`
4. `rg --files docs | rg "agent|guide|gate|readme"`

## Notes

- The docs are intentionally layered: stress-lab entry first, proof second,
  deep governance third.
- Historical release and closure documents stay in the navigation map as
  historical context, not as current-truth dashboards.
- GitHub-side live settings such as homepage, topics, and social preview belong
  to the latest audit evidence, not to static docs prose.
- Generated reference docs remain valid only when their source governance
  configs and render checks stay in sync.
