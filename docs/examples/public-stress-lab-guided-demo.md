# Public Stress Lab Guided Demo

This is the fastest **public-safe, no-setup** way to understand what Pagestress
is today.

Think of it like a guided museum route:

- you see the front door,
- you walk the main rooms in order,
- you inspect one sanitized proof object,
- and you leave understanding where AI and MCP actually fit.

## What This Demo Is

- a read-only walkthrough of the current product story
- a public-safe demo layer for external evaluators
- a bridge between the stress-lab front door and the deeper governed pagestress

## What This Demo Is Not

- not a hosted live sandbox
- not a public runtime bundle
- not a claim that arbitrary public-web targets are fully open today
- not a replacement for local verification or governed runs

## Step 1. Understand The Product In One Sentence

> **Pagestress is an AI-native WebUI stress lab for localhost-first browser
> experiments, with governed proof and agent-ready workflows when results need
> deeper review.**

That sentence is doing three jobs:

- **main product:** WebUI stress lab
- **safe current scope:** localhost-first
- **deeper layers:** governed proof, AI/MCP-assisted workflows

## Step 2. See The Main Product Surface

The current launch-first shell map is shown here:

![Pagestress studio preview showing the launch-first operator path: Stress Lab first, then Runs and Blocks, then Flow Studio, with Advanced Review as the deeper governed layer behind the first visible result.](../assets/pagestress-studio-preview.svg)

This is a semantic front-door preview, not a literal runtime screenshot. That
keeps the public demo aligned with the current IA without treating an older
maintainer-local capture as current shell proof.

Read it in this order:

1. **Stress Lab**: start with the target and experiment mode
2. **Runs & Blocks**: read the latest result and clear manual blockers
3. **Flow Studio**: refine the journey after you learn something from the run
4. **Advanced Review**: open the deeper compare/proof/AI layer only when the result needs it

## Step 3. Understand The Result Path

This diagram shows how the public front door and the governed deeper lane fit
together:

![Pagestress result path diagram showing the local first-look path, the governed run path, and the MCP connection route.](../assets/pagestress-result-path.svg)

Plain-language rule:

- **front door first**
- **governed proof second**
- **AI and MCP stay as amplifiers, not identity replacement**

## Step 4. Inspect One Public-Safe Proof Object

Pagestress keeps exactly one public-safe proof sample in the repo:

- [Public Proof Sample](./public-proof-sample/README.md)

Use it to confirm that the deeper layer is real:

- governed run bundles exist
- manifest and summary contracts exist
- public-safe structure can be shown without exposing private runtime evidence

## Step 5. See Where AI And MCP Fit

AI and MCP are **support layers**, not the homepage identity.

- AI helps with briefs, grouped findings, and next-step guidance
- MCP gives agents and operator copilots access to the same governed runtime
- neither one replaces the main stress-lab story

If you want that deeper layer:

- [docs/mcp.md](../mcp.md)
- [docs/proof-center.md](../proof-center.md)

## Honest Current Boundary

The current public story is intentionally narrower than “test any public URL by
default”.

Today the honest MVP boundary is:

- `localhost-first`
- `web.any-localhost`
- `--base-url`
- fail-closed outside explicit allowlists

That is a product boundary, not just a marketing disclaimer.

## If You Want To Go One Step Further

- See the front door: [README.md](../../README.md)
- Follow the quickstart: [docs/get-started.md](../get-started.md)
- Read the positioning: [docs/why-pagestress.md](../why-pagestress.md)
- Inspect the public pagestress: [docs/proof-center.md](../proof-center.md)
