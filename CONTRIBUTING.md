# Contributing

This repository is public and maintainer-operated.
Contributions are welcome, but every change must keep the public surface,
runtime boundary, and governance gates aligned with the repository truth
surfaces.

## Local setup

- `./scripts/setup.sh`

## Default local checks before PR

- `pnpm gate:repo:fast`
- `pnpm test:matrix`
- `pnpm verify:all`
- `pnpm prepush:quality-gate`

## Verification Layers

Browserclickyard deliberately keeps the local default path lighter than the cloud
paths.

- **pre-commit**: `.pre-commit-config.yaml` runs lightweight correctness,
  docs, and secret guards before code leaves your workstation.
- **pre-push**: `pnpm prepush:quality-gate` is the default light local path;
  use `pnpm prepush:quality-gate:parity` only when you need the full parity
  lane locally.
- **hosted PR / CI**: `.github/workflows/pr.yml` and `.github/workflows/ci.yml`
  carry the heavier required cloud checks.
- **nightly**: `.github/workflows/nightly.yml` owns the deterministic nightly
  gate plus deeper manual-only observability.
- **manual**: protected-environment workflow_dispatch lanes handle the truly
  heavy or sensitive checks such as live external, desktop, and privileged
  audits.

Use `pnpm test:matrix:full`, `pnpm verify:all:parity`, `pnpm doctor:repo`,
`pnpm gate:delivery:fast`, and `pnpm audit:oss:redaction` when the change
really needs parity, release-boundary, or public-claim acceptance.

## Pull request requirements

- Update docs when behavior/config/API changes.
- Add or update tests for every logic change.
- Do not commit secrets or runtime artifacts.
- Keep all Markdown and repo-facing docs English-only.
- Route product questions, ideas, and show-and-tell posts to GitHub Discussions
  before opening a new issue.
- Do not reintroduce deleted historical reports, rehearsal notes, or internal-only runbooks.
- Follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) when participating in
  reviews or discussion.
- Use [`.github/pull_request_template.md`](./.github/pull_request_template.md)
  as the canonical PR submission template.
