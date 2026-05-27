#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/heartbeat.sh"

RUN_SUFFIX="${RUN_ID_PREFIX:-$(date +%Y%m%d%H%M%S)-$$}"
TAURI_RUN_BASE="verify-tauri-soak-${RUN_SUFFIX}"
SWIFT_RUN_BASE="verify-swift-soak-${RUN_SUFFIX}"
TAURI_RUN_ID=""
SWIFT_RUN_ID=""
SHORT_GATE_ENABLED="${UIQ_DESKTOP_SOAK_SHORT_GATE_ENABLED:-1}"

ensure_unique_run_id() {
  local run_id="$1"
  local run_dir=".runtime-cache/artifacts/runs/${run_id}"
  if [ -e "$run_dir" ]; then
    echo "error: run-id already exists: ${run_id}"
    echo "please set a new RUN_ID_PREFIX and retry"
    exit 1
  fi
}

run_short_gate() {
  if [[ "$SHORT_GATE_ENABLED" != "1" ]]; then
    echo "short-first gate skipped (UIQ_DESKTOP_SOAK_SHORT_GATE_ENABLED=${SHORT_GATE_ENABLED})"
    return 0
  fi

  local tauri_smoke_run_id="${TAURI_RUN_BASE}-smoke"
  ensure_unique_run_id "$tauri_smoke_run_id"
  echo "[short-gate] tauri smoke run_id=${tauri_smoke_run_id}"
  uiq_run_with_heartbeat "verify-desktop-soak.short-gate.tauri-smoke" -- \
    pnpm uiq run --profile tauri.smoke --target tauri.macos --run-id "$tauri_smoke_run_id"

  if [ -z "${SWIFT_BUNDLE_ID:-}" ]; then
    echo "[short-gate] swift smoke skipped: SWIFT_BUNDLE_ID is not set"
    return 0
  fi

  local swift_smoke_run_id="${SWIFT_RUN_BASE}-smoke"
  ensure_unique_run_id "$swift_smoke_run_id"
  echo "[short-gate] swift smoke run_id=${swift_smoke_run_id}"
  uiq_run_with_heartbeat "verify-desktop-soak.short-gate.swift-smoke" -- \
    pnpm uiq run --profile swift.smoke --target swift.macos --run-id "$swift_smoke_run_id" --bundle-id "$SWIFT_BUNDLE_ID"
}

run_with_retry() {
  local profile="$1"
  local target="$2"
  local run_base="$3"
  local extra_arg_name="${4:-}"
  local extra_arg_value="${5:-}"
  local max_attempts=2

  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    local run_id="${run_base}-a${attempt}"
    ensure_unique_run_id "$run_id"
    echo "[$attempt/$max_attempts] profile=${profile} target=${target} run_id=${run_id}"
    local cmd=(pnpm uiq run --profile "$profile" --target "$target" --run-id "$run_id")
    if [ -n "$extra_arg_name" ]; then
      cmd+=("$extra_arg_name" "$extra_arg_value")
    fi
    if uiq_run_with_heartbeat "verify-desktop-soak.${profile}.${target}.attempt-${attempt}" -- "${cmd[@]}"; then
      RUN_WITH_RETRY_LAST_RUN_ID="$run_id"
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "retrying ${profile} after transient failure"
      sleep 2
    fi
    attempt=$((attempt + 1))
  done

  RUN_WITH_RETRY_LAST_RUN_ID="${run_base}-a${max_attempts}"
  return 1
}

echo "[0/2] short-first gate"
run_short_gate

echo "[1/2] tauri soak profile"
run_with_retry "tauri.soak" "tauri.macos" "$TAURI_RUN_BASE"
TAURI_RUN_ID="$RUN_WITH_RETRY_LAST_RUN_ID"

echo "[2/2] swift soak profile"
# Keep Quotio defaults unchanged here. `swift.macos` keeps an empty default
# bundleId, so this path must require an explicit `SWIFT_BUNDLE_ID` or `--bundle-id`.
if [ -z "${SWIFT_BUNDLE_ID:-}" ]; then
  echo "Skipping swift soak: SWIFT_BUNDLE_ID is not set (target default is empty)"
  SWIFT_RUN_ID=""
else
  run_with_retry "swift.soak" "swift.macos" "$SWIFT_RUN_BASE" "--bundle-id" "$SWIFT_BUNDLE_ID"
  SWIFT_RUN_ID="$RUN_WITH_RETRY_LAST_RUN_ID"
fi

echo "DONE"
echo "tauri_manifest=.runtime-cache/artifacts/runs/${TAURI_RUN_ID}/manifest.json"
if [[ -n "${SWIFT_RUN_ID:-}" ]]; then
  echo "swift_manifest=.runtime-cache/artifacts/runs/${SWIFT_RUN_ID}/manifest.json"
fi
