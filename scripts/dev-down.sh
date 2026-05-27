#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNTIME_DIR=".runtime-cache/dev"
BACKEND_PID_FILE="$RUNTIME_DIR/backend.pid"
BACKEND_PORT_FILE="$RUNTIME_DIR/backend.port"
FRONTEND_PID_FILE="$RUNTIME_DIR/frontend.pid"
BACKEND_PORT_FILE="$RUNTIME_DIR/backend.port"
FRONTEND_PORT_FILE="$RUNTIME_DIR/frontend.port"

is_expected_process() {
  local name="$1"
  local pid="$2"
  local cmdline
  cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ -z "$cmdline" ]]; then
    return 1
  fi
  if [[ "$name" == "backend" ]]; then
    [[ "$cmdline" == *"uvicorn app.main:app"* ]]
    return
  fi
  [[ "$cmdline" == *"pnpm-safe.sh --dir apps/command-center dev --host 127.0.0.1 --port"* ]] || [[ "$cmdline" == *"pnpm dev --host 127.0.0.1 --port"* ]] || [[ "$cmdline" == *"vite"* ]]
}

stop_by_pid_file() {
  local name="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "$name not running (pid file missing)"
    return
  fi
  local pid
  pid="$(cat "$file")"
  if [[ -z "$pid" ]]; then
    rm -f "$file"
    echo "$name pid file invalid, cleaned"
    return
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    if ! is_expected_process "$name" "$pid"; then
      echo "$name pid=$pid does not match managed command, skip stopping"
      rm -f "$file"
      return
    fi
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "$name stopped (pid=$pid)"
  else
    echo "$name already stopped (stale pid=$pid)"
  fi
  rm -f "$file"
}

stop_by_pid_file "frontend" "$FRONTEND_PID_FILE"
stop_by_pid_file "backend" "$BACKEND_PID_FILE"
rm -f "$FRONTEND_PORT_FILE"
rm -f "$BACKEND_PORT_FILE"

echo "dev stack down"
