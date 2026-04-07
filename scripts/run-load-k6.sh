#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"
source "$ROOT_DIR/scripts/lib/backend_lifecycle.sh"
source "$ROOT_DIR/scripts/lib/heartbeat.sh"

if ! command -v k6 >/dev/null 2>&1; then
  echo "[k6] k6 binary is required for full load run"
  exit 1
fi

BACKEND_PID=""
LOG_PATH=".runtime-cache/logs/k6-full-backend.log"
BACKEND_PORT="${TM_BACKEND_PORT:-17380}"
BASE_URL=""
SHORT_GATE_ENABLED="${UIQ_LOAD_K6_SHORT_GATE_ENABLED:-1}"
SHORT_GATE_CMD="${UIQ_LOAD_K6_SHORT_GATE_CMD:-./scripts/run-load-k6-smoke.sh}"

run_short_gate() {
  if [[ "$SHORT_GATE_ENABLED" != "1" ]]; then
    echo "[k6] short-first gate skipped (UIQ_LOAD_K6_SHORT_GATE_ENABLED=${SHORT_GATE_ENABLED})"
    return 0
  fi
  echo "[k6] short-first gate: ${SHORT_GATE_CMD}"
  uiq_run_with_heartbeat "run-load-k6.short-gate" -- bash -lc "$SHORT_GATE_CMD"
}

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

run_short_gate

ensure_backend_running "$BASE_URL" "$BACKEND_PORT" "$LOG_PATH" "k6"
uiq_run_with_heartbeat "run-load-k6.k6-run" --log "$LOG_PATH" -- \
  env BASE_URL="$BASE_URL" k6 run --address 127.0.0.1:0 tooling/automation/load/reconstruction-smoke.js
