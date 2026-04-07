# Master Execution Plan

## Purpose

This plan consolidates:

- the full archive backlog,
- the live repo truth on March 31, 2026,
- the external positioning research, and
- the direction-neutral work that can ship before the product-route decision is finalized.

The plan is intentionally split between:

- **direction-neutral shared foundation**, and
- **route-dependent execution lanes**.

## Truth Summary

- The live repo is already shipping a real `release decision plane` slice:
  Review Board, proof APIs, typed manual-gate resume, template asset lineage,
  and target feasibility.
- The live repo still carries strong stress-lab DNA in the orchestrator,
  profiles, targets, and evidence pipeline: `load`, `perf`, `explore`,
  `chaos`, and governed web-target validation remain first-class substrate.
- Therefore the repo should not pretend the route choice is settled when the
  user explicitly restated the original “any WebUI stress testing” vision.

## Progress Snapshot — Prompt 2 / Wave 1

Completed in the current round:

- Prompt 1 planning artifacts were located, read, and reused instead of being
  rebuilt from scratch.
- Direction-neutral lane clarity landed across:
  - `README.md`
  - `docs/get-started.md`
  - `docs/why-prooflane.md`
  - `docs/proof-center.md`
  - `docs/reference/universal-api.md`
  - the Command Center shell and supporting help/onboarding surfaces
- Wave 1 product-surface progress landed in the app:
  - clearer `Quick Launch -> Task Center -> Review Board` operator path
  - clearer command lane vs workflow lane language
  - stronger Manual Gate action copy
  - stronger Review Board “when to use this page” semantics
  - a first `AI release brief` reading layer over compare + AI review data

Still open in Wave 1:

- stronger Review Board campaign workflow
- Manual Gate Inbox deeper than the current summary layer
- template-promotion assistant
- fuller target-feasibility frontload
- public-safe decision demo

## Wave Map

### Wave 0 — Shared Foundation Before Direction Lock

Goal: make the repo easier to understand, safer to extend, and less likely to
drift, regardless of the final product route.

Included inventory ids:

- `META-01`
- `FND-01`
- `FND-02`
- `FND-03`
- `FND-04`
- `FND-05`
- `FND-06`
- `FND-07`
- `FND-08`
- `FND-09`

Primary outcomes:

1. Direction choice becomes explicit and tracked.
2. Run-lane language converges across README, docs, API wording, and UI copy.
3. The operator-facing app explains what each surface is for.
4. Projection surfaces such as `command_tower` stop competing with primary
   truth surfaces in user language.
5. Truth bridges across `Run`, `AutomationTask`, governed bundles, and proof
   campaigns gain better diagnostics and verification hooks.

Exit criteria:

- Direction memo is written and linked from the execution plan.
- Enhancement inventory is complete and route-dependent items remain visible.
- The app and front-door docs share one human-readable lane model.
- At least 2-4 direction-neutral fixes are landed and verified.

### Wave 1 — Current Product Surface Stabilization

This wave assumes the repo keeps the current product front door intact while the
route decision is still open.

Included inventory ids:

- `RDP-01`
- `RDP-02`
- `RDP-03`
- `RDP-04`
- `RDP-05`
- `RDP-06`

Goal:

- turn the existing decision-plane slice into a clearer, more operator-friendly
  product surface.

Key work:

1. Manual Gate becomes a strong operator surface instead of a hidden embedded
   recovery card.
2. Review Board becomes easier to understand as the place where governed
   evidence is compared and judged.
3. Template promotion and target feasibility move earlier into the workflow.
4. Public-safe demo and proof snapshots tell the story without oversharing
   private evidence.

Exit criteria:

- A new user can tell where to start, where to monitor, and where to decide.
- Review-ready runs can be assembled into a proof campaign without hidden
  knowledge.
- Manual Gate and template promotion no longer feel like “advanced-only”
  surfaces.

### Wave 2 — AI + MCP Amplification

Included inventory ids:

- `RDP-07`
- `RDP-08`
- `RDP-09`
- `RDP-10`
- `RDP-11`
- `RDP-12`
- `RDP-13`
- `RDP-14`
- `RDP-15`

Goal:

- amplify the chosen product route without introducing a second truth owner.

Guardrails:

- AI remains an assist, explain, summarize, cluster, or recommend layer.
- MCP remains an adapter/workspace connection layer.

Key work:

1. AI Release Brief / AI Release Review.
2. Manual Gate Copilot.
3. Embedding-backed retrieval over historical runs, templates, and campaigns.
4. Template migration advice.
5. Higher-level MCP workflows and role-based MCP docs.

Progress snapshot — Prompt 3 / Wave 2:

- `AI release brief` moved from UI-only reading hints toward a backend-backed
  projection contract.
- `similar failures` is now implemented as a minimal retrieval surface over
  existing governed run evidence instead of a new ledger.
- Manual Gate now has a stronger copilot-style checklist layer in the current
  product surface.
- MCP docs now include role-based paths for operators, agents, and release
  reviewers.
- MCP gained new Wave 2 read-mostly tools/resources for:
  - AI review
  - release brief
  - similar failures
  - template feasibility explanation
  - manual-gate inbox summary
- Remaining Wave 2 work is now concentrated in:
  - deeper Manual Gate inbox/workbench UX
  - richer AI review grouping and explanation
  - proving MCP harness tests in the current environment

Exit criteria:

- AI outputs are projections over existing truth, not parallel state.
- MCP tools expose governed workflows rather than inventing new ones.
- The repo has one stable “how humans and agents collaborate” story.

### Wave 3 — Route Fork

This wave is intentionally split.

#### Route A — Continue As A Release Decision Plane

Focus:

- deepen the decision product:
  release candidate workspace, stronger decision narratives, and richer
  governed review workflows.

Most relevant ids:

- `RDP-02`
- `RDP-03`
- `RDP-06`
- `RDP-07`
- `RDP-11`
- `RDP-16`

#### Route B — Realign To Universal WebUI Stress Lab

Focus:

- bring the original vision back to the front door:
  any-URL onboarding, stress/load/synthetic/resilience as first-class surfaces,
  and stress-centered reporting.

Most relevant ids:

- `STR-01`
- `STR-02`
- `STR-03`
- `STR-04`
- `STR-05`
- `STR-06`

Progress snapshot — Prompt 4 / Wave 3:

- the Command Center front door is being realigned toward `Stress Lab ->
  Runs & Blocks -> Flow Studio -> Advanced Review`
- lane-first help/onboarding/review wording is being replaced with
  URL-first/capability-first guidance
- the docs front door now describes the honest Route B MVP as
  `localhost-first / governed-target-first`
- proof, AI, and MCP are being explicitly repositioned as deeper governed
  layers after a lab result exists
- remaining work is concentrated in:
  - final verification on the Route B wording/tests bundle
  - branding/SEO/public-demo packaging deferred to Wave 4 / Prompt 5

Exit criteria:

- only one route owns the hero story, the primary navigation emphasis, and the
  dominant result surface.

### Wave 4 — Branding, SEO, Distribution, And Public Demo

Included inventory ids:

- `GTM-01`
- `GTM-02`
- `GTM-03`
- `GTM-04`
- `GTM-05`

Goal:

- package the chosen route so the repo attracts the right traffic instead of
  generic AI-curiosity traffic.

Key work:

1. Preserve a product-shaped core brand.
2. Use `.ai` at the domain or landing-page layer where helpful.
3. Publish route-specific hero, subtitle, GitHub, Product Hunt, SEO, and social
   copy.
4. Expose a public-safe demo or guided sample that matches the chosen route.

Progress snapshot — Prompt 5 / Wave 4:

- the repo now has a final positioning memo and a brand/SEO/distribution pack
- README, docs index, get-started, FAQ, and proof-center are being unified
  around one stress-lab-first outside story
- a public-safe guided demo now exists alongside the single public proof sample
- public visual alt text and social-preview source art are being aligned to the
  same Route B language
- remaining Wave 4 work is mostly remote/distribution follow-through rather
  than local product-story ambiguity

Exit criteria:

- the front door says one thing clearly,
- the category/SEO words match the chosen route,
- AI and MCP stay in supporting roles on the homepage.

### Wave 5 — Hardening, Acceptance, And Cleanup

Goal:

- finish the route with evidence, not with narrative only.

Required closing work:

1. Run related docs, lint, test, and acceptance gates.
2. Re-run blocker-focused review on landed changes.
3. Remove or de-emphasize transitional copy that no longer matches the chosen
   route.
4. Re-check public boundary promises after any demo or branding changes.

Progress snapshot — Prompt 5 / Wave 5:

- final acceptance and executive-summary closeout notes now exist
- fresh focused frontend regression, backend proof API, and MCP doc-contract
  verification were rerun in the final wave
- docs-gate can now be returned to green after targeted cleanup of generated
  residue
- the last visible acceptance noise is now mostly remote-state or cross-wave:
  audit-backed GitHub metadata, the older Wave 2 MCP harness issue if full
  harness green status is required, and an unrecovered final verdict from the
  heavy containerized `lint-all` gate

Exit criteria:

- fast gates pass,
- route-specific surfaces are evidence-backed,
- no route-dependent ambiguity remains on the front door.

## Recommended Current Priority

Based on the archive and live repo truth, the next best move is:

1. finish Wave 3 verification and Route B closeout,
2. use Wave 4 for branding / SEO / public-demo packaging around the stress-lab
   route,
3. keep Prompt 1-3 proof / AI / MCP layers as deeper substrate rather than
   reopening the route debate.

## Route-Choice Dependency Rules

- Do not silently merge Route A and Route B into one fuzzy roadmap.
- Do not promote AI or MCP to primary identity even after Route B takes the
  front door.
- Do not rebrand the product around a generic AI naming template; keep the
  WebUI stress-lab story primary.
