# Command Center Frontend

`apps/command-center/` is the product frontend for the platform. It is the
primary operator UI for task creation, execution monitoring, and evidence
review.

## Module Boundaries

- `src/views/`: page-level composition
- `src/components/`: reusable UI components
- `src/hooks/`: state and API interaction logic
- `src/features/`: feature-domain modules
- `src/utils/` and `src/shared/`: shared helpers and shared UI logic
- `tests/e2e/` and `src/**/*.test.tsx`: end-to-end and unit tests

## Relationship To `tests/web-harness`

- `apps/command-center/` is the product UI.
- `tests/web-harness` is the CI and orchestrator harness.
- The two surfaces must not be treated as interchangeable frontends.

## Gate Commands

- `pnpm --dir apps/command-center dev`
- `pnpm --dir apps/command-center test`
- `pnpm test:e2e:frontend:critical`
