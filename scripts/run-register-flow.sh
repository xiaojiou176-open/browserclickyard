#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/load-env.sh"
load_env_files "$ROOT_DIR"

MODE="${1:-manual}"
FLOW="${2:-ui-only}"
if [[ "$MODE" != "manual" && "$MODE" != "midscene" ]]; then
  echo "usage: ./scripts/run-register-flow.sh [manual|midscene] [ui-only|full]"
  exit 1
fi
if [[ "$FLOW" != "ui-only" && "$FLOW" != "full" ]]; then
  echo "usage: ./scripts/run-register-flow.sh [manual|midscene] [ui-only|full]"
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "error: missing uv; run './scripts/setup.sh' first"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found"
  exit 1
fi

BACKEND_LOG=".runtime-cache/logs/register-flow.backend.log"
mkdir -p ".runtime-cache/logs"

find_open_port() {
  local port="$1"
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

PREFERRED_PORT="${TM_BACKEND_PORT:-17380}"
BACKEND_PORT="$(find_open_port "$PREFERRED_PORT")"
BASE_URL="http://127.0.0.1:${BACKEND_PORT}"
DEFAULT_START_URL="${BASE_URL}/register"
START_URL_VALUE="${START_URL:-}"

if [[ -z "$START_URL_VALUE" && -t 0 ]]; then
  read -r -p "Enter the registration page URL (default: ${DEFAULT_START_URL}): " start_url_input
  START_URL_VALUE="${start_url_input:-$DEFAULT_START_URL}"
elif [[ -z "$START_URL_VALUE" ]]; then
  START_URL_VALUE="$DEFAULT_START_URL"
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$FLOW" == "ui-only" ]]; then
  echo "[1/2] start backend on :$BACKEND_PORT"
else
  echo "[1/5] start backend on :$BACKEND_PORT"
fi
"$ROOT_DIR/scripts/lib/python-exec.sh" uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for _ in {1..30}; do
  if curl -fsS "${BASE_URL}/health/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${BASE_URL}/health/" >/dev/null 2>&1; then
  echo "error: backend not ready, see $BACKEND_LOG"
  exit 1
fi

if [[ "$FLOW" == "ui-only" ]]; then
  echo "[2/2] record (${MODE})"
else
  echo "[2/5] record (${MODE})"
fi
if [[ "$MODE" == "manual" ]]; then
  (
    cd tooling/automation
    BASE_URL="$BASE_URL" \
    START_URL="$START_URL_VALUE" \
    SUCCESS_SELECTOR="${SUCCESS_SELECTOR:-}" \
    HEADLESS=false \
    pnpm record:manual
  )
else
  (
    cd tooling/automation
    BASE_URL="$BASE_URL" \
    START_URL="$START_URL_VALUE" \
    SUCCESS_SELECTOR="${SUCCESS_SELECTOR:-}" \
    pnpm record:midscene
  )
fi

if [[ "$FLOW" == "ui-only" ]]; then
  echo
  echo "done (ui-only)"
  echo "base_url: $BASE_URL"
  echo "start_url: $START_URL_VALUE"
  echo "artifacts: .runtime-cache/automation/"
  echo "backend_log: $BACKEND_LOG"
  exit 0
fi

echo "[3/5] extract"
(cd tooling/automation && BASE_URL="$BASE_URL" pnpm extract)

echo "[4/5] generate-case"
(cd tooling/automation && BASE_URL="$BASE_URL" pnpm generate-case)

echo "[5/5] replay"
(cd tooling/automation && BASE_URL="$BASE_URL" pnpm replay)

echo
echo "done"
echo "base_url: $BASE_URL"
echo "artifacts: .runtime-cache/automation/"
echo "backend_log: $BACKEND_LOG"
