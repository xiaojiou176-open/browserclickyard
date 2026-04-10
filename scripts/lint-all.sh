#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${UIQ_CONTAINER_GATE_NAME:-}" ]]; then
  exec bash scripts/ci/run-gate-in-container.sh lint-all
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"
cleanup_node_artifacts() {
  uiq_cleanup_root_node_artifacts "$ROOT_DIR"
}

should_cleanup_node_artifacts_on_exit() {
  case "${UIQ_CONTAINER_GATE_NAME:-}" in
    ""|lint-all) return 0 ;;
    *) return 1 ;;
  esac
}

read_bool() {
  local raw="${1:-}"
  local fallback="${2:-0}"
  case "$raw" in
    1|true|TRUE|yes|YES|on|ON) echo "1" ;;
    0|false|FALSE|no|NO|off|OFF) echo "0" ;;
    "") echo "$fallback" ;;
    *) echo "$fallback" ;;
  esac
}

shared_node_bin_ready() {
  local bin_name="$1"
  bash scripts/lib/node-bin.sh "$bin_name" --version >/dev/null 2>&1
}

collect_missing_shared_bins() {
  local -a required_bins=("tsc" "eslint")
  local missing_bins=()
  local bin_name=""
  for bin_name in "${required_bins[@]}"; do
    if ! shared_node_bin_ready "$bin_name"; then
      missing_bins+=("$bin_name")
    fi
  done
  if [[ "${#missing_bins[@]}" -gt 0 ]]; then
    printf '%s\n' "${missing_bins[@]}"
  fi
}

ensure_shared_node_bins() {
  local -a missing_bins=()
  local repair_rc=0
  local repair_output=""
  local repair_verdict="ok"
  if uiq_capture_shared_link_repair "$ROOT_DIR" repair_output repair_verdict; then
    repair_rc=0
  else
    repair_rc=$?
  fi
  if [[ -n "$repair_output" ]]; then
    printf '%s\n' "$repair_output"
  fi
  if [[ "$repair_rc" -ne 0 ]] && [[ "$repair_verdict" == "hard-fail" ]]; then
    return "$repair_rc"
  fi
  mapfile -t missing_bins < <(collect_missing_shared_bins)
  if [[ "${#missing_bins[@]}" -eq 0 ]]; then
    if [[ "$repair_rc" -ne 0 ]]; then
      echo "[lint-all] shared-link repair reported non-essential dependency gaps; required bins are present, continuing"
    fi
    return 0
  fi

  echo "[lint-all] bootstrapping shared node deps (missing: ${missing_bins[*]})"
  bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile
  repair_rc=0
  repair_output=""
  repair_verdict="ok"
  if uiq_capture_shared_link_repair "$ROOT_DIR" repair_output repair_verdict; then
    repair_rc=0
  else
    repair_rc=$?
  fi
  if [[ -n "$repair_output" ]]; then
    printf '%s\n' "$repair_output"
  fi
  if [[ "$repair_rc" -ne 0 ]] && [[ "$repair_verdict" == "hard-fail" ]]; then
    return "$repair_rc"
  fi
  mapfile -t missing_bins < <(collect_missing_shared_bins)
  if [[ "${#missing_bins[@]}" -eq 0 ]]; then
    if [[ "$repair_rc" -ne 0 ]]; then
      echo "[lint-all] shared-link repair still reports non-essential dependency gaps after bootstrap; required bins are present, continuing"
    fi
    return 0
  fi

  echo "error: shared Node binaries still missing after bootstrap: ${missing_bins[*]}" >&2
  return 127
}

if should_cleanup_node_artifacts_on_exit; then
  trap cleanup_node_artifacts EXIT
fi
ensure_shared_node_bins

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOG_DIR="$ROOT_DIR/.runtime-cache/lint-all/$RUN_ID"
mkdir -p "$LOG_DIR"

CHECK_NAMES=()
CHECK_CMDS=()
CHECK_LOGS=()
CHECK_PIDS=()
FAILED_INDEXES=()
FAIL_COUNT=0

add_check() {
  local name="$1"
  local cmd="$2"
  CHECK_NAMES+=("$name")
  CHECK_CMDS+=("$cmd")
  CHECK_LOGS+=("$LOG_DIR/$name.log")
}

start_checks() {
  local i
  for i in "${!CHECK_NAMES[@]}"; do
    local name="${CHECK_NAMES[$i]}"
    local cmd="${CHECK_CMDS[$i]}"
    local log_file="${CHECK_LOGS[$i]}"
    echo "[lint-all] START $name -> $log_file"
    (
      set +e
      bash -lc "$cmd"
    ) >"$log_file" 2>&1 &
    CHECK_PIDS+=("$!")
  done
}

wait_checks() {
  local i
  local has_failure=0

  for i in "${!CHECK_NAMES[@]}"; do
    local name="${CHECK_NAMES[$i]}"
    local pid="${CHECK_PIDS[$i]}"
    local log_file="${CHECK_LOGS[$i]}"
    local exit_code=0

    if wait "$pid"; then
      exit_code=0
    else
      exit_code=$?
    fi

    if [[ "$exit_code" -eq 0 ]]; then
      echo "[lint-all] PASS  $name"
    else
      echo "[lint-all] FAIL  $name (exit=$exit_code, log=$log_file)"
      FAILED_INDEXES+=("$i")
      FAIL_COUNT=$((FAIL_COUNT + 1))
      has_failure=1
    fi
  done

  return "$has_failure"
}

print_failure_summary() {
  local idx
  echo "[lint-all] ===== FAILURE SUMMARY ====="
  for idx in "${FAILED_INDEXES[@]}"; do
    local name="${CHECK_NAMES[$idx]}"
    local cmd="${CHECK_CMDS[$idx]}"
    local log_file="${CHECK_LOGS[$idx]}"
    echo "[lint-all] check=$name"
    echo "[lint-all] cmd=$cmd"
    echo "[lint-all] log=$log_file"
    echo "[lint-all] ---- tail($name) ----"
    tail -n 40 "$log_file" || true
    echo "[lint-all] ----------------------"
  done
}

COMMAND_CENTER_ESLINT_CMD="cd apps/command-center && bash ../../scripts/lib/node-bin.sh eslint . -f json"
AUTOMATION_ESLINT_CMD="cd tooling/automation && bash ../../scripts/lib/node-bin.sh eslint . -f json"
SERVICE_API_RUFF_CMD="cd services/api && RUFF_CACHE_DIR=../../.runtime-cache/cache/ruff ../../scripts/lib/python-exec.sh ruff check ."

add_check "root-typecheck" "bash scripts/lib/pnpm-safe.sh typecheck"
add_check "command-center-eslint" "$COMMAND_CENTER_ESLINT_CMD"
add_check "automation-eslint" "$AUTOMATION_ESLINT_CMD"
add_check "service-api-ruff" "$SERVICE_API_RUFF_CMD"
if [[ "$(read_bool "${UIQ_SKIP_SENSITIVE_SURFACE_GATE:-}" 0)" != "1" ]]; then
  add_check "sensitive-surface-gate" "node scripts/ci/check-sensitive-surface-leaks.mjs"
else
  echo "[lint-all] skip sensitive-surface-gate (covered by upstream canonical gate)"
fi
add_check "host-safety-gate" "bash scripts/ci/host-safety-gate.sh"

echo "[lint-all] running ${#CHECK_NAMES[@]} checks in parallel"
start_checks

if wait_checks; then
  echo "[lint-all] PASS (logs: $LOG_DIR)"
  exit 0
fi

print_failure_summary
echo "[lint-all] FAIL ($FAIL_COUNT/${#CHECK_NAMES[@]} checks failed, logs: $LOG_DIR)"
exit 1
