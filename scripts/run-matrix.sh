#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/heartbeat.sh"

RUN_ID_BASE="${RUN_ID_BASE:-${1:-matrix-$(date +%Y%m%d%H%M%S)-$$}}"
NIGHTLY_RUN_ID="${RUN_ID_BASE}-nightly"
DESKTOP_RUN_ID_PREFIX="${RUN_ID_BASE}-desktop"
SEEN_RUN_IDS=""
SHORT_GATE_ENABLED="${UIQ_RUN_MATRIX_SHORT_GATE_ENABLED:-1}"
SHORT_GATE_CMD="${UIQ_RUN_MATRIX_SHORT_GATE_CMD:-./scripts/preflight.sh minimal}"

ensure_unique_run_id() {
  local run_id="$1"
  local run_dir=".runtime-cache/artifacts/runs/${run_id}"

  if printf '%s\n' "$SEEN_RUN_IDS" | grep -Fxq "$run_id"; then
    echo "error: duplicate run-id in current matrix: ${run_id}"
    exit 1
  fi
  if [ -e "$run_dir" ]; then
    echo "error: run-id already exists: ${run_id}"
    echo "please set RUN_ID_BASE to a new value and retry"
    exit 1
  fi

  SEEN_RUN_IDS="${SEEN_RUN_IDS}${run_id}"$'\n'
}

ensure_unique_run_id "$NIGHTLY_RUN_ID"

if [[ "$SHORT_GATE_ENABLED" == "1" ]]; then
  echo "[short-gate] ${SHORT_GATE_CMD}"
  uiq_run_with_heartbeat "run-matrix.short-gate" -- bash -lc "$SHORT_GATE_CMD"
else
  echo "[short-gate] skipped (UIQ_RUN_MATRIX_SHORT_GATE_ENABLED=${SHORT_GATE_ENABLED})"
fi

echo "matrix.run_id_base=${RUN_ID_BASE}"
echo "nightly.run_id=${NIGHTLY_RUN_ID}"
echo "desktop.run_id_prefix=${DESKTOP_RUN_ID_PREFIX}"

pids=()
names=()
heartbeat_pids=()

(
  echo "[nightly] start"
  pnpm uiq run --profile nightly --target web.ci --run-id "$NIGHTLY_RUN_ID"
) &
pid="$!"
pids+=("$pid")
names+=("nightly")
heartbeat_pids+=("$(uiq_start_pid_heartbeat "run-matrix.nightly" "$pid" "$(uiq_read_heartbeat_interval)")")

(
  echo "[desktop] start"
  RUN_ID_PREFIX="$DESKTOP_RUN_ID_PREFIX" ./scripts/verify-desktop-soak.sh
) &
pid="$!"
pids+=("$pid")
names+=("desktop")
heartbeat_pids+=("$(uiq_start_pid_heartbeat "run-matrix.desktop" "$pid" "$(uiq_read_heartbeat_interval)")")

failed=()
for i in "${!pids[@]}"; do
  if wait "${pids[$i]}"; then
    uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
    echo "[${names[$i]}] passed"
  else
    uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
    echo "[${names[$i]}] failed"
    failed+=("${names[$i]}")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "matrix failed: ${failed[*]}"
  exit 1
fi

echo "matrix complete"
echo "nightly_manifest=.runtime-cache/artifacts/runs/${NIGHTLY_RUN_ID}/manifest.json"
