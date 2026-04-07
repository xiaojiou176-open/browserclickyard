# Why Prooflane

Prooflane exists for teams that already know a painful truth: browser
automation is easy to start, but hard to turn into a reusable **stress lab**
that people can actually operate.

## The Core Bet

Most browser stacks break in one of two directions:

- they stay fast but fragment into scripts, dashboards, and ad hoc debug output
- they become governed but so heavy that nobody wants to use them for everyday
  investigation

Prooflane is the bet that you can keep both layers:

- a URL-first lab shell for exploration, load, perf, chaos, visual, and
  accessibility work
- a governed review layer for proof bundles, AI summaries, and deep comparison
- one runtime story that humans and agents can both reuse through MCP-capable
  clients such as Codex, Claude Code, or other MCP hosts

## The Product Story In Plain Language

The front door is now being realigned around one simple sentence:

> Give Prooflane a WebUI target, choose the kind of browser experiment you want
> to run, read the result, and only then escalate into deeper governed review.

That means the product surfaces now read like four jobs:

- **Stress Lab** starts the experiment
- **Runs & Blocks** shows the latest outcome and waiting state
- **Flow Studio** helps refine the journey behind the result
- **Advanced Review** is the deeper governed layer, not the first stop

## What Makes Prooflane Different

| Question | Typical answer elsewhere | Prooflane answer |
| --- | --- | --- |
| Where does the work start? | With a script, a dashboard, or a CI job | With a target URL and a lab mode in one operator shell |
| How do you inspect what happened? | Read logs and screenshots after the fact | Read the latest result first, then drill into reports, evidence, and proof |
| How do agents fit in? | A parallel tool layer gets bolted on later | MCP-capable clients reuse the same runtime and governed surfaces through release briefs, similar failures, feasibility, and manual-gate context |
| How do you go deeper than a single run? | Open unrelated dashboards and spreadsheets | Escalate into Advanced Review, AI briefs, similar failures, and proof campaigns |

## Current Route B Boundary

Prooflane is not pretending that arbitrary public-web testing is fully open by
default today.

The honest Route B MVP is:

- **localhost-first**
- **governed-target-first**
- **fail-closed outside explicit allowlists**

That is why `web.any-localhost` and `--base-url` matter so much in the current
repo story: they are the lowest-friction bridge between the old release-review
substrate and the original “test any WebUI” vision.

## Who It Is For

Prooflane is a strong fit for:

- teams exploring or stress-testing modern WebUI flows locally
- QA and product teams that need readable browser results, not just raw logs
- engineering orgs that want governed evidence after the experiment becomes
  interesting
- agent-heavy workflows that need a safe, reusable browser lab substrate
- teams evaluating **AI browser testing**, **browser QA automation**, or a
  truthful **MCP server for Codex / Claude Code sessions** without needing to
  pretend a hosted AI copilot already exists

Prooflane is a weak fit for:

- throwaway one-file experiments
- teams that only want a narrow runner with no operator surface
- orgs that do not care about reusable evidence or governed deep review

## Why The Repo Is Public Now

The public repo is not claiming a finished hosted SaaS. The point is to make
the stress-lab substrate, the governed review layer, and the route decision
legible while keeping sensitive runtime evidence private by default.

That means the public value is not only the code:

- you can understand the architecture
- you can inspect the guardrails and proof boundaries
- you can see the route realignment happen in the open
- you can join discussions while the public surface gets stronger

## Why Star Now

Star Prooflane if you want updates on:

- AI-native WebUI stress testing, not just browser snippets
- public proof systems for browser experiments and governed review
- MCP-driven operator workflows over the same runtime
- a repo that is actively turning hidden automation maturity into a visible
  product route
