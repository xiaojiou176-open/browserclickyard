# Stress Lab Realignment Note

## Direction Checkpoint

Wave 3 executes **Route B**.

That means the repo now treats the original vision as the product front door:

> an AI-native WebUI stress lab for modern browser targets

This round does **not** delete the release-decision-plane substrate. Instead it
repositions it as the deeper governed layer.

## The New Surface Hierarchy

### Front door

- target URL / managed target
- experiment type
- launch configuration

### Primary operating path

- `Stress Lab`
- `Runs & Blocks`
- `Flow Studio`

### Deeper governed layer

- `Advanced Review`
- proof bundles
- AI summaries
- similar failures
- MCP workspace entrypoints

## Honest MVP Boundary

The current Route B story is intentionally narrower than “arbitrary public web
by default”.

The honest boundary is:

- `localhost-first`
- `web.any-localhost` as the flexible governed target
- `--base-url` for the specific local WebUI under test
- fail-closed outside explicit allowlists

This keeps the repo aligned with the real guardrails already implemented in the
orchestrator.

## Reused Substrate

Wave 3 is not a greenfield rewrite. It stands on:

- orchestrator commands for `load`, `perf`, `explore`, and `chaos`
- governed target/profile configs such as:
  - `configs/targets/web.any-localhost.yaml`
  - `configs/profiles/deep-localhost.yaml`
- governed run artifacts under `.runtime-cache/artifacts/runs/<runId>/`
- Prompt 1-3 proof / AI / MCP work as the deep-analysis layer

## What Changed In This Round

- app-shell wording changed from lane-first/review-first toward
  URL-first/capability-first
- docs front door changed to stress-lab-first
- Review Board wording changed to `Advanced Review`
- proof and public-boundary docs now explain themselves as the deeper layer,
  not the first stop

## What Must Wait For Prompt 5

- branding polish
- SEO titles and landing-page packaging
- public demo / hosted demo story
- growth/distribution copy
- broader route-specific public positioning
