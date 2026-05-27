#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"

CANONICAL_PIPELINE_PATH="Flow -> Template -> Run"
LEGACY_REGISTER_ALIAS="./scripts/run-register-flow.sh"
LEGACY_REGISTER_COMPAT_UNTIL="2026-06-30"

MODE="${1:-manual}"
FLOW="${2:-full}"
if [[ "$MODE" != "manual" && "$MODE" != "midscene" ]]; then
  echo "usage: ./scripts/run-pipeline.sh [manual|midscene] [full|ui-only]"
  exit 1
fi
if [[ "$FLOW" != "full" && "$FLOW" != "ui-only" ]]; then
  echo "usage: ./scripts/run-pipeline.sh [manual|midscene] [full|ui-only]"
  exit 1
fi
echo "pipeline path: ${CANONICAL_PIPELINE_PATH}"
echo "legacy register alias: ${LEGACY_REGISTER_ALIAS} (compat until ${LEGACY_REGISTER_COMPAT_UNTIL})"

BACKEND_LOG=".runtime-cache/logs/backend.log"
mkdir -p ".runtime-cache/logs"

PREFERRED_BACKEND_PORT="${BACKEND_PORT:-17380}"
BACKEND_PORT="$PREFERRED_BACKEND_PORT"
if ! validate_port_number "$BACKEND_PORT" "BACKEND_PORT"; then
  exit 1
fi
if ! BACKEND_PORT="$(find_available_port "$BACKEND_PORT" 50)"; then
  echo "error: no available backend port found from $PREFERRED_BACKEND_PORT to $(( PREFERRED_BACKEND_PORT + 49 ))"
  exit 1
fi
if [[ "$BACKEND_PORT" != "$PREFERRED_BACKEND_PORT" ]]; then
  echo "warn: port $PREFERRED_BACKEND_PORT is in use, pipeline backend fallback to $BACKEND_PORT"
fi
BASE_URL="http://127.0.0.1:${BACKEND_PORT}"
HEALTH_URL="${BASE_URL}/health/"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$ROOT_DIR/scripts/lib/python-exec.sh" uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for _ in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "error: backend not ready"
  echo "see log: $BACKEND_LOG"
  exit 1
fi

echo "[Flow] record (${MODE})"
if [[ "$MODE" == "manual" ]]; then
  (cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm record:manual)
else
  (cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm record:midscene)
fi

if [[ "$FLOW" == "ui-only" ]]; then
  echo "[Flow] ui-only complete"
  echo "artifacts: .runtime-cache/automation/"
  exit 0
fi

echo "[Flow] extract"
(cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm extract)
echo "[Template] generate-case"
(cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm generate-case)
echo "[Template] validate generated spec"
(cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm test tests/generated/register-from-har.generated.spec.ts)
echo "[Run] replay"
(cd tooling/automation && BASE_URL="$BASE_URL" AUTOMATION_PORT="$BACKEND_PORT" pnpm replay)

echo "pipeline complete"
echo "artifacts: .runtime-cache/automation/"
