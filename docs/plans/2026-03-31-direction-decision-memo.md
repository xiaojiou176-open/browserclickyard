# Direction Decision Memo

## Decision To Make

Should Browserclickyard continue to grow as a **browser release decision plane**, or
should it be explicitly redirected back toward the original **universal WebUI
stress lab** vision?

## 1. What The Repo Actually Looks Like Today

Short answer:

- **more like a release decision plane than a pure stress lab**, but
- **not yet a fully dominant decision product**.

Why:

### Evidence for the current-line release decision story

- The front door already speaks in release language:
  [README](../README.md), [Why Browserclickyard](../why-browserclickyard.md), and
  [Proof Center](../proof-center.md) emphasize governed proof, review, and ship
  confidence.
- The live task board and existing master plan explicitly target
  `Browserclickyard Release Decision Plane`.
- The app has a real `Review Board` tab and the backend has a real proof domain
  (`/api/proof/*`, `proof_service.py`).
- `CHANGELOG.md` records the first release-decision-plane slice as already
  landed in `Unreleased`.

### Evidence that the old stress-lab DNA still matters

- The orchestrator still exposes `load`, `perf`, `explore`, `chaos`, and
  desktop soak commands.
- Weekly and deeper profiles still use those stress/analysis steps as part of
  governed validation.
- Web targets, capability registry, and proof artifacts still treat
  browser-validation substrate as first-class.
- The default product shell is still more operator/workshop-centric than
  “Review Board above all else.”

### Current synthesis

The repo is best described as:

> an operator-first browser automation governance platform with a real release
> decision slice already growing inside it.

That is not the same as “already fully committed to the decision route,” but it
is also not the same as the original simple “test any webpage” mission.

## 2. If We Continue The Current Main Line, What Is The Most Valuable Product?

The strongest product is:

> **browser proof for release decisions**

The winning product promise becomes:

- compare risky web changes with governed evidence,
- review failed checks and AI findings together,
- understand when manual intervention is required,
- decide whether a candidate is ready to ship.

Why this is the most valuable continuation:

- the repo already has the proof APIs, Review Board, manual-gate model, AI
  review projection, and target feasibility pieces,
- external research shows the closest market language lives near
  “guarded releases,” “quality gates,” and “eval-backed ship confidence,”
- this route lets AI and MCP stay in supporting roles where they help most.

External comparables:

- [LaunchDarkly Guarded Rollouts](https://launchdarkly.com/docs/home/releases/guarded-rollouts)
- [Harness Verify](https://developer.harness.io/docs/continuous-delivery/verify/verify-deployments-with-the-verify-step)
- [BrowserStack Test Reporting & Analytics](https://www.browserstack.com/test-reporting-and-analytics)
- [Braintrust](https://www.braintrust.dev/home)
- [Humanloop Evaluations](https://humanloop.com/platform/evaluations)

## 3. If We Return To The Original Vision, What Is The Minimum-Cost Redirect Path?

The lowest-regret redirect is not to delete the current substrate. It is to
reuse it under a different product story.

Minimum-cost redirect:

1. Keep the orchestrator, profiles, targets, capability registry, and governed
   evidence pipeline.
2. Reframe the front door around:
   - any-URL onboarding,
   - browser load,
   - synthetic journeys,
   - resilience and bottleneck reporting.
3. Promote `load`, `perf`, `explore`, and `chaos` to first-line product
   surfaces.
4. Demote Review Board and proof-campaign language into a secondary analysis
   story rather than the homepage hero.
5. Reshape the MCP surface to support stress-lab workflows instead of
   release-review workflows.

External comparables:

- [Grafana k6](https://k6.io/)
- [Artillery Playwright](https://www.artillery.io/docs/playwright)
- [Checkly: From Playwright Testing To Monitoring](https://checklyhq.com/docs/guides/playwright-testing-to-monitoring)
- [Datadog Browser Testing](https://docs.datadoghq.com/synthetics/browser_tests/)

## 4. Which Enhancements Are Worth It Either Way?

These are the safest shared investments:

- run-lane vocabulary convergence
- first-use lane explainer
- Command Tower projection boundary hardening
- ledger consistency diagnostics
- fresh runtime validation pack
- AI/MCP truth-owner guardrails
- deployment runbook
- embedding-backed historical retrieval

Why these survive either route:

- both routes depend on clear truth ownership,
- both routes currently suffer from operator confusion across surfaces,
- both routes benefit from better diagnostics over multiple ledgers,
- both routes can use AI/MCP as support layers without promoting them to
  product identity.

## 5. Which Enhancements Must Wait For Direction Lock?

These should remain route-dependent until a decision is made:

- homepage hero and subtitle
- SEO and Product Hunt copy pack
- whether Review Board is a primary or secondary surface
- whether `load/perf/explore/chaos` become homepage pillars
- route-specific MCP packaging
- public demo shape
- AI Release Review as primary hero
- stress-lab report center as primary hero

## External Research Implication For Naming And IA

The external signal is consistent:

- AI works best in this product as an eval/review/assist layer.
- MCP works best as a connection/workspace layer.
- “control plane” is helpful in deeper docs, but not ideal as the hero phrase.
- outcome-led copy beats protocol-led copy.

So the near-term rule should be:

> keep AI and MCP in supporting copy until the route is chosen,
> and keep the homepage outcome-led rather than architecture-led.

## Working Recommendation

Do not force a route decision by branding alone.

Instead:

1. finish the shared foundation,
2. land low-regret operator/productization fixes,
3. then choose explicitly between:
   - **Route A:** `browser proof for release decisions`
   - **Route B:** `AI-native browser stress lab for modern web apps`

