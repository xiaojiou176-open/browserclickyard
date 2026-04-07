# Security Policy

Prooflane is public, but security handling remains private by default.
Security reports must avoid public issue threads and use the private advisory
flow.

## Reporting

- Open a private security advisory at `https://github.com/xiaojiou176-open/ui-automation-control-plane/security/advisories/new`
- If advisories are unavailable in your environment, contact repository maintainers directly instead of posting details in public issues.

## Sensitive data handling

- Never store API keys, tokens, passwords, or CSRF secrets in repo files.
- Never commit local absolute host paths such as `/Users/...`, `/home/<user>/...`,
  `C:\\Users\\...`, or private temp roots such as `/private/var/folders/...`.
- Runtime artifacts are under `.runtime-cache/`; treat them as sensitive.
- Manage env schema via `configs/env/contract.yaml`; generate `.env.example` from contract, never commit real secrets.
- Enforce env drift checks in CI with `pnpm env:governance:check:strict`.
- Keep agent state, cache, runtime outputs, and logs outside the tracked public surface.
- Run `pnpm gate:sensitive-surfaces` before merge for fast tracked-surface checks,
  and `pnpm audit:oss:redaction` before release or public claims for deep
  Git history and GitHub-facing redaction audits.
- Dependency-changing pull requests must pass the dedicated Dependency Review
  workflow, and workflow changes must pass both `actionlint` and the dedicated
  `zizmor` workflow audit.
- Repo-side vulnerability scanning now includes a dedicated Trivy filesystem
  audit workflow in addition to CodeQL and GitHub alert checks.

## Hard requirements

- Production/staging must configure `AUTOMATION_API_TOKEN`.
- `AUTOMATION_ALLOW_LOCAL_NO_TOKEN` must remain `false` outside local development.
