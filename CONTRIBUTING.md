# Contributing

This repository is public and maintainer-operated.
Contributions are welcome, but every change must keep the public surface,
runtime boundary, and governance gates aligned with the repository truth
surfaces.

## Local setup

- `./scripts/setup.sh`

## Required checks before PR

- `pnpm gate:repo:fast`
- `pnpm doctor:repo`
- `pnpm gate:delivery:fast`
- `pnpm audit:oss:redaction`

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
