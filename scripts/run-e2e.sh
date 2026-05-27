#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/lib/ports.sh
source "$ROOT_DIR/scripts/lib/ports.sh"
# shellcheck source=scripts/lib/heartbeat.sh
source "$ROOT_DIR/scripts/lib/heartbeat.sh"

resolve_e2e_retries() {
  local raw="${1:-${UIQ_E2E_RETRIES:-0}}"
  if ! [[ "$raw" =~ ^[0-9]+$ ]]; then
    echo "error: UIQ_E2E_RETRIES must be an integer in range 0-2 (got: $raw)" >&2
    exit 1
  fi
  if [[ "$raw" -gt 2 ]]; then
    echo "2"
    return
  fi
  echo "$raw"
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

ORDER_MODE="${UIQ_E2E_ORDER_MODE:-short-first}"
if [[ "$ORDER_MODE" != "short-first" && "$ORDER_MODE" != "as-is" ]]; then
  echo "error: UIQ_E2E_ORDER_MODE must be short-first|as-is"
  exit 1
fi

ordered_args=()
short_args=()
long_args=()
if [[ "$ORDER_MODE" == "short-first" && "$#" -gt 1 ]]; then
  for arg in "$@"; do
    if [[ "$arg" =~ (live|soak|stress|load|long) ]]; then
      long_args+=("$arg")
    else
      short_args+=("$arg")
    fi
  done
  ordered_args=()
  if ((${#short_args[@]} > 0)); then
    ordered_args+=("${short_args[@]}")
  fi
  if ((${#long_args[@]} > 0)); then
    ordered_args+=("${long_args[@]}")
  fi
else
  ordered_args=("$@")
fi

E2E_RETRIES="$(resolve_e2e_retries)"

node "$ROOT_DIR/scripts/check-e2e-contract.mjs"

RUNTIME_CACHE_DIR=".runtime-cache/cache/frontend-e2e"
RUNTIME_LOG_DIR=".runtime-cache/logs/frontend-e2e"
RUNTIME_REPORT_DIR=".runtime-cache/reports/playwright/frontend-e2e-generated"
RUNTIME_TEST_RESULTS_DIR=".runtime-cache/test-results/frontend-e2e-generated"
RUNTIME_E2E_CONFIG="$RUNTIME_CACHE_DIR/playwright.e2e.frontend.config.mjs"
mkdir -p "$RUNTIME_CACHE_DIR" "$RUNTIME_LOG_DIR" "$RUNTIME_REPORT_DIR" "$RUNTIME_TEST_RESULTS_DIR"

has_pid() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

wait_for_exit() {
  local pid="$1"
  local timeout_secs="$2"
  local deadline=$((SECONDS + timeout_secs))
  while has_pid "$pid"; do
    if ((SECONDS >= deadline)); then
      return 1
    fi
    sleep 0.2
  done
  return 0
}

ARTIFACT_POLICY="${UIQ_E2E_ARTIFACT_POLICY:-critical}"
case "$ARTIFACT_POLICY" in
  critical)
    PLAYWRIGHT_SCREENSHOT_POLICY="on"
    PLAYWRIGHT_TRACE_POLICY="retain-on-failure"
    PLAYWRIGHT_VIDEO_POLICY="retain-on-failure"
    ;;
  full)
    PLAYWRIGHT_SCREENSHOT_POLICY="on"
    PLAYWRIGHT_TRACE_POLICY="on"
    PLAYWRIGHT_VIDEO_POLICY="on"
    ;;
  failure-only)
    PLAYWRIGHT_SCREENSHOT_POLICY="only-on-failure"
    PLAYWRIGHT_TRACE_POLICY="retain-on-failure"
    PLAYWRIGHT_VIDEO_POLICY="retain-on-failure"
    ;;
  *)
    echo "error: UIQ_E2E_ARTIFACT_POLICY must be one of critical|full|failure-only (got: $ARTIFACT_POLICY)"
    exit 1
    ;;
esac

cat > "$RUNTIME_E2E_CONFIG" <<'EOF'
import { defineConfig } from "@playwright/test";
import path from "node:path";

const webPort = Number(process.env.UIQ_WEB_PORT ?? 4173);
const webBaseUrl = process.env.BASE_URL ?? process.env.UIQ_BASE_URL ?? `http://127.0.0.1:${webPort}`;
const repoRoot = process.cwd();

export default defineConfig({
  testDir: path.join(repoRoot, "apps/command-center/tests/e2e"),
  outputDir: path.join(repoRoot, ".runtime-cache", "test-results", "frontend-e2e-generated"),
  timeout: 45_000,
  retries: Number(process.env.UIQ_E2E_RETRIES ?? "0"),
  maxFailures: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(
          repoRoot,
          ".runtime-cache",
          "reports",
          "playwright",
          "frontend-e2e-generated",
        ),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: webBaseUrl,
    headless: true,
    screenshot: process.env.PLAYWRIGHT_SCREENSHOT_POLICY ?? "on",
    trace: process.env.PLAYWRIGHT_TRACE_POLICY ?? "retain-on-failure",
    video: process.env.PLAYWRIGHT_VIDEO_POLICY ?? "retain-on-failure"
  }
});
EOF

EXTERNAL_BASE_URL="${BASE_URL:-${UIQ_BASE_URL:-}}"
if [[ -n "$EXTERNAL_BASE_URL" ]]; then
  if [[ ! "$EXTERNAL_BASE_URL" =~ ^https?:// ]]; then
    echo "error: BASE_URL/UIQ_BASE_URL must start with http:// or https:// (got: $EXTERNAL_BASE_URL)"
    exit 1
  fi
  echo "info: reuse provided runtime at $EXTERNAL_BASE_URL"
  echo "info: e2e retries=$E2E_RETRIES (max 2)"
  EXTERNAL_LOG="$RUNTIME_LOG_DIR/frontend.e2e.external.log"
  E2E_PID=""
  E2E_HEARTBEAT_PID=""
  EXTERNAL_CLEANUP_DONE=0
  cleanup_external() {
    if ((EXTERNAL_CLEANUP_DONE == 1)); then
      return
    fi
    EXTERNAL_CLEANUP_DONE=1

    uiq_stop_heartbeat "${E2E_HEARTBEAT_PID:-}"
    if has_pid "${E2E_PID:-}"; then
      kill -TERM "$E2E_PID" >/dev/null 2>&1 || true
      if ! wait_for_exit "$E2E_PID" 5; then
        kill -KILL "$E2E_PID" >/dev/null 2>&1 || true
        wait_for_exit "$E2E_PID" 2 || true
      fi
      wait "$E2E_PID" 2>/dev/null || true
    fi
  }
  trap cleanup_external EXIT
  trap 'cleanup_external; exit 130' INT
  trap 'cleanup_external; exit 143' TERM

  UIQ_BASE_URL="$EXTERNAL_BASE_URL" \
  BASE_URL="$EXTERNAL_BASE_URL" \
  UIQ_E2E_RETRIES="$E2E_RETRIES" \
  PLAYWRIGHT_SCREENSHOT_POLICY="$PLAYWRIGHT_SCREENSHOT_POLICY" \
  PLAYWRIGHT_TRACE_POLICY="$PLAYWRIGHT_TRACE_POLICY" \
  PLAYWRIGHT_VIDEO_POLICY="$PLAYWRIGHT_VIDEO_POLICY" \
  bash scripts/lib/node-bin.sh playwright test -c "$RUNTIME_E2E_CONFIG" "${ordered_args[@]-}" >"$EXTERNAL_LOG" 2>&1 &
  E2E_PID="$!"
  E2E_HEARTBEAT_PID="$(uiq_start_pid_heartbeat "run-e2e.playwright.external" "$E2E_PID" "$(uiq_read_heartbeat_interval)" "$EXTERNAL_LOG")"
  if wait "$E2E_PID"; then
    cleanup_external
    trap - EXIT INT TERM
  else
    cleanup_external
    echo "error: external e2e failed (log: $EXTERNAL_LOG)"
    tail -n 60 "$EXTERNAL_LOG" || true
    trap - EXIT INT TERM
    exit 1
  fi
  exit 0
fi

PREFERRED_PORT="${UIQ_WEB_PORT:-4173}"
if ! validate_port_number "$PREFERRED_PORT" "UIQ_WEB_PORT"; then
  exit 1
fi

if ! WEB_PORT="$(find_available_port "$PREFERRED_PORT" 200)"; then
  if ! WEB_PORT="$(find_available_port 44000 500)"; then
    echo "error: no available web port found from $PREFERRED_PORT or fallback range 44000-44499"
    exit 1
  fi
fi

if [[ "$WEB_PORT" != "$PREFERRED_PORT" ]]; then
  echo "warn: port $PREFERRED_PORT is in use, e2e fallback to $WEB_PORT"
fi

BACKEND_ORIGIN="${VITE_DEFAULT_BASE_URL:-}"
if [[ -n "$BACKEND_ORIGIN" ]]; then
  if [[ ! "$BACKEND_ORIGIN" =~ ^https?:// ]]; then
    echo "error: VITE_DEFAULT_BASE_URL must start with http:// or https:// (got: $BACKEND_ORIGIN)"
    exit 1
  fi
else
  PREFERRED_BACKEND_PORT="${BACKEND_PORT:-17380}"
  if ! [[ "$PREFERRED_BACKEND_PORT" =~ ^[0-9]+$ ]]; then
    echo "error: BACKEND_PORT must be an integer (got: $PREFERRED_BACKEND_PORT)"
    exit 1
  fi

  if ! BACKEND_PORT_SELECTED="$(find_available_port "$PREFERRED_BACKEND_PORT" 200)"; then
    if ! BACKEND_PORT_SELECTED="$(find_available_port 30000 1000)"; then
      echo "error: no available backend port found from $PREFERRED_BACKEND_PORT or fallback range 30000-30999"
      exit 1
    fi
  fi
  if [[ "$BACKEND_PORT_SELECTED" != "$PREFERRED_BACKEND_PORT" ]]; then
    echo "warn: backend port $PREFERRED_BACKEND_PORT is in use, non-stub e2e fallback to $BACKEND_PORT_SELECTED"
  fi
  BACKEND_ORIGIN="http://127.0.0.1:${BACKEND_PORT_SELECTED}"
fi

if ! BACKEND_PORT_FOR_TESTS="$(extract_url_port "$BACKEND_ORIGIN")"; then
  echo "error: unable to derive backend port from VITE_DEFAULT_BASE_URL=$BACKEND_ORIGIN"
  exit 1
fi

BASE_URL="http://127.0.0.1:${WEB_PORT}"
WEB_BASE_URL="$BASE_URL"
SERVER_PID=""
SERVER_PGID=""
E2E_PID=""
E2E_HEARTBEAT_PID=""
CLEANUP_DONE=0

get_pgid() {
  local pid="$1"
  ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '
}


signal_server_group_or_pid() {
  local signal="$1"

  if [[ -n "$SERVER_PGID" && "$SERVER_PGID" =~ ^[0-9]+$ && "$SERVER_PGID" != "$(get_pgid "$$")" ]]; then
    kill "-$signal" -- "-$SERVER_PGID" >/dev/null 2>&1 || true
    return
  fi

  if has_pid "$SERVER_PID"; then
    kill "-$signal" "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if ((CLEANUP_DONE == 1)); then
    return
  fi
  CLEANUP_DONE=1

  uiq_stop_heartbeat "${E2E_HEARTBEAT_PID:-}"
  if has_pid "${E2E_PID:-}"; then
    kill -TERM "$E2E_PID" >/dev/null 2>&1 || true
    if ! wait_for_exit "$E2E_PID" 5; then
      kill -KILL "$E2E_PID" >/dev/null 2>&1 || true
      wait_for_exit "$E2E_PID" 2 || true
    fi
    wait "$E2E_PID" 2>/dev/null || true
  fi

  if ! has_pid "$SERVER_PID"; then
    return
  fi

  signal_server_group_or_pid TERM
  if ! wait_for_exit "$SERVER_PID" 5; then
    signal_server_group_or_pid KILL
    wait_for_exit "$SERVER_PID" 2 || true
  fi

  wait "$SERVER_PID" 2>/dev/null || true
}
on_interrupt() {
  cleanup
  exit 130
}

on_terminate() {
  cleanup
  exit 143
}

trap cleanup EXIT
trap on_interrupt INT
trap on_terminate TERM

if command -v setsid >/dev/null 2>&1; then
  VITE_DEFAULT_BASE_URL="$BACKEND_ORIGIN" \
    setsid pnpm --dir apps/command-center dev --host 127.0.0.1 --port "$WEB_PORT" --strictPort > "$RUNTIME_LOG_DIR/frontend.e2e.dev.log" 2>&1 &
else
  VITE_DEFAULT_BASE_URL="$BACKEND_ORIGIN" \
    pnpm --dir apps/command-center dev --host 127.0.0.1 --port "$WEB_PORT" --strictPort > "$RUNTIME_LOG_DIR/frontend.e2e.dev.log" 2>&1 &
fi
SERVER_PID=$!
SERVER_PGID="$(get_pgid "$SERVER_PID")"

wait_for_url() {
  local url="$1"
  local ready_timeout_secs="${UIQ_E2E_READY_TIMEOUT_SEC:-20}"
  local ready_poll_ms="${UIQ_E2E_READY_POLL_MS:-250}"
  local sleep_seconds
  if ! [[ "$ready_timeout_secs" =~ ^[0-9]+$ ]] || [[ "$ready_timeout_secs" -lt 1 ]]; then
    ready_timeout_secs=20
  fi
  if ! [[ "$ready_poll_ms" =~ ^[0-9]+$ ]] || [[ "$ready_poll_ms" -lt 50 ]]; then
    ready_poll_ms=250
  fi
  sleep_seconds="$(awk -v ms="$ready_poll_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
  local deadline=$((SECONDS + ready_timeout_secs))

  while (( SECONDS < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

if ! wait_for_url "$BASE_URL/"; then
  echo "error: frontend dev server not ready at $BASE_URL/"
  exit 1
fi

echo "info: e2e order mode=$ORDER_MODE"
echo "info: e2e retries=$E2E_RETRIES (max 2)"
UIQ_WEB_PORT="$WEB_PORT" UIQ_BASE_URL="$WEB_BASE_URL" BASE_URL="$WEB_BASE_URL" UIQ_E2E_RETRIES="$E2E_RETRIES" \
  VITE_DEFAULT_BASE_URL="$BACKEND_ORIGIN" BACKEND_PORT="$BACKEND_PORT_FOR_TESTS" \
  bash scripts/lib/node-bin.sh playwright test -c "$RUNTIME_E2E_CONFIG" "${ordered_args[@]-}" &
E2E_PID="$!"
E2E_HEARTBEAT_PID="$(uiq_start_pid_heartbeat "run-e2e.playwright" "$E2E_PID" "$(uiq_read_heartbeat_interval)" "$RUNTIME_LOG_DIR/frontend.e2e.dev.log")"
if wait "$E2E_PID"; then
  uiq_stop_heartbeat "$E2E_HEARTBEAT_PID"
  E2E_PID=""
  E2E_HEARTBEAT_PID=""
else
  uiq_stop_heartbeat "$E2E_HEARTBEAT_PID"
  E2E_HEARTBEAT_PID=""
  E2E_PID=""
  exit 1
fi
