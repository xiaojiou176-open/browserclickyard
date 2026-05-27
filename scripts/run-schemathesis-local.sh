#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/load-env.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/ports.sh"
load_env_files "$ROOT_DIR"

BACKEND_PORT="${BACKEND_PORT:-38080}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
SCHEMATHESIS_RUN_ID="${SCHEMATHESIS_RUN_ID:-$(date +%s)-$$}"
SCHEMATHESIS_RUNTIME_ROOT="${ROOT_DIR}/.runtime-cache/schemathesis-runtime/${SCHEMATHESIS_RUN_ID}"
if ! validate_port_number "$BACKEND_PORT" "BACKEND_PORT"; then
  exit 1
fi
if ! BACKEND_PORT="$(find_available_port "$BACKEND_PORT" 50)"; then
  echo "error: no available schemathesis backend port from ${BACKEND_PORT:-38080} to $(( ${BACKEND_PORT:-38080} + 49 ))" >&2
  exit 1
fi
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
SCHEMA_URL="${BACKEND_URL}/openapi.json"
BACKEND_LOG="${ROOT_DIR}/.runtime-cache/logs/schemathesis.backend.log"
AUTOMATION_TOKEN="${AUTOMATION_API_TOKEN:-}"
VONAGE_INBOUND_TOKEN="${VONAGE_INBOUND_TOKEN:-schemathesis-inbound-token}"

mkdir -p "${ROOT_DIR}/.runtime-cache/logs"
mkdir -p "${SCHEMATHESIS_RUNTIME_ROOT}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

UNIVERSAL_AUTOMATION_RUNTIME_DIR="${SCHEMATHESIS_RUNTIME_ROOT}" \
AUTOMATION_API_TOKEN="$AUTOMATION_TOKEN" \
AUTOMATION_RATE_LIMIT_PER_MINUTE="${AUTOMATION_RATE_LIMIT_PER_MINUTE:-100000}" \
VONAGE_INBOUND_TOKEN="$VONAGE_INBOUND_TOKEN" \
"${ROOT_DIR}/scripts/lib/python-exec.sh" uvicorn app.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "${SCHEMA_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${SCHEMA_URL}" >/dev/null 2>&1; then
  echo "error: schemathesis backend failed to become ready; see ${BACKEND_LOG}" >&2
  exit 1
fi

schemathesis_args=(
  run
  "${SCHEMA_URL}"
  --url
  "${BACKEND_URL}"
  --workers
  "${SCHEMATHESIS_WORKERS:-1}"
  --generation-codec
  ascii
  -H
  "x-automation-token:${AUTOMATION_TOKEN}"
  -H
  "x-automation-client-id:schemathesis"
  --exclude-path-regex
  ".*/api/integrations/vonage/inbound-sms$|.*/api/sessions$"
)

run_schemathesis() {
  SCHEMATHESIS_RUNTIME_ROOT="${SCHEMATHESIS_RUNTIME_ROOT}" \
  UNIVERSAL_AUTOMATION_RUNTIME_DIR="${SCHEMATHESIS_RUNTIME_ROOT}" \
  uv run --extra dev python "${ROOT_DIR}/scripts/run_schemathesis_with_hooks.py" "${schemathesis_args[@]}" "$@"
}

if [[ "${SCHEMATHESIS_BATCH_SINGLE:-0}" == "1" ]] || [[ "$*" == *"--include-path-regex"* ]]; then
  run_schemathesis "$@"
  exit $?
fi

declare -a schemathesis_batches=(
  '^/api/automation'
  '^/api/command-tower'
  '^/api/computer-use'
  '^/api/(embeddings|flows)'
  '^/(health|metrics)|^/api/(csrf|register)'
  '^/api/(profiles|reconstruction|runs|templates)'
)

for batch_regex in "${schemathesis_batches[@]}"; do
  echo "== schemathesis batch: ${batch_regex}"
  SCHEMATHESIS_BATCH_SINGLE=1 bash "$0" --include-path-regex "${batch_regex}" "$@"
done
