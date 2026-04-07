# API Service

`services/api/` contains the FastAPI control plane for automation, runtime
governance, and security-sensitive service logic.

## Module Boundaries

- `app/api/`: HTTP routing and request validation
- `app/services/`: business logic and orchestration services
- `app/core/`: runtime infrastructure and shared control-plane services
- `app/models/`: domain and API data models
- `alembic/`: database migrations
- `tests/`: backend unit and integration tests

## Constraints

- New backend behavior belongs in `app/services/` unless it is purely transport
  or validation logic.
- Security flows must stay aligned with the backend access-control layer.
- Configuration changes must update `.env.example` and
  `docs/reference/configuration.md`.

## Gate Commands

- `uv run --extra dev pytest -q`
- `bash scripts/lint-all.sh`
- `bash scripts/verify-all.sh`
