# FAQ

## What is Pagestress in plain English?

Pagestress is an **AI-native WebUI stress lab**. Instead of leaving browser
experiments scattered across scripts, CI logs, and hidden artifacts, it gives
you one place to launch a target, read the result, and only then move into
governed proof and deeper review.

## Is this just a Playwright repo?

No. Playwright is part of the stack, but the repo also includes:

- The Command Center frontend
- The FastAPI control plane
- The orchestrator runtime
- AI-assisted review and guidance layers
- MCP exposure for agent-ready access
- Proof and review surfaces that explain what the platform trusts

## Who should use it first?

Start here if you already feel the pain of:

- Hard-to-explain browser experiments
- Local WebUI testing that never graduates beyond scripts
- CI runs that block without enough context
- Operators or agents needing the same governed execution surface

## Can I understand it without local setup?

Yes. Start with:

1. [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md)
2. [README.md](../README.md)
3. [docs/proof-center.md](./proof-center.md)

That path is public-safe and read-only.

## Does the Command Center support more than one language?

Yes, for the key shell surfaces.

The current operator shell can switch navigation, onboarding, and help copy
between English and Simplified Chinese. That bilingual shell now reaches the
highest-traffic launch/result/review surfaces plus key operator chrome such as
Flow Studio guidance, parameter panels, dialogs, and notifications. The deeper
product and contract docs remain English-first so the public repo keeps one
canonical documentation surface.

## Does this work with Codex and Claude Code?

Yes, through MCP compatibility.

Pagestress exposes a read-mostly MCP surface that Codex, Claude Code, and other
MCP-capable clients can call. That is a protocol compatibility statement, not
an official partnership claim.

## Is the generated client the public SDK?

No.

The generated client is real, but it is currently harness-scoped and lives
under the repo's internal test surfaces. The safest builder entry today is the
OpenAPI + direct HTTP contract described in
[docs/reference/integration-entrypoints.md](./reference/integration-entrypoints.md).

## Why not just keep everything in CI?

CI is good at saying pass or fail. It is much worse at being the product
surface where people understand what happened, why it failed, and what to do
next. Pagestress tries to connect both.

## What should I read first if I am evaluating the repo?

Use this order:

1. [README.md](../README.md)
2. [docs/get-started.md](./get-started.md)
3. [docs/why-pagestress.md](./why-pagestress.md)
4. [docs/proof-center.md](./proof-center.md)

## What should I read first if I want contracts and hard truth?

Use this order:

1. [docs/architecture.md](./architecture.md)
2. [docs/reference/ci-governance.md](./reference/ci-governance.md)
3. [docs/reference/public-readiness.md](./reference/public-readiness.md)
4. [docs/reference/public-artifact-policy.md](./reference/public-artifact-policy.md)

## Why star the repo if I am not adopting it today?

Because the repo is not only shipping code. It is also opening up a productized
way to think about WebUI stress testing, governed proof, AI-assisted review,
and MCP-ready workflows. If that direction matters to you, following early is
rational.
