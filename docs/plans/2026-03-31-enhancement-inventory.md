# Enhancement Inventory And Backlog Matrix

This file is the full inventory for the March 31, 2026 archive review and live
repo truth check. It intentionally keeps both route families visible:

- Route A: `release decision plane`
- Route B: `universal WebUI stress lab`

If two items conflict, they stay in the matrix and are marked route-dependent.

## Status Legend

- `exists-needs-enhancement`
- `exists-needs-repair`
- `new-feature`
- `new-direction`
- `route-dependent`

## Matrix

### Shared Foundation And Meta Direction

| enhancement_id | Title | Archive Source | Category | Current Status | Impact | Cost | Risk | Direction-Agnostic | Dependencies | Recommended Wave | Evidence Anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| META-01 | Direction decision: release decision plane vs universal WebUI stress lab | R6 | other | route-dependent | H | M | H | no | None | Wave 0 | `part-02`, R6, user restated the original any-WebUI stress vision and asked whether the repo drifted |
| FND-01 | Run-lane and ledger vocabulary convergence | R1, R2, R6 | foundation/productization | exists-needs-enhancement | H | M | M | yes | README, docs, app copy, API wording | Wave 0 | R1 architecture report, R2 lane explainer idea, R6 route tension around what “run” means |
| FND-02 | First-use lane explainer and route map | R2, R6 | UI/UX | new-feature | H | S | L | yes | Quick Launch, Help, onboarding, README | Wave 0 | R2 “Run Lane guide”; R6 “URL-first vs review-first” tension |
| FND-03 | Command Tower projection boundary hardening | R1, R6 | foundation/productization | exists-needs-enhancement | H | S | M | yes | `command_tower` docs, API, UI wording | Wave 0 | R1 technical-debt note to label Command Tower as projection; R6 still differentiates it from primary truth |
| FND-04 | Split shared frontend/backend orchestration hubs (`useApiClient.ts`, `universal_platform_service.py`) | R1 | infra/stability | exists-needs-repair | M | L | M | yes | Shared file ownership, tests | Wave 0 | R1 technical-debt section called out both files as growing crossroads |
| FND-05 | Ledger consistency guard and reconciliation diagnostics | R1, R2 | infra/stability | new-feature | H | M | M | yes | Run/AutomationTask/bundle/campaign contracts | Wave 0 | R1 requested explicit contract tests across truth bridges; R2 promoted it to a named backlog item |
| FND-06 | Fresh runtime validation pack for Review Board, Manual Gate, MCP switching | R2, R3 | infra/stability | exists-needs-enhancement | H | M | M | yes | Local stack boot, governed run, MCP smoke | Wave 0 | R2 left several maturity claims as “needs fresh runtime evidence”; R3 repeated the same for AI/MCP |
| FND-07 | Deployment runbook | R1 | foundation/productization | new-feature | M | S | L | yes | Existing scripts and infra docs | Wave 0 | R1 called out that dev/verify stories are clear but deployment remains scattered |
| FND-08 | AI and MCP truth-owner guardrails | R3, R5 | AI | exists-needs-enhancement | H | S | M | yes | Contract docs, MCP docs, future feature copy | Wave 0 | R3 explicitly said AI should stay in assist/explain/summarize layers and MCP must remain adapter-only |
| FND-09 | Front-door and in-app proof definition alignment | R1, R2, R6 | foundation/productization | exists-needs-enhancement | H | S | L | yes | README, proof-center, Review Board intro, Task Center copy | Wave 0 | R1/R2 differentiated governed proof from local product success; R6 showed users can still misread the repo as “anything that ran equals proof” |

### Current-Line Productization: Release Decision Plane

| enhancement_id | Title | Archive Source | Category | Current Status | Impact | Cost | Risk | Direction-Agnostic | Dependencies | Recommended Wave | Evidence Anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RDP-01 | Manual Gate Inbox | R2 | UI/UX | new-feature | H | M | M | no | Typed resume contract, Task Center UX | Wave 1 | R2 product backlog promoted manual waits into a first-class operator inbox |
| RDP-02 | Review Board as release candidate workspace | R2 | foundation/productization | route-dependent | H | M | M | no | Proof domain, compare, AI review, feasibility | Wave 1 | R2 proposed one page for campaign creation, gate deltas, AI review, and feasibility |
| RDP-03 | Put Review Board and Manual Gate on the primary first-use path | R2 | UI/UX | route-dependent | H | M | M | no | IA changes, first-use copy, proof readiness | Wave 1 | R2 explicitly said first-day users should feel this is a decision product, not only a script shell |
| RDP-04 | Template Promotion Assistant | R2 | foundation/productization | new-feature | M | M | M | no | Template lineage, diff semantics | Wave 1 | R2 proposed diff summaries and breaking warnings during promote/fork-version |
| RDP-05 | Frontload target feasibility before run creation | R2 | UI/UX | exists-needs-enhancement | M | M | M | no | Target feasibility API, template form surfaces | Wave 1 | R2 proposed feasibility checks earlier in Quick Launch / Flow Workshop |
| RDP-06 | Public-safe decision snapshot or guided review demo | R2, R5 | public demo / external distribution | route-dependent | M | M | M | no | Public artifact policy, proof-center | Wave 1 | R2 suggested a sanitized decision snapshot; R5 escalated it into a guided public sample |
| RDP-07 | AI Release Brief / AI Release Review | R3, R5 | AI | route-dependent | H | M | M | no | Proof bundles, campaigns, AI review projection | Wave 2 | R3 proposed an AI brief card; R5 turned it into the outward-facing “AI Release Review” idea |
| RDP-08 | Manual Gate Copilot | R3, R5 | AI | route-dependent | M | M | M | no | Manual gate wait context, operator UI | Wave 2 | R3 proposed “AI next-step suggestions”; R5 packaged it as “Manual Gate Copilot / Gate Assist / Resume Guide” |
| RDP-09 | Embedding-backed historical run/template/campaign retrieval | R3, R5 | AI | new-feature | M | M | M | yes | Embedding API, stored artifacts, search UX | Wave 2 | R3 argued retrieval is more valuable than a generic chat box; R5 reinforced it as a concrete AI win |
| RDP-10 | AI template migration advisor | R3 | AI | new-feature | M | M | M | no | Feasibility API, template lineage | Wave 2 | R3 proposed AI guidance for capability gaps and migration steps |
| RDP-11 | High-level MCP decision tools (`generate_release_brief`, `list_manual_gates`, `summarize_candidate_risk`) | R3 | MCP/tooling | new-feature | M | M | M | no | Backend proof domain, manual gate domain | Wave 2 | R3 explicitly named these tool ideas for an agent-facing release workspace |
| RDP-12 | Role-based MCP docs and 5-minute demo flow | R3, R5 | MCP/tooling | exists-needs-enhancement | M | S | L | yes | MCP docs, proof workflow demo | Wave 2 | R3 wanted operator/agent/release-owner docs; R5 added `run -> proof -> campaign -> brief` as the minimum story |
| RDP-13 | Expand MCP resources to campaigns, manual gates, and release briefs | R3 | MCP/tooling | new-feature | M | M | M | no | Current MCP resource registry, proof domain | Wave 2 | R3 proposed moving from “latest manifest/summary” to a richer governed read surface |
| RDP-14 | Agent Release Captain | R2, R5 | AI | route-dependent | M | M | H | no | Proof APIs, MCP, acceptable agent write boundaries | Bet | R2 introduced it as a bet; R5 kept it in the high-upside tier |
| RDP-15 | Multi-actor approval workflow | R2 | other | route-dependent | M | L | H | no | Proof campaigns, comments/sign-off model | Bet | R2 suggested a staged comment/sign-off workflow before full RBAC |
| RDP-16 | Agent/human governed release workspace story | R4, R5 | branding/SEO/growth | route-dependent | H | M | M | no | Chosen route, homepage copy, MCP/AI packaging | Wave 4 | R4-R5 explicitly reframed the product as a governed system for humans and agents rather than “just an AI tool” |

### Branding, SEO, And Distribution

| enhancement_id | Title | Archive Source | Category | Current Status | Impact | Cost | Risk | Direction-Agnostic | Dependencies | Recommended Wave | Evidence Anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GTM-01 | Protect the core product brand (`Prooflane`-style) instead of renaming to a generic `xxx.ai` | R4, R5 | branding/SEO/growth | exists-needs-enhancement | H | S | M | yes | Route decision, homepage copy | Wave 4 | R4 and R5 both argued that the brand should stay product-shaped, with `.ai` used as an entry asset rather than the whole identity |
| GTM-02 | `.ai` domain and AI-angle landing page | R4, R5 | branding/SEO/growth | new-feature | M | S | L | yes | Brand, SEO plan, route-specific copy | Wave 4 | R4 suggested `prooflane.ai`; R5 reinforced a separate AI landing/campaign page strategy |
| GTM-03 | Three-layer naming system: brand / traffic / feature | R5 | branding/SEO/growth | new-feature | M | S | L | yes | Product naming discipline | Wave 4 | R5 explicitly split naming into brand layer, traffic layer, and feature layer |
| GTM-04 | Homepage, SEO, GitHub, Product Hunt, and social copy pack | R4, R5 | branding/SEO/growth | new-feature | H | M | M | no | Route choice, positioning | Wave 4 | R4-R5 both proposed sharper hero, subtitle, GitHub description, PH tagline, X bio, and SEO wording |
| GTM-05 | Hosted public demo surface / public sandbox | R2, R5 | public demo / external distribution | route-dependent | M | L | H | no | Public boundary enforcement, demo infra | Bet | R2 listed hosted public demo surface; R5 refined it into a public-safe guided sample |

### Alternate Route: Universal WebUI Stress Lab

| enhancement_id | Title | Archive Source | Category | Current Status | Impact | Cost | Risk | Direction-Agnostic | Dependencies | Recommended Wave | Evidence Anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STR-01 | Reposition the product as an AI-native stress lab for any URL / any WebUI | R6 | stress-lab realignment | new-direction | H | M | H | no | Route decision | Wave 3 (Route B) | R6 explicitly reframed the product around stress, resilience, performance, and any-URL WebUI testing |
| STR-02 | URL-first entry: “give me a URL and test it” | R6 | stress-lab realignment | new-feature | H | M | H | no | Arbitrary target onboarding, safety guardrails | Wave 3 (Route B) | R6 proposed replacing workflow/review-first entry with URL + scenario + stress profile |
| STR-03 | Elevate `load`, `perf`, `explore`, and `chaos` to first-class product pillars | R6 | stress-lab realignment | exists-needs-enhancement | H | M | M | no | Homepage, navigation, reporting | Wave 3 (Route B) | R6 said these are currently capability slices and would need promotion to first-line product surfaces |
| STR-04 | Arbitrary URL onboarding, target discovery, and scope guidance | R6 | stress-lab realignment | new-feature | H | L | H | no | URL policy model, target discovery UX | Wave 3 (Route B) | R6 argued the current governed target model is not the same as “test any webpage” |
| STR-05 | Stress, perf, and resilience report center | R6 | stress-lab realignment | route-dependent | H | L | H | no | Load/perf/chaos outputs, report UX | Wave 3 (Route B) | R6 proposed centering results around p95/p99, bottlenecks, hotspots, crash/timeout, and resilience summaries |
| STR-06 | Stress-lab MCP surface | R6 | MCP/tooling | route-dependent | M | M | H | no | Stress-lab route, tool semantics | Wave 3 (Route B) | R6 explicitly said the MCP surface would need reshaping if the repo returns to the original stress-lab mission |

