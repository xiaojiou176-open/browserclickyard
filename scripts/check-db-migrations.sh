#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIGRATION_DB_PATH="${DB_MIGRATION_DB_PATH:-$ROOT_DIR/.runtime-cache/migrations/ci-migration-check.db}"
SQL_DRY_RUN_OUTPUT="${DB_MIGRATION_SQL_OUT:-$ROOT_DIR/.runtime-cache/migrations/ci-migration-dry-run.sql}"

mkdir -p "$(dirname "$MIGRATION_DB_PATH")"
rm -f "$MIGRATION_DB_PATH" "$SQL_DRY_RUN_OUTPUT"

export DATABASE_URL="sqlite+pysqlite:///${MIGRATION_DB_PATH}"

echo "[migration-check] DATABASE_URL=$DATABASE_URL"
echo "[migration-check] upgrade head"
uv run --extra dev alembic -c services/api/alembic.ini upgrade head

echo "[migration-check] downgrade base"
uv run --extra dev alembic -c services/api/alembic.ini downgrade base

echo "[migration-check] upgrade head (again)"
uv run --extra dev alembic -c services/api/alembic.ini upgrade head

echo "[migration-check] dry-run SQL output"
uv run --extra dev alembic -c services/api/alembic.ini upgrade head --sql > "$SQL_DRY_RUN_OUTPUT"
echo "[migration-check] dry-run saved: $SQL_DRY_RUN_OUTPUT"
