# Proof Center

This page is the public map for what Pagestress is willing to prove in the open,
what remains private by default, and where to inspect the deeper governed
evidence **after** a stress-lab result becomes worth preserving.

> Public proof here follows one storefront rule: **one public-safe sample, one
> proof map, no mock evidence pretending to be public proof**.

## Public Proof Surfaces

These are the public surfaces that explain how the platform works and how it
governs itself.

| Surface | What it proves | Link |
| --- | --- | --- |
| Public-safe guided demo | How a new reader should understand the stress-lab front door, the result path, and the deeper proof layer without local setup | [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md) |
| Public-safe proof sample | A schema-faithful sanitized slice of a governed run bundle that is safe to inspect publicly | [docs/examples/public-proof-sample/README.md](./examples/public-proof-sample/README.md) |
| Product front door | What the repo is, who it is for, and how to start | [README.md](../README.md) |
| Architecture contract | The canonical runtime and execution model | [docs/architecture.md](./architecture.md) |
| CI governance | Required aggregate checks and threshold model | [docs/reference/ci-governance.md](./reference/ci-governance.md) |
| Public boundary | The repo-side public boundary statement plus the audit paths required before restating live GitHub settings as current fact | [docs/reference/public-readiness.md](./reference/public-readiness.md) |
| Public artifact policy | Which artifact classes are allowed to become public-safe | [docs/reference/public-artifact-policy.md](./reference/public-artifact-policy.md) |
| Shipping history | What has changed recently | [CHANGELOG.md](../CHANGELOG.md) |
| First public release notes | How the repo now presents its first public launch surface | [docs/releases/v0.1.0-public-launch.md](./releases/v0.1.0-public-launch.md) |
| Historical closure snapshot | What was closed out to make the repository publicly maintainable at the time of the first public release | [docs/releases/v0.1.0-public-closure.md](./releases/v0.1.0-public-closure.md) |
| Discussions and releases | How the public conversation and shipping rhythm evolve | [GitHub Discussions](https://github.com/xiaojiou176-open/pagestress/discussions), [GitHub Releases](https://github.com/xiaojiou176-open/pagestress/releases) |

Current GitHub-side metadata and enforcement remain audit-backed states. This
page should point you at the proof path, not quietly replace the latest
public-surface or branch-protection audit artifact.

## Single Public-Safe Proof Sample

Pagestress keeps exactly one public-safe sample surface in this repo:
[docs/examples/public-proof-sample/README.md](./examples/public-proof-sample/README.md).

What it is:

- A sanitized, schema-faithful example of the summary and manifest fields that
  external readers can inspect safely
- A concrete sample that this page can link to without exposing private runtime
  bundles

What it is not:

- Not a broad runtime artifact bundle
- Not a log dump, screenshot pack, or failure bundle
- Not a claim that every private artifact is public-safe

## Public-Safe Vs Private-Only

Pagestress is public, but not every runtime artifact is public-safe.

### Public-safe by policy

- Branch protection audit summaries
- Explicitly allowlisted CI artifacts
- Product docs, architecture contracts, and public references

### Private-only by default

- Broad run artifacts under `.runtime-cache/artifacts/runs/`
- Failure bundles
- Runtime logs
- Sensitive replay or debugging outputs

### Internal design evidence, not public proof

- `scripts/usability/lane-d-usability.ts` generates a mock-backed design
  experiment for internal usability learning
- It is useful for interaction tuning, but it is not the repo's public proof
  sample
- If a public page needs an inspectable example, it should link the single
  public-safe sample above instead of lane-d outputs

The exact policy is tracked in
[docs/reference/public-artifact-policy.md](./reference/public-artifact-policy.md).

If you want a product-shaped walkthrough before inspecting the sample itself,
open the [public-safe guided demo](./examples/public-stress-lab-guided-demo.md).

## Not In The Current Public Machine-Verifiable Proof Set

The following surfaces are intentionally **not** claimed as publicly proven by
this repo today:

- AI findings dashboards that do not expose a stable public API or published
  artifact
- Internal code-quality dashboards that are only visible through maintainer
  credentials or unpublished workflow views

If these surfaces become publicly queryable later, they should be promoted into
this page only after the proof path is machine-verifiable and documented.

## What "Proof" Means In Pagestress

Proof is not a marketing word here. In this repo, it means at least one of the
following:

- A canonical contract that explains the intended behavior
- A gate model that defines what must pass
- A published artifact or summary that can be inspected later
- A release or discussion trail that shows how the public surface evolves

This is also why the operator UI and the pagestress are related but different:

- Stress Lab starts commands and workflow runs
- Runs & Blocks tracks status and manual gates
- Advanced Review helps compare governed evidence
- The governed pagestress is still the source of release-grade proof

Not every visible panel is proof. Proof is the part that remains inspectable
after the moment has passed.

## What We Are Making More Visible

The repo is actively moving proof out of hidden folders and into public-facing
surfaces:

- One public-safe proof sample under `docs/examples/public-proof-sample/`
- Product-facing visuals in `docs/assets/`
- Alt text registry for public visuals in `docs/assets/ALT_TEXT.md`
- Public docs that explain results first and governance second
- A release-story document that explains the first public launch in user-facing language
- Release notes and changelog history
- Discussions as a durable public context layer

![Pagestress proof stack showing product story, contract truth, public-safe artifacts, and private-only runtime evidence boundaries.](./assets/pagestress-proof-stack.svg)

## If You Want To Go Deeper

- Product story: [docs/why-pagestress.md](./why-pagestress.md)
- Guided walkthrough: [docs/examples/public-stress-lab-guided-demo.md](./examples/public-stress-lab-guided-demo.md)
- Result-first quickstart: [docs/get-started.md](./get-started.md)
- First release notes: [docs/releases/v0.1.0-public-launch.md](./releases/v0.1.0-public-launch.md)
- Historical closure snapshot: [docs/releases/v0.1.0-public-closure.md](./releases/v0.1.0-public-closure.md)
- Visual asset alt text: [docs/assets/ALT_TEXT.md](./assets/ALT_TEXT.md)
- Full docs map: [docs/index.md](./index.md)
