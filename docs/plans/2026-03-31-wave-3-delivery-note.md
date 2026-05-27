# Wave 3 Delivery Note

## Scope

This round did not continue growing the release-decision-plane story as the
front door. It started the Route B realignment:

- **bring the original WebUI stress-lab vision back to the front**
- **keep the Prompt 1-3 substrate intact**
- **move proof / AI / MCP / review into the deeper layer instead of deleting them**

## What Changed

### Command Center Product Surface

Primary surfaces shifted toward a clearer Route B story:

- `Stress Lab` becomes the URL-first / experiment-first entry
- `Runs & Blocks` becomes the result and blocker inbox
- `Flow Studio` becomes the journey-refinement surface
- `Advanced Review` becomes the optional governed compare layer

Primary files touched in this round:

- `apps/command-center/src/App.tsx`
- `apps/command-center/src/components/HelpPanel.tsx`
- `apps/command-center/src/components/OnboardingTour.tsx`
- `apps/command-center/src/components/TaskListPanel.tsx`
- `apps/command-center/src/views/TaskCenterView.tsx`
- `apps/command-center/src/views/ReviewBoardView.tsx`
- associated focused tests

What changed in plain language:

- the in-app help and first-run tour stop teaching Review Board as the default
  destination
- the result path is now explained as:
  target URL -> lab mode -> result -> optional deep review
- Review Board is explicitly framed as the governed comparison layer you open
  **after** a result exists

### Docs Front Door

The front door now tells the same story as the app:

- `README.md`
- `docs/get-started.md`
- `docs/index.md`
- `docs/why-browserclickyard.md`
- `docs/proof-center.md`

What changed:

- README now describes Browserclickyard as an **AI-native WebUI stress lab**
- the honest MVP boundary is stated as
  `localhost-first / governed-target-first`
- the local governed experiment path now points at
  `deep-localhost + web.any-localhost + --base-url`
- proof/review/AI/MCP are described as deeper governed layers rather than the
  first thing a new user must understand

## Why These Changes Came First

Route B could not be made real by changing a slogan alone.

The highest-value thin slice was:

1. change the app shell language
2. change the docs front door language
3. keep the existing substrate honest about its current safe boundary

That is the minimum slice that makes the repo feel like a stress lab instead of
just a renamed review product.

## What This Round Did Not Try To Do

- it did not delete the Prompt 1-3 decision / proof / AI / MCP substrate
- it did not open arbitrary public-web testing by default
- it did not do branding, SEO, Product Hunt, or public-demo packaging
- it did not solve every older Wave 2 blocker that is orthogonal to Route B

## Evidence

- `apps/command-center` focused vitest slice passed for:
  - help / onboarding
  - quick-launch first-use
  - task-center route-B waiting/result path
  - advanced-review shell
- targeted frontend eslint passed on the touched Route B files
- `bash scripts/docs-gate.sh` only failed on pre-existing root/workspace
  pollution:
  - `.venv`
  - `workspace`
  - existing generated/runtime residue such as `dist`, `__pycache__`, nested
    `workspace/node_modules`, and template `.cache`
- Wave 3 realignment note added
- master execution plan updated with Route B progress
- blocker-only reviewer output is recorded in this round's final report
