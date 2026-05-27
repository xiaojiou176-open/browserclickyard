# Assistant Guide Entry

## Project Purpose

This repository maintains a browser automation governance and verification
platform with a public code boundary and private-by-default runtime evidence.

## Tech Stack

- TypeScript
- Python 3.12
- Playwright
- FastAPI
- pnpm workspace

## Navigation

- Canonical execution rules: `docs/ai/agent-guide.md`
- Canonical architecture contract: `docs/architecture.md`
- Documentation entrypoint: `docs/index.md`
- Public boundary truth: `docs/reference/public-readiness.md`

## Gate Commands

- `pnpm gate:repo:fast`
- `pnpm test:matrix`
- `pnpm verify:all`
- `pnpm prepush:quality-gate`
- `pnpm test:matrix:full`
- `pnpm verify:all:parity`
- `pnpm prepush:quality-gate:parity`

## Execution Notes

- Treat this file as a short adapter. If it conflicts with canonical guidance,
  `docs/ai/agent-guide.md` wins.
- Docs must remain English-only.
- Repo-owned runtime, cache, log, and agent state must stay untracked.
