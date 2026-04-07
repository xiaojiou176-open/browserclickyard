# Quality Gates

This page is the compact operator reference for repo-level and run-level gate
semantics.

## Repo Gate Commands

The exact repo-level command contract lives in:

- `docs/ai/agent-guide.md`
- `package.json`
- `scripts/`

This page keeps only the compact semantics so it does not become a second
hand-maintained command index.

## Run Evidence Contract

- The canonical run evidence source is `.runtime-cache/artifacts/runs/<runId>/`.
- `manifest.json` is the canonical run contract file.
- Run gate status is sourced from `manifest.gateResults.status`.
- Individual run checks are sourced from `manifest.gateResults.checks[]`.
- A non-pass result must include a reason code or equivalent blocking detail.

## CI Gate Expectations

- Current aggregate-check wiring and threshold details live in
  `docs/reference/ci-governance.md`.
- Repo-side parity commands use container entrypoints for docs, lint, test, and
  verify flows.
- Fast paths are diagnostic shortcuts only and must not replace parity evidence.

## Release and Safety Notes

- Fast repo hygiene must reject tracked secrets, raw runtime artifacts, personal
  identifiers, and machine-local absolute paths through
  `pnpm gate:sensitive-surfaces`.
- GitHub-side secret-scanning and code-scanning open alerts must stay at zero
  through `pnpm gate:github:security-alerts` before release or public closeout.
- Pull requests that change dependencies must also pass the dedicated
  Dependency Review workflow before closeout is considered honest.
- GitHub Actions changes now have a dedicated `zizmor` audit surface across
  both workflows and local composite actions under `.github/`, and tracked repo
  contents now have a dedicated Trivy filesystem audit surface; these are
  complementary to `actionlint`, not replacements.
- Public code visibility does not make runtime artifacts public-safe by default.
- Redaction and publication review must run through `pnpm audit:oss:redaction`.
- The OSS redaction audit must cover current worktree, git history, a fresh
  clone, and GitHub-facing issue/PR text surfaces when credentials are
  available.
- Secret scanning, push protection, branch protection, and code review gates are
  part of the release boundary, not optional polish.
