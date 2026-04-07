#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"
source "$ROOT_DIR/scripts/lib/heartbeat.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

uiq_export_node_env "$ROOT_DIR"
test_matrix_shared_link_repair_rc=0
test_matrix_shared_link_repair_output=""
test_matrix_shared_link_repair_verdict="ok"
if uiq_capture_shared_link_repair "$ROOT_DIR" test_matrix_shared_link_repair_output test_matrix_shared_link_repair_verdict; then
  test_matrix_shared_link_repair_rc=0
else
  test_matrix_shared_link_repair_rc=$?
fi
if [[ -n "$test_matrix_shared_link_repair_output" ]]; then
  printf '%s\n' "$test_matrix_shared_link_repair_output"
fi
if [[ "$test_matrix_shared_link_repair_rc" -ne 0 ]] && [[ "$test_matrix_shared_link_repair_verdict" == "hard-fail" ]]; then
  exit "$test_matrix_shared_link_repair_rc"
fi
if [[ "$test_matrix_shared_link_repair_rc" -ne 0 ]]; then
  echo "[test-matrix] shared-link repair reported non-essential dependency gaps; continuing into selected suites"
fi

PNPM_SAFE="bash scripts/lib/pnpm-safe.sh"

require_host_diagnostic_reason() {
  local reason="${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON:-}"
  if [[ -z "${reason// }" ]]; then
    echo "error: UIQ_ALLOW_HOST_GATE_DIAGNOSTIC=1 requires UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON" >&2
    exit 1
  fi
}

if [[ -z "${UIQ_CONTAINER_GATE_NAME:-}" ]]; then
  if [[ "${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC:-0}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
    require_host_diagnostic_reason
    echo "warn: running test-matrix on host diagnostic path. reason=${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON}"
  else
    if [[ -n "${1:-}" ]]; then
      export UIQ_TEST_MODE="$1"
    fi
    exec bash "$ROOT_DIR/scripts/ci/run-gate-in-container.sh" test-matrix
  fi
fi

read_bool() {
  local raw="${1:-}"
  local fallback="${2:-1}"
  case "$raw" in
    1|true|TRUE|yes|YES|on|ON) echo "1" ;;
    0|false|FALSE|no|NO|off|OFF) echo "0" ;;
    "") echo "$fallback" ;;
    *) echo "$fallback" ;;
  esac
}

read_positive_int() {
  local raw="${1:-}"
  local fallback="${2:-1}"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -gt 0 ]]; then
    echo "$raw"
    return
  fi
  echo "$fallback"
}

validate_pytest_workers() {
  local raw="$1"
  [[ "$raw" == "auto" || "$raw" =~ ^[1-9][0-9]*$ ]]
}

validate_percent_or_int_workers() {
  local raw="$1"
  [[ "$raw" =~ ^[1-9][0-9]*$ || "$raw" =~ ^([1-9][0-9]?|100)%$ ]]
}

validate_vitest_workers() {
  local raw="$1"
  [[ "$raw" =~ ^[1-9][0-9]*$ ]]
}

validate_worker_overrides() {
  local pytest_workers="$1"
  local web_workers="$2"
  local frontend_workers="$3"
  local vitest_workers="$4"
  if ! validate_pytest_workers "$pytest_workers"; then
    echo "error: UIQ_PYTEST_WORKERS must be 'auto' or a positive integer"
    return 1
  fi
  if ! validate_percent_or_int_workers "$web_workers"; then
    echo "error: UIQ_PLAYWRIGHT_E2E_WORKERS must be a positive integer or 1%-100%"
    return 1
  fi
  if ! validate_percent_or_int_workers "$frontend_workers"; then
    echo "error: UIQ_FRONTEND_E2E_WORKERS must be a positive integer or 1%-100%"
    return 1
  fi
  if ! validate_vitest_workers "$vitest_workers"; then
    echo "error: UIQ_VITEST_MAX_WORKERS must be a positive integer"
    return 1
  fi
  return 0
}

min_int() {
  local a="$1"
  local b="$2"
  if [[ "$a" -le "$b" ]]; then
    echo "$a"
  else
    echo "$b"
  fi
}

detect_cpu_count() {
  local n
  n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [[ "$n" -lt 1 ]]; then
    n=4
  fi
  echo "$n"
}

MODE="${1:-${UIQ_TEST_MODE:-parallel}}"
if [[ "$MODE" != "parallel" && "$MODE" != "serial" ]]; then
  echo "usage: ./scripts/test-matrix.sh [parallel|serial]"
  echo "or set UIQ_TEST_MODE=parallel|serial"
  exit 1
fi

SUITE_ORDER="${UIQ_SUITE_ORDER:-short-first}"
if [[ "$SUITE_ORDER" != "short-first" && "$SUITE_ORDER" != "as-is" ]]; then
  echo "error: UIQ_SUITE_ORDER must be short-first|as-is"
  exit 1
fi

RUN_WEB_E2E="$(read_bool "${UIQ_SUITE_WEB_E2E:-}" 1)"
RUN_FRONTEND_E2E="$(read_bool "${UIQ_SUITE_FRONTEND_E2E:-}" 1)"
RUN_E2E_AUTHENTICITY="$(read_bool "${UIQ_SUITE_E2E_AUTHENTICITY:-}" 1)"
RUN_FRONTEND_UNIT="$(read_bool "${UIQ_SUITE_FRONTEND_UNIT:-}" 1)"
RUN_BACKEND="$(read_bool "${UIQ_SUITE_BACKEND:-}" 1)"
RUN_TEST_TRUTH_GATE="$(read_bool "${UIQ_SUITE_TEST_TRUTH_GATE:-}" 1)"
RUN_AUTOMATION_CHECK="$(read_bool "${UIQ_SUITE_AUTOMATION_CHECK:-}" 1)"
RUN_ORCHESTRATOR_MCP="$(read_bool "${UIQ_SUITE_ORCHESTRATOR_MCP:-}" 1)"
DEFAULT_COVERAGE_GATE="1"
RUN_COVERAGE_GATE="$(read_bool "${UIQ_SUITE_COVERAGE_GATE:-${UIQ_VERIFY_ENABLE_COVERAGE_GATE:-$DEFAULT_COVERAGE_GATE}}" "$DEFAULT_COVERAGE_GATE")"
CI_CONTEXT="$(read_bool "${CI:-}" 0)"
MATRIX_ALLOW_CMD_OVERRIDE="$(read_bool "${UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE:-}" 0)"
DEFAULT_MUTATION_GATE="1"
RUN_MUTATION_GATE="$(read_bool "${UIQ_SUITE_MUTATION_GATE:-${UIQ_VERIFY_ENABLE_MUTATION_GATE:-$DEFAULT_MUTATION_GATE}}" "$DEFAULT_MUTATION_GATE")"
AUTOMATION_INSTALL_DEPS="$(read_bool "${UIQ_AUTOMATION_INSTALL_DEPS:-}" 0)"

if [[ "$RUN_MUTATION_GATE" == "1" && "$RUN_COVERAGE_GATE" != "1" ]]; then
  echo "info: mutation gate requires coverage gate; auto-enabling coverage"
  RUN_COVERAGE_GATE="1"
fi

if [[ "$RUN_WEB_E2E" != "1" && "$RUN_FRONTEND_E2E" != "1" && "$RUN_E2E_AUTHENTICITY" != "1" && "$RUN_FRONTEND_UNIT" != "1" && "$RUN_BACKEND" != "1" && "$RUN_TEST_TRUTH_GATE" != "1" && "$RUN_AUTOMATION_CHECK" != "1" && "$RUN_ORCHESTRATOR_MCP" != "1" && "$RUN_COVERAGE_GATE" != "1" && "$RUN_MUTATION_GATE" != "1" ]]; then
  echo "error: no suite selected"
  echo "set one of UIQ_SUITE_WEB_E2E/UIQ_SUITE_FRONTEND_E2E/UIQ_SUITE_E2E_AUTHENTICITY/UIQ_SUITE_FRONTEND_UNIT/UIQ_SUITE_BACKEND/UIQ_SUITE_TEST_TRUTH_GATE/UIQ_SUITE_AUTOMATION_CHECK/UIQ_SUITE_ORCHESTRATOR_MCP/UIQ_SUITE_COVERAGE_GATE/UIQ_SUITE_MUTATION_GATE=1"
  exit 1
fi

if [[ -n "${UIQ_WEB_PORT:-}" ]]; then
  UIQ_WEB_PORT="$UIQ_WEB_PORT"
elif [[ -n "${UIQ_E2E_PORT:-}" ]]; then
  UIQ_WEB_PORT="$UIQ_E2E_PORT"
else
  if ! UIQ_WEB_PORT="$(find_available_port 4173 200)"; then
    echo "error: no available UIQ_WEB_PORT found from 4173-4372"
    exit 1
  fi
fi
if [[ -n "${UIQ_WEB_APP_E2E_PORT:-}" ]]; then
  UIQ_WEB_APP_E2E_PORT="$UIQ_WEB_APP_E2E_PORT"
else
  if ! UIQ_WEB_APP_E2E_PORT="$(find_available_port 44173 200)"; then
    echo "error: no available UIQ_WEB_APP_E2E_PORT found from 44173-44372"
    exit 1
  fi
fi
UIQ_FRONTEND_E2E_PORT="${UIQ_FRONTEND_E2E_PORT:-43173}"
if [[ -n "${UIQ_FRONTEND_E2E_NONSTUB_PORT:-}" ]]; then
  UIQ_FRONTEND_E2E_NONSTUB_PORT="$UIQ_FRONTEND_E2E_NONSTUB_PORT"
else
  if ! UIQ_FRONTEND_E2E_NONSTUB_PORT="$(find_available_port 45173 200)"; then
    echo "error: no available UIQ_FRONTEND_E2E_NONSTUB_PORT found from 45173-45372"
    exit 1
  fi
fi
if [[ -n "${UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT:-}" ]]; then
  UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT="$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT"
else
  if ! UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT="$(find_available_port 28173 200)"; then
    echo "error: no available UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT found from 28173-28372"
    exit 1
  fi
fi
if ! [[ "$UIQ_WEB_PORT" =~ ^[0-9]+$ && "$UIQ_WEB_APP_E2E_PORT" =~ ^[0-9]+$ && "$UIQ_FRONTEND_E2E_PORT" =~ ^[0-9]+$ ]]; then
  echo "error: UIQ_WEB_PORT, UIQ_WEB_APP_E2E_PORT, and UIQ_FRONTEND_E2E_PORT must be integers"
  exit 1
fi
if ! [[ "$UIQ_FRONTEND_E2E_NONSTUB_PORT" =~ ^[0-9]+$ && "$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT" =~ ^[0-9]+$ ]]; then
  echo "error: UIQ_FRONTEND_E2E_NONSTUB_PORT and UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT must be integers"
  exit 1
fi
if [[ "$RUN_WEB_E2E" == "1" && "$RUN_FRONTEND_E2E" == "1" && "$UIQ_WEB_PORT" == "$UIQ_FRONTEND_E2E_PORT" ]]; then
  echo "error: UIQ_WEB_PORT and UIQ_FRONTEND_E2E_PORT must be different for concurrent e2e"
  exit 1
fi
if [[ "$RUN_WEB_E2E" == "1" && "$RUN_FRONTEND_E2E" == "1" && "$UIQ_WEB_APP_E2E_PORT" == "$UIQ_FRONTEND_E2E_PORT" ]]; then
  echo "error: UIQ_WEB_APP_E2E_PORT and UIQ_FRONTEND_E2E_PORT must be different for concurrent e2e"
  exit 1
fi
if [[ "$RUN_WEB_E2E" == "1" && "$UIQ_WEB_APP_E2E_PORT" == "$UIQ_WEB_PORT" ]]; then
  echo "error: UIQ_WEB_APP_E2E_PORT and UIQ_WEB_PORT must be different"
  exit 1
fi
if [[ "$UIQ_FRONTEND_E2E_NONSTUB_PORT" == "$UIQ_FRONTEND_E2E_PORT" || "$UIQ_FRONTEND_E2E_NONSTUB_PORT" == "$UIQ_WEB_PORT" || "$UIQ_FRONTEND_E2E_NONSTUB_PORT" == "$UIQ_WEB_APP_E2E_PORT" ]]; then
  echo "error: UIQ_FRONTEND_E2E_NONSTUB_PORT must be distinct from other apps/command-center/web ports"
  exit 1
fi
if [[ "$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT" == "$UIQ_FRONTEND_E2E_NONSTUB_PORT" ]]; then
  echo "error: UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT must differ from UIQ_FRONTEND_E2E_NONSTUB_PORT"
  exit 1
fi

LOG_BASE="${UIQ_TEST_LOG_DIR:-.runtime-cache/logs/test-matrix}"
RUN_ID="${UIQ_TEST_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
LOG_DIR="$LOG_BASE/$RUN_ID"
mkdir -p "$LOG_DIR"
FAILFAST_TERM_GRACE_SEC="${UIQ_FAILFAST_TERM_GRACE_SEC:-3}"
if ! [[ "$FAILFAST_TERM_GRACE_SEC" =~ ^[0-9]+$ ]]; then
  echo "error: UIQ_FAILFAST_TERM_GRACE_SEC must be an integer"
  exit 1
fi

PARALLEL_BUDGET_MODE="${UIQ_PARALLEL_BUDGET_MODE:-auto}"
CPU_COUNT="$(detect_cpu_count)"
DEFAULT_GLOBAL_BUDGET="$(( CPU_COUNT > 2 ? CPU_COUNT - 1 : 2 ))"
GLOBAL_BUDGET="$(read_positive_int "${UIQ_GLOBAL_WORKER_BUDGET:-}" "$DEFAULT_GLOBAL_BUDGET")"
DEFAULT_WAVE_SUITE_BUDGET="$GLOBAL_BUDGET"
if [[ "$DEFAULT_WAVE_SUITE_BUDGET" -gt 3 ]]; then
  DEFAULT_WAVE_SUITE_BUDGET=3
fi
WAVE_SUITE_BUDGET="$(read_positive_int "${UIQ_WAVE_SUITE_BUDGET:-}" "$DEFAULT_WAVE_SUITE_BUDGET")"
DEFAULT_SHORT_WAVE_SUITE_BUDGET="$WAVE_SUITE_BUDGET"
DEFAULT_LONG_WAVE_SUITE_BUDGET="$WAVE_SUITE_BUDGET"
if [[ "$DEFAULT_LONG_WAVE_SUITE_BUDGET" -gt 1 ]]; then
  DEFAULT_LONG_WAVE_SUITE_BUDGET=1
fi
SHORT_WAVE_SUITE_BUDGET="$(read_positive_int "${UIQ_SHORT_WAVE_SUITE_BUDGET:-}" "$DEFAULT_SHORT_WAVE_SUITE_BUDGET")"
LONG_WAVE_SUITE_BUDGET="$(read_positive_int "${UIQ_LONG_WAVE_SUITE_BUDGET:-}" "$DEFAULT_LONG_WAVE_SUITE_BUDGET")"
SELECTED_SUITE_COUNT=$(( RUN_WEB_E2E + RUN_FRONTEND_E2E + RUN_E2E_AUTHENTICITY + RUN_FRONTEND_UNIT + RUN_BACKEND + RUN_TEST_TRUTH_GATE + RUN_AUTOMATION_CHECK + RUN_ORCHESTRATOR_MCP + RUN_COVERAGE_GATE + RUN_MUTATION_GATE ))
SHORT_SUITE_COUNT=$(( RUN_E2E_AUTHENTICITY + RUN_FRONTEND_UNIT + RUN_TEST_TRUTH_GATE + RUN_AUTOMATION_CHECK + RUN_ORCHESTRATOR_MCP ))
LONG_SUITE_COUNT=$(( RUN_WEB_E2E + RUN_FRONTEND_E2E + RUN_BACKEND + RUN_COVERAGE_GATE + RUN_MUTATION_GATE ))
MAX_WAVE_SUITE_COUNT="$SHORT_SUITE_COUNT"
if [[ "$LONG_SUITE_COUNT" -gt "$MAX_WAVE_SUITE_COUNT" ]]; then
  MAX_WAVE_SUITE_COUNT="$LONG_SUITE_COUNT"
fi

if [[ "$PARALLEL_BUDGET_MODE" == "fixed" ]]; then
  echo "warn: UIQ_PARALLEL_BUDGET_MODE=fixed is deprecated; using auto"
  PARALLEL_BUDGET_MODE="auto"
fi

if [[ "$PARALLEL_BUDGET_MODE" != "auto" && "$PARALLEL_BUDGET_MODE" != "wave-aware" ]]; then
  echo "error: UIQ_PARALLEL_BUDGET_MODE must be auto|wave-aware (legacy alias: fixed)"
  exit 1
fi

if [[ "$MODE" == "parallel" && "$SELECTED_SUITE_COUNT" -gt 1 ]]; then
  ACTIVE_SUITE_COUNT="$SELECTED_SUITE_COUNT"
  if [[ "$PARALLEL_BUDGET_MODE" == "wave-aware" && "$SUITE_ORDER" == "short-first" && "$MAX_WAVE_SUITE_COUNT" -gt 0 ]]; then
    ACTIVE_SUITE_COUNT="$MAX_WAVE_SUITE_COUNT"
  fi

  PER_SUITE_BUDGET=$(( GLOBAL_BUDGET / ACTIVE_SUITE_COUNT ))
  if [[ "$PER_SUITE_BUDGET" -lt 1 ]]; then
    PER_SUITE_BUDGET=1
  fi
  UIQ_PYTEST_WORKERS_EFFECTIVE="$(min_int "$PER_SUITE_BUDGET" 6)"
  UIQ_PLAYWRIGHT_E2E_WORKERS_EFFECTIVE="$(min_int "$PER_SUITE_BUDGET" 6)"
  UIQ_FRONTEND_E2E_WORKERS_EFFECTIVE="$(min_int "$PER_SUITE_BUDGET" 6)"
  UIQ_VITEST_MAX_WORKERS_EFFECTIVE="$(min_int "$PER_SUITE_BUDGET" 6)"
else
  default_frontend_e2e_workers="6"
  if [[ "$CI_CONTEXT" == "1" ]]; then
    # Keep CI serial frontend-e2e concurrency aligned with Playwright config default.
    default_frontend_e2e_workers="4"
  fi
  UIQ_PYTEST_WORKERS_EFFECTIVE="${UIQ_PYTEST_WORKERS:-auto}"
  UIQ_PLAYWRIGHT_E2E_WORKERS_EFFECTIVE="${UIQ_PLAYWRIGHT_E2E_WORKERS:-6}"
  UIQ_FRONTEND_E2E_WORKERS_EFFECTIVE="${UIQ_FRONTEND_E2E_WORKERS:-$default_frontend_e2e_workers}"
  UIQ_VITEST_MAX_WORKERS_EFFECTIVE="${UIQ_VITEST_MAX_WORKERS:-6}"
  validate_worker_overrides \
    "$UIQ_PYTEST_WORKERS_EFFECTIVE" \
    "$UIQ_PLAYWRIGHT_E2E_WORKERS_EFFECTIVE" \
    "$UIQ_FRONTEND_E2E_WORKERS_EFFECTIVE" \
    "$UIQ_VITEST_MAX_WORKERS_EFFECTIVE"
fi

export UIQ_PYTEST_WORKERS="$UIQ_PYTEST_WORKERS_EFFECTIVE"
export UIQ_PLAYWRIGHT_E2E_WORKERS="$UIQ_PLAYWRIGHT_E2E_WORKERS_EFFECTIVE"
export UIQ_FRONTEND_E2E_WORKERS="$UIQ_FRONTEND_E2E_WORKERS_EFFECTIVE"
export UIQ_VITEST_MAX_WORKERS="$UIQ_VITEST_MAX_WORKERS_EFFECTIVE"
export UIQ_E2E_ORDER_MODE="$SUITE_ORDER"
export UIQ_WEB_PORT
export UIQ_WEB_APP_E2E_PORT
export UIQ_FRONTEND_E2E_DEFAULT_PORT="$UIQ_FRONTEND_E2E_PORT"
export UIQ_FRONTEND_E2E_NONSTUB_PORT
export UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT

suite_names=()
suite_cmds=()
suite_logs=()
suite_tiers=()
suite_modes=()
coverage_gate_cmd=""
coverage_gate_log=""
coverage_gate_mode="argv"
frontend_e2e_nonstub_cmd=""
frontend_e2e_nonstub_log=""
frontend_e2e_nonstub_mode="argv"
SUITE_CHAIN_DELIM=$'\x1f'

append_cmd_segment() {
  local current="$1"
  local segment="$2"
  if [[ -z "$current" ]]; then
    printf '%s' "$segment"
    return
  fi
  printf '%s%s%s' "$current" "$SUITE_CHAIN_DELIM" "$segment"
}

add_suite() {
  local name="$1"
  local cmd="$2"
  local log_file="$3"
  local tier="$4"
  local mode="${5:-argv}"
  suite_names+=("$name")
  suite_cmds+=("$cmd")
  suite_logs+=("$log_file")
  suite_tiers+=("$tier")
  suite_modes+=("$mode")
}

override_cmd_has_forbidden_chars() {
  local raw="$1"
  if [[ "$raw" == *$'\n'* || "$raw" == *$'\r'* || "$raw" == *$'\t'* ]]; then
    return 0
  fi
  case "$raw" in
    *";"*|*"|"*|*"&"*|*"<"*|*">"*|*"\\"*|*"\`"*|*"$"*|*"("*|*")"*|*"{"*|*"}"*|*"\""*|*"'"*|*"!"*|*"*"*|*"?"*|*"["*|*"]"*)
      return 0
      ;;
  esac
  return 1
}

override_cmd_allowed_executable() {
  local exe="$1"
  case "$exe" in
    true|false|pnpm|uv|node|python3|pytest)
      return 0
      ;;
  esac

  if [[ "$exe" == ./* || "$exe" == .runtime-cache/* ]]; then
    [[ -x "$exe" ]] && return 0
    return 1
  fi

  if [[ "$exe" == "$ROOT_DIR/"* ]]; then
    [[ -x "$exe" ]] && return 0
    return 1
  fi

  return 1
}

validate_override_cmd() {
  local suite_name="$1"
  local raw="$2"
  if [[ -z "$raw" ]]; then
    echo "error: empty override command for $suite_name"
    return 1
  fi
  if override_cmd_has_forbidden_chars "$raw"; then
    echo "error: invalid override command for $suite_name (forbidden shell metacharacter)"
    return 1
  fi

  local -a parts=()
  read -r -a parts <<< "$raw"
  if [[ "${#parts[@]}" -eq 0 ]]; then
    echo "error: invalid override command for $suite_name (no executable token)"
    return 1
  fi
  if [[ "${parts[0]}" == -* ]]; then
    echo "error: invalid override command for $suite_name (executable token cannot start with '-')"
    return 1
  fi
  for part in "${parts[@]}"; do
    if [[ ! "$part" =~ ^[A-Za-z0-9_./:@%+=,-]+$ ]]; then
      echo "error: invalid override command for $suite_name (unsafe token '$part')"
      return 1
    fi
  done
  if ! override_cmd_allowed_executable "${parts[0]}"; then
    echo "error: invalid override command for $suite_name (executable '${parts[0]}' is not allowlisted)"
    return 1
  fi
  return 0
}

RESOLVED_SUITE_CMD=""
RESOLVED_SUITE_MODE="argv"
resolve_suite_cmd() {
  local suite_name="$1"
  local default_cmd="$2"
  local override_cmd="${3:-}"
  RESOLVED_SUITE_CMD="$default_cmd"
  RESOLVED_SUITE_MODE="argv"
  if [[ "$MATRIX_ALLOW_CMD_OVERRIDE" == "1" && -n "$override_cmd" ]]; then
    validate_override_cmd "$suite_name" "$override_cmd"
    RESOLVED_SUITE_CMD="$override_cmd"
    RESOLVED_SUITE_MODE="argv"
  fi
}

if [[ "$RUN_WEB_E2E" == "1" ]]; then
  resolve_suite_cmd \
    "apps-web-e2e" \
    "bash scripts/lib/node-bin.sh playwright test -c tests/web-harness/tests/e2e/playwright.config.ts" \
    "${UIQ_TEST_MATRIX_CMD_APPS_WEB_E2E:-}"
  add_suite \
    "apps-web-e2e" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/apps-web-e2e.log" \
    "long" \
    "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_FRONTEND_E2E" == "1" ]]; then
  resolve_suite_cmd \
    "frontend-e2e" \
    "${PNPM_SAFE} test:e2e:frontend" \
    "${UIQ_TEST_MATRIX_CMD_FRONTEND_E2E:-}"
  add_suite \
    "frontend-e2e" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/frontend-e2e.log" \
    "long" \
    "$RESOLVED_SUITE_MODE"

  resolve_suite_cmd \
    "frontend-e2e-nonstub" \
    "env UIQ_FRONTEND_E2E_PORT=$UIQ_FRONTEND_E2E_NONSTUB_PORT UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT=$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT BACKEND_PORT=$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT VITE_DEFAULT_BASE_URL=http://127.0.0.1:$UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT ${PNPM_SAFE} test:e2e:frontend:nonstub" \
    "${UIQ_TEST_MATRIX_CMD_FRONTEND_E2E_NONSTUB:-}"
  frontend_e2e_nonstub_cmd="$RESOLVED_SUITE_CMD"
  frontend_e2e_nonstub_log="$LOG_DIR/frontend-e2e-nonstub.log"
  frontend_e2e_nonstub_mode="$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_E2E_AUTHENTICITY" == "1" ]]; then
  resolve_suite_cmd \
    "e2e-authenticity-gate" \
    "${PNPM_SAFE} gate:e2e:authenticity" \
    "${UIQ_TEST_MATRIX_CMD_E2E_AUTHENTICITY_GATE:-}"
  add_suite \
    "e2e-authenticity-gate" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/e2e-authenticity-gate.log" \
    "short" \
    "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_FRONTEND_UNIT" == "1" ]]; then
  resolve_suite_cmd \
    "frontend-unit" \
    "${PNPM_SAFE} --dir apps/command-center test" \
    "${UIQ_TEST_MATRIX_CMD_FRONTEND_UNIT:-}"
  add_suite \
    "frontend-unit" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/frontend-unit.log" \
    "short" \
    "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_BACKEND" == "1" ]]; then
  backend_default_cmd="bash scripts/lib/python-exec.sh pytest -n $UIQ_PYTEST_WORKERS_EFFECTIVE --dist=loadscope"
  resolve_suite_cmd "backend-pytest" "$backend_default_cmd" "${UIQ_TEST_MATRIX_CMD_BACKEND_PYTEST:-}"
  add_suite "backend-pytest" "$RESOLVED_SUITE_CMD" "$LOG_DIR/backend-pytest.log" "long" "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_TEST_TRUTH_GATE" == "1" ]]; then
  resolve_suite_cmd \
    "test-truth-gate" \
    "${PNPM_SAFE} gate:test:truth" \
    "${UIQ_TEST_MATRIX_CMD_TEST_TRUTH_GATE:-}"
  add_suite \
    "test-truth-gate" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/test-truth-gate.log" \
    "short" \
    "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_AUTOMATION_CHECK" == "1" ]]; then
  automation_default_cmd=""
  if [[ "$AUTOMATION_INSTALL_DEPS" == "1" ]]; then
    automation_default_cmd="$(append_cmd_segment "$automation_default_cmd" "${PNPM_SAFE} install --frozen-lockfile")"
  fi
  automation_default_cmd="$(append_cmd_segment "$automation_default_cmd" "${PNPM_SAFE} --dir tooling/automation check")"
  resolve_suite_cmd "automation-check" "$automation_default_cmd" "${UIQ_TEST_MATRIX_CMD_AUTOMATION_CHECK:-}"
  add_suite "automation-check" "$RESOLVED_SUITE_CMD" "$LOG_DIR/automation-check.log" "short" "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_ORCHESTRATOR_MCP" == "1" ]]; then
  orchestrator_default_cmd="bash scripts/lib/node-bin.sh tsx --test packages/orchestrator/src/commands/run.test.ts packages/orchestrator/src/commands/run.runid.test.ts"
  orchestrator_default_cmd="$(append_cmd_segment "$orchestrator_default_cmd" "${PNPM_SAFE} mcp:check")"
  resolve_suite_cmd \
    "orchestrator-mcp-gate" \
    "$orchestrator_default_cmd" \
    "${UIQ_TEST_MATRIX_CMD_ORCHESTRATOR_MCP_GATE:-}"
  add_suite \
    "orchestrator-mcp-gate" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/orchestrator-mcp-gate.log" \
    "short" \
    "$RESOLVED_SUITE_MODE"
fi

if [[ "$RUN_COVERAGE_GATE" == "1" ]]; then
  resolve_suite_cmd \
    "coverage-gate" \
    "${PNPM_SAFE} test:coverage" \
    "${UIQ_TEST_MATRIX_CMD_COVERAGE_GATE:-}"
  if [[ "$MODE" == "serial" ]]; then
    add_suite \
      "coverage-gate" \
      "$RESOLVED_SUITE_CMD" \
      "$LOG_DIR/coverage-gate.log" \
      "long" \
      "$RESOLVED_SUITE_MODE"
  else
    coverage_gate_cmd="$RESOLVED_SUITE_CMD"
    coverage_gate_log="$LOG_DIR/coverage-gate.log"
    coverage_gate_mode="$RESOLVED_SUITE_MODE"
  fi
fi

if [[ "$RUN_MUTATION_GATE" == "1" ]]; then
  resolve_suite_cmd \
    "mutation-gate" \
    "${PNPM_SAFE} mutation:effective" \
    "${UIQ_TEST_MATRIX_CMD_MUTATION_GATE:-}"
  add_suite \
    "mutation-gate" \
    "$RESOLVED_SUITE_CMD" \
    "$LOG_DIR/mutation-gate.log" \
    "long" \
    "$RESOLVED_SUITE_MODE"
fi

echo "mode=$MODE run_id=$RUN_ID log_dir=$LOG_DIR"
echo "ports: web_e2e=$UIQ_WEB_PORT frontend_e2e=$UIQ_FRONTEND_E2E_PORT"
echo "heartbeat_interval_sec=$(uiq_read_heartbeat_interval)"
echo "suite_order=$SUITE_ORDER (recommended: short-first)"
echo "parallel_budget_mode=$PARALLEL_BUDGET_MODE global_budget=$GLOBAL_BUDGET effective(pytest=$UIQ_PYTEST_WORKERS_EFFECTIVE, web_e2e=$UIQ_PLAYWRIGHT_E2E_WORKERS_EFFECTIVE, frontend_e2e=$UIQ_FRONTEND_E2E_WORKERS_EFFECTIVE, vitest=$UIQ_VITEST_MAX_WORKERS_EFFECTIVE)"
echo "wave_suite_budget=$WAVE_SUITE_BUDGET"
echo "wave_suite_budget(short=$SHORT_WAVE_SUITE_BUDGET long=$LONG_WAVE_SUITE_BUDGET)"
if [[ "$RUN_AUTOMATION_CHECK" == "1" ]]; then
  echo "automation-check: install_deps=$AUTOMATION_INSTALL_DEPS (set UIQ_AUTOMATION_INSTALL_DEPS=1 to reinstall)"
fi
echo "optional-gates: coverage=$RUN_COVERAGE_GATE mutation=$RUN_MUTATION_GATE"
echo "command-overrides: enabled=$MATRIX_ALLOW_CMD_OVERRIDE"
if [[ "$RUN_COVERAGE_GATE" != "1" && "$CI_CONTEXT" != "1" ]]; then
  echo "coverage-gate disabled by explicit override."
  echo "enable with: UIQ_SUITE_COVERAGE_GATE=1 bash scripts/test-matrix.sh"
fi
if [[ "$RUN_MUTATION_GATE" != "1" && "$CI_CONTEXT" != "1" ]]; then
  echo "mutation-gate disabled by explicit override."
  echo "enable with: UIQ_SUITE_MUTATION_GATE=1 bash scripts/test-matrix.sh"
fi

if [[ "$SUITE_ORDER" == "short-first" ]]; then
  ordered_names=()
  ordered_cmds=()
  ordered_logs=()
  ordered_tiers=()
  ordered_modes=()
  for tier in short long; do
    for i in "${!suite_names[@]}"; do
      if [[ "${suite_tiers[$i]}" != "$tier" ]]; then
        continue
      fi
      ordered_names+=("${suite_names[$i]}")
      ordered_cmds+=("${suite_cmds[$i]}")
      ordered_logs+=("${suite_logs[$i]}")
      ordered_tiers+=("${suite_tiers[$i]}")
      ordered_modes+=("${suite_modes[$i]}")
    done
  done
  suite_names=("${ordered_names[@]}")
  suite_cmds=("${ordered_cmds[@]}")
  suite_logs=("${ordered_logs[@]}")
  suite_tiers=("${ordered_tiers[@]}")
  suite_modes=("${ordered_modes[@]}")
fi

failed=0

SPAWNED_PID=""
spawn_suite_process() {
  local mode="$1"
  local cmd="$2"
  local log_file="$3"
  local can_isolate="${4:-0}"
  SPAWNED_PID=""

  if [[ "$mode" != "argv" ]]; then
    echo "error: unsupported suite execution mode '$mode'"
    return 1
  fi

  local -a cmd_segments=()
  IFS="$SUITE_CHAIN_DELIM" read -r -a cmd_segments <<< "$cmd"
  if [[ "${#cmd_segments[@]}" -eq 0 ]]; then
    echo "error: parsed empty suite command"
    return 1
  fi

  if [[ "$can_isolate" == "1" ]]; then
    setsid bash -euo pipefail -s -- "${cmd_segments[@]}" >"$log_file" 2>&1 <<'BASH' &
run_segment() {
  local raw="$1"
  local -a argv=()
  read -r -a argv <<< "$raw"
  if [[ "${#argv[@]}" -eq 0 ]]; then
    echo "error: parsed empty suite command segment" >&2
    return 64
  fi
  "${argv[@]}"
}

for segment in "$@"; do
  run_segment "$segment"
done
BASH
  else
    bash -euo pipefail -s -- "${cmd_segments[@]}" >"$log_file" 2>&1 <<'BASH' &
run_segment() {
  local raw="$1"
  local -a argv=()
  read -r -a argv <<< "$raw"
  if [[ "${#argv[@]}" -eq 0 ]]; then
    echo "error: parsed empty suite command segment" >&2
    return 64
  fi
  "${argv[@]}"
}

for segment in "$@"; do
  run_segment "$segment"
done
BASH
  fi

  SPAWNED_PID="$!"
  return 0
}

if [[ "$MODE" == "serial" ]]; then
  for i in "${!suite_names[@]}"; do
    name="${suite_names[$i]}"
    cmd="${suite_cmds[$i]}"
    log_file="${suite_logs[$i]}"
    mode="${suite_modes[$i]}"
    echo "[run] $name"
    if ! spawn_suite_process "$mode" "$cmd" "$log_file" 0; then
      echo "[fail] $name (log: $log_file)"
      failed=1
      break
    fi
    pid="$SPAWNED_PID"
    hb_pid="$(uiq_start_pid_heartbeat "$name" "$pid" "$(uiq_read_heartbeat_interval)" "$log_file")"
    if wait "$pid"; then
      uiq_stop_heartbeat "$hb_pid"
      echo "[pass] $name (log: $log_file)"
    else
      uiq_stop_heartbeat "$hb_pid"
      echo "[fail] $name (log: $log_file)"
      failed=1
      break
    fi
  done
else
  can_isolate_process_group=0
  if command -v setsid >/dev/null 2>&1; then
    can_isolate_process_group=1
  fi

  is_pid_alive() {
    local pid="$1"
    kill -0 "$pid" >/dev/null 2>&1
  }

  is_pgid_alive() {
    local pgid="$1"
    [[ -n "$pgid" ]] || return 1
    kill -0 -- "-$pgid" >/dev/null 2>&1
  }

  collect_descendant_pids() {
    local parent_pid="$1"
    if ! command -v pgrep >/dev/null 2>&1; then
      return 0
    fi

    local child_pid
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] || continue
      collect_descendant_pids "$child_pid"
      printf '%s\n' "$child_pid"
    done < <(pgrep -P "$parent_pid" 2>/dev/null || true)
  }

  kill_suite_group() {
    local sig="$1"
    local pid="$2"
    local pgid="$3"
    local name="$4"
    if [[ -n "$pgid" ]]; then
      kill "-$sig" -- "-$pgid" >/dev/null 2>&1 || true
      echo "[$(echo "$sig" | tr '[:upper:]' '[:lower:]')] $name (pid=$pid pgid=$pgid)"
      return
    fi

    local child_pid
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] || continue
      kill "-$sig" "$child_pid" >/dev/null 2>&1 || true
    done < <(collect_descendant_pids "$pid")

    kill "-$sig" "$pid" >/dev/null 2>&1 || true
    echo "[$(echo "$sig" | tr '[:upper:]' '[:lower:]')] $name (pid=$pid)"
  }

  wait_suite_exit() {
    local pid="$1"
    local pgid="$2"
    local max_ticks="$3"
    local ticks=0
    while (( ticks < max_ticks )); do
      local pid_alive=1
      local pgid_alive=1
      if is_pid_alive "$pid"; then
        pid_alive=0
      fi
      if is_pgid_alive "$pgid"; then
        pgid_alive=0
      fi
      if (( pid_alive == 1 && pgid_alive == 1 )); then
        return 0
      fi
      sleep 0.1
      ticks=$((ticks + 1))
    done
    return 1
  }

  run_parallel_wave() {
    local wave_name="$1"
    local max_parallel="$2"
    shift
    shift
    local indices=("$@")
    if [[ "${#indices[@]}" -eq 0 ]]; then
      return 0
    fi

    if [[ "$max_parallel" -gt "${#indices[@]}" ]]; then
      max_parallel="${#indices[@]}"
    fi

    local pids=()
    local pgids=()
    local statuses=()
    local heartbeat_pids=()
    local wave_failed=0
    local failed_name=""
    local remaining=0
    local next_to_spawn=0

    fail_fast_cleanup_wave() {
      for i in "${!pids[@]}"; do
        if [[ "${statuses[i]}" != "running" ]]; then
          continue
        fi
        uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
        kill_suite_group "TERM" "${pids[$i]}" "${pgids[$i]}" "${suite_names[${indices[$i]}]}"
        statuses[i]="terminating"
      done

      local grace_ticks=$((FAILFAST_TERM_GRACE_SEC * 10))
      for i in "${!pids[@]}"; do
        if [[ "${statuses[i]}" != "terminating" ]]; then
          continue
        fi
        if ! wait_suite_exit "${pids[$i]}" "${pgids[$i]}" "$grace_ticks"; then
          uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
          kill_suite_group "KILL" "${pids[$i]}" "${pgids[$i]}" "${suite_names[${indices[$i]}]}"
        fi
        wait "${pids[$i]}" >/dev/null 2>&1 || true
        uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
        statuses[i]="stopped"
        remaining=$((remaining - 1))
        echo "[stop][$wave_name] ${suite_names[${indices[$i]}]} (log: ${suite_logs[${indices[$i]}]})"
      done
    }

    spawn_wave_suite() {
      local suite_idx="$1"
      local name="${suite_names[$suite_idx]}"
      local cmd="${suite_cmds[$suite_idx]}"
      local log_file="${suite_logs[$suite_idx]}"
      local tier="${suite_tiers[$suite_idx]}"
      local mode="${suite_modes[$suite_idx]}"
      echo "[spawn][$wave_name][$tier] $name"
      if ! spawn_suite_process "$mode" "$cmd" "$log_file" "$can_isolate_process_group"; then
        echo "[fail][$wave_name] $name (command rejected; log: $log_file)"
        wave_failed=1
        failed_name="${failed_name:-$name}"
        return 1
      fi
      local pid="$SPAWNED_PID"
      local pgid=""
      pids+=("$pid")
      if [[ "$can_isolate_process_group" == "1" ]]; then
        pgid="$pid"
      fi
      pgids+=("$pgid")
      statuses+=("running")
      heartbeat_pids+=("$(uiq_start_pid_heartbeat "${wave_name}.${tier}.${name}" "$pid" "$(uiq_read_heartbeat_interval)" "$log_file")")
      remaining=$((remaining + 1))
      return 0
    }

    while [[ "$remaining" -gt 0 || "$next_to_spawn" -lt "${#indices[@]}" ]]; do
      while [[ "$wave_failed" -eq 0 && "$remaining" -lt "$max_parallel" && "$next_to_spawn" -lt "${#indices[@]}" ]]; do
        if ! spawn_wave_suite "${indices[$next_to_spawn]}"; then
          break
        fi
        next_to_spawn=$((next_to_spawn + 1))
      done

      progress=0
      for i in "${!pids[@]}"; do
        if [[ "${statuses[i]}" != "running" ]]; then
          continue
        fi
        pid="${pids[$i]}"
        if is_pid_alive "$pid"; then
          continue
        fi

        progress=1
        remaining=$((remaining - 1))
        suite_idx="${indices[$i]}"
        name="${suite_names[$suite_idx]}"
        log_file="${suite_logs[$suite_idx]}"

        if wait "$pid"; then
          uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
          statuses[i]="passed"
          echo "[pass][$wave_name] $name (log: $log_file)"
        else
          uiq_stop_heartbeat "${heartbeat_pids[$i]:-}"
          statuses[i]="failed"
          echo "[fail][$wave_name] $name (log: $log_file)"
          wave_failed=1
          failed_name="${failed_name:-$name}"
        fi
      done

      if [[ "$wave_failed" -ne 0 ]]; then
        fail_fast_cleanup_wave
        break
      fi

      if [[ "$progress" -eq 0 && "$remaining" -gt 0 ]]; then
        sleep 0.2
      fi
    done

    if [[ "$wave_failed" -ne 0 ]]; then
      echo "fail-fast: stopped remaining suites after failure in $failed_name"
      echo "fail-fast[$wave_name]: stopped remaining suites after failure in $failed_name"
      return 1
    fi
    return 0
  }

  short_indices=()
  long_indices=()
  for i in "${!suite_names[@]}"; do
    if [[ "${suite_tiers[$i]}" == "short" ]]; then
      short_indices+=("$i")
    else
      long_indices+=("$i")
    fi
  done

  if [[ "${#short_indices[@]}" -gt 0 ]]; then
    echo "[wave] short suites first (${#short_indices[@]})"
    if ! run_parallel_wave "short-wave" "$SHORT_WAVE_SUITE_BUDGET" "${short_indices[@]}"; then
      failed=1
    fi
  fi

  if [[ "$failed" -eq 0 && "${#long_indices[@]}" -gt 0 ]]; then
    echo "[wave] long suites second (${#long_indices[@]})"
    if ! run_parallel_wave "long-wave" "$LONG_WAVE_SUITE_BUDGET" "${long_indices[@]}"; then
      failed=1
    fi
  fi

  if [[ "$failed" -eq 0 && -n "$coverage_gate_cmd" ]]; then
    echo "[run][post-wave] coverage-gate"
    if ! spawn_suite_process "$coverage_gate_mode" "$coverage_gate_cmd" "$coverage_gate_log" 0; then
      echo "[fail][post-wave] coverage-gate (log: $coverage_gate_log)"
      failed=1
    else
      pid="$SPAWNED_PID"
      hb_pid="$(uiq_start_pid_heartbeat "post-wave.coverage-gate" "$pid" "$(uiq_read_heartbeat_interval)" "$coverage_gate_log")"
      if wait "$pid"; then
        uiq_stop_heartbeat "$hb_pid"
        echo "[pass][post-wave] coverage-gate (log: $coverage_gate_log)"
      else
        uiq_stop_heartbeat "$hb_pid"
        echo "[fail][post-wave] coverage-gate (log: $coverage_gate_log)"
        failed=1
      fi
    fi
  fi

  if [[ "$failed" -eq 0 && -n "$frontend_e2e_nonstub_cmd" ]]; then
    echo "[run][post-wave] frontend-e2e-nonstub"
    if ! spawn_suite_process "$frontend_e2e_nonstub_mode" "$frontend_e2e_nonstub_cmd" "$frontend_e2e_nonstub_log" 0; then
      echo "[fail][post-wave] frontend-e2e-nonstub (log: $frontend_e2e_nonstub_log)"
      failed=1
    else
      pid="$SPAWNED_PID"
      hb_pid="$(uiq_start_pid_heartbeat "post-wave.frontend-e2e-nonstub" "$pid" "$(uiq_read_heartbeat_interval)" "$frontend_e2e_nonstub_log")"
      if wait "$pid"; then
        uiq_stop_heartbeat "$hb_pid"
        echo "[pass][post-wave] frontend-e2e-nonstub (log: $frontend_e2e_nonstub_log)"
      else
        uiq_stop_heartbeat "$hb_pid"
        echo "[fail][post-wave] frontend-e2e-nonstub (log: $frontend_e2e_nonstub_log)"
        failed=1
      fi
    fi
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  echo "test-matrix failed; see logs in $LOG_DIR"
  exit 1
fi

echo "test-matrix passed; logs in $LOG_DIR"
