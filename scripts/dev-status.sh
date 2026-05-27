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

print_status() {
  local name="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "$name: stopped"
    return
  fi
  local pid
  pid="$(cat "$file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "$name: running (pid=$pid)"
  else
    echo "$name: stopped (stale pid file)"
  fi
}

print_status "backend" "$BACKEND_PID_FILE"
print_status "frontend" "$FRONTEND_PID_FILE"

if [[ -f "$BACKEND_PORT_FILE" ]]; then
  backend_port="$(cat "$BACKEND_PORT_FILE")"
  if [[ -n "$backend_port" ]]; then
    echo "backend url: http://127.0.0.1:$backend_port"
  fi
fi

if [[ -f "$FRONTEND_PORT_FILE" ]]; then
  frontend_port="$(cat "$FRONTEND_PORT_FILE")"
  if [[ -n "$frontend_port" ]]; then
    echo "frontend url: http://127.0.0.1:$frontend_port"
  fi
fi
