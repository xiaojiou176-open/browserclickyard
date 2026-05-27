#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"
source "$ROOT_DIR/scripts/lib/backend_lifecycle.sh"

BACKEND_PID=""
LOG_PATH=".runtime-cache/logs/k6-smoke-backend.log"
BACKEND_PORT="${TM_BACKEND_PORT:-17380}"
BASE_URL=""
HEALTH_RETRIES="${K6_SMOKE_BACKEND_HEALTH_RETRIES:-}"
HEALTH_INTERVAL="${K6_SMOKE_BACKEND_HEALTH_INTERVAL:-1}"

cleanup() {
  stop_pid_if_running "$BACKEND_PID"
}
trap cleanup EXIT

if ! validate_port_number "$BACKEND_PORT" "TM_BACKEND_PORT"; then
  exit 1
fi
if ! BACKEND_PORT="$(find_available_port "$BACKEND_PORT" 50)"; then
  echo "error: no available backend port from ${TM_BACKEND_PORT:-17380} to $(( ${TM_BACKEND_PORT:-17380} + 49 ))"
  exit 1
fi
BASE_URL="http://127.0.0.1:$BACKEND_PORT"

if [[ -z "$HEALTH_RETRIES" ]]; then
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    HEALTH_RETRIES=120
  else
    HEALTH_RETRIES=60
  fi
fi

if command -v k6 >/dev/null 2>&1; then
  echo "[k6-smoke] backend health wait budget: retries=${HEALTH_RETRIES}, interval=${HEALTH_INTERVAL}s"
  ensure_backend_running "$BASE_URL" "$BACKEND_PORT" "$LOG_PATH" "k6-smoke" "$HEALTH_RETRIES" "$HEALTH_INTERVAL"
  echo "[k6-smoke] running smoke script"
  BASE_URL="$BASE_URL" k6 run --address 127.0.0.1:0 tooling/automation/load/reconstruction-smoke.js
  exit 0
fi

if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "[k6-smoke] k6 binary is required in CI mode but was not found"
  echo "[k6-smoke] install k6 in workflow before invoking this gate"
  exit 1
fi

echo "[k6-smoke] k6 binary not found, validating converter tool instead"
pnpm --dir tooling/automation exec har-to-k6 --version >/dev/null
echo "[k6-smoke] skipped runtime load execution (k6 missing)"
