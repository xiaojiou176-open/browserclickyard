#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

RUNTIME_DIR=".runtime-cache/dev"
LOG_DIR=".runtime-cache/logs"
mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

BACKEND_PID_FILE="$RUNTIME_DIR/backend.pid"
BACKEND_PORT_FILE="$RUNTIME_DIR/backend.port"
FRONTEND_PID_FILE="$RUNTIME_DIR/frontend.pid"
FRONTEND_PORT_FILE="$RUNTIME_DIR/frontend.port"
BACKEND_LOG="$LOG_DIR/backend.dev.log"
FRONTEND_LOG="$LOG_DIR/frontend.dev.log"
DEFAULT_BACKEND_PORT=17380
BACKEND_PORT="$DEFAULT_BACKEND_PORT"
BACKEND_URL="http://127.0.0.1:$BACKEND_PORT/health/"
DEFAULT_FRONTEND_PORT=17373
FRONTEND_PORT="$DEFAULT_FRONTEND_PORT"
FRONTEND_URL=""

export CACHE_TTL_SECONDS="${CACHE_TTL_SECONDS:-900}"
export CACHE_MAX_ENTRIES="${CACHE_MAX_ENTRIES:-500}"
export RUNTIME_GC_KEEP_RUNS="${RUNTIME_GC_KEEP_RUNS:-50}"
export RUNTIME_GC_RETENTION_DAYS="${RUNTIME_GC_RETENTION_DAYS:-7}"
export RUNTIME_GC_DIR_SIZE_THRESHOLD_MB="${RUNTIME_GC_DIR_SIZE_THRESHOLD_MB:-256}"
export RUNTIME_GC_MAX_DELETE_PER_RUN="${RUNTIME_GC_MAX_DELETE_PER_RUN:-200}"
export RUNTIME_GC_MAX_LOG_SIZE_MB="${RUNTIME_GC_MAX_LOG_SIZE_MB:-64}"
export RUNTIME_GC_LOG_TAIL_LINES="${RUNTIME_GC_LOG_TAIL_LINES:-4000}"
export RUNTIME_GC_AUTO_ON_DEV_UP="${RUNTIME_GC_AUTO_ON_DEV_UP:-true}"
export RUNTIME_GC_STATE_PATH="${RUNTIME_GC_STATE_PATH:-.runtime-cache/metrics/runtime-gc-state.json}"
DEFAULT_DATABASE_URL="sqlite+pysqlite:///$ROOT_DIR/.runtime-cache/automation/automation_tasks.db"
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv not found; run ./scripts/setup.sh"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found; install with: npm install -g pnpm"
  exit 1
fi

uiq_export_python_env
uiq_export_node_env "$ROOT_DIR"

run_db_migrations() {
  mkdir -p .runtime-cache/automation
  DATABASE_URL="$DATABASE_URL" bash "$ROOT_DIR/scripts/lib/python-exec.sh" alembic upgrade head
  echo "database schema ready (alembic head)"
}

is_truthy() {
  local raw="${1:-}"
  case "${raw,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

run_runtime_gc_preflight() {
  if ! is_truthy "$RUNTIME_GC_AUTO_ON_DEV_UP"; then
    echo "runtime gc preflight skipped (RUNTIME_GC_AUTO_ON_DEV_UP=$RUNTIME_GC_AUTO_ON_DEV_UP)"
    return 0
  fi
  if [[ ! -x "$ROOT_DIR/scripts/runtime-gc.sh" ]]; then
    echo "warn: runtime gc preflight skipped (scripts/runtime-gc.sh not executable)"
    return 0
  fi
  local gc_output="$RUNTIME_DIR/runtime-gc.preflight.json"
  local gc_log="$LOG_DIR/runtime-gc.preflight.log"
  if "$ROOT_DIR/scripts/runtime-gc.sh" \
    --scope all \
    --retention-days "$RUNTIME_GC_RETENTION_DAYS" \
    --keep-runs "$RUNTIME_GC_KEEP_RUNS" \
    --dir-size-threshold-mb "$RUNTIME_GC_DIR_SIZE_THRESHOLD_MB" \
    --max-delete-per-run "$RUNTIME_GC_MAX_DELETE_PER_RUN" \
    --max-log-size-mb "$RUNTIME_GC_MAX_LOG_SIZE_MB" \
    --log-tail-lines "$RUNTIME_GC_LOG_TAIL_LINES" \
    >"$gc_output" 2>>"$gc_log"; then
    echo "runtime gc preflight completed (output=$gc_output)"
  else
    echo "warn: runtime gc preflight failed, continuing dev startup (details: $gc_log)"
  fi
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

select_backend_port() {
  local preferred_port="${TM_BACKEND_PORT:-$DEFAULT_BACKEND_PORT}"
  if ! validate_port_number "$preferred_port" "TM_BACKEND_PORT"; then
    exit 1
  fi
  if ! BACKEND_PORT="$(find_available_port "$preferred_port" 50)"; then
    echo "error: no available backend port found from $preferred_port to $((preferred_port + 49))"
    exit 1
  fi
  if [[ "$BACKEND_PORT" != "$preferred_port" ]]; then
    echo "warn: port $preferred_port is in use, backend fallback to $BACKEND_PORT"
  fi
  BACKEND_URL="http://127.0.0.1:$BACKEND_PORT/health/"
}

start_backend() {
  if [[ -f "$BACKEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$BACKEND_PID_FILE")"
    if [[ -f "$BACKEND_PORT_FILE" ]]; then
      BACKEND_PORT="$(cat "$BACKEND_PORT_FILE")"
      BACKEND_URL="http://127.0.0.1:$BACKEND_PORT/health/"
    fi
    if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
      if curl -fsS "$BACKEND_URL" >/dev/null 2>&1; then
        local commands_status
        commands_status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BACKEND_PORT/api/automation/commands" || true)"
        if [[ "$commands_status" == "200" ]]; then
          echo "backend already running (pid=$pid, port=$BACKEND_PORT)"
          if [[ "$FRONTEND_PORT" != "$DEFAULT_FRONTEND_PORT" ]]; then
            echo "warn: backend already running; if browser blocks API by CORS, run ./scripts/dev-down.sh then ./scripts/dev-up.sh"
          fi
          return
        fi
        echo "warn: backend is healthy but automation API returned $commands_status without local token exemption, restarting"
      fi
      echo "warn: backend pid=$pid exists but health check failed, restarting"
      kill "$pid" >/dev/null 2>&1 || true
      sleep 0.2
    fi
    rm -f "$BACKEND_PID_FILE"
    rm -f "$BACKEND_PORT_FILE"
  fi
  select_backend_port

  local cors_origins="${CORS_ALLOWED_ORIGINS:-}"
  local frontend_origin_127="http://127.0.0.1:$FRONTEND_PORT"
  local frontend_origin_localhost="http://localhost:$FRONTEND_PORT"
  if [[ ",$cors_origins," != *",$frontend_origin_127,"* ]]; then
    cors_origins="${cors_origins:+$cors_origins,}$frontend_origin_127"
  fi
  if [[ ",$cors_origins," != *",$frontend_origin_localhost,"* ]]; then
    cors_origins="${cors_origins:+$cors_origins,}$frontend_origin_localhost"
  fi

  local automation_max_parallel="${AUTOMATION_MAX_PARALLEL:-6}"
  local automation_max_parallel_long="${AUTOMATION_MAX_PARALLEL_LONG:-1}"
  local automation_allow_local_no_token="${AUTOMATION_ALLOW_LOCAL_NO_TOKEN:-false}"
  CORS_ALLOWED_ORIGINS="$cors_origins" AUTOMATION_ALLOW_LOCAL_NO_TOKEN="$automation_allow_local_no_token" AUTOMATION_MAX_PARALLEL="$automation_max_parallel" AUTOMATION_MAX_PARALLEL_LONG="$automation_max_parallel_long" nohup "$ROOT_DIR/scripts/lib/python-exec.sh" uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" >"$BACKEND_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$BACKEND_PID_FILE"
  echo "$BACKEND_PORT" >"$BACKEND_PORT_FILE"
  echo "backend started (pid=$pid, port=$BACKEND_PORT, log=$BACKEND_LOG)"
}

select_frontend_port() {
  local preferred_port="${TM_FRONTEND_PORT:-$DEFAULT_FRONTEND_PORT}"
  if ! validate_port_number "$preferred_port" "TM_FRONTEND_PORT"; then
    exit 1
  fi
  if ! FRONTEND_PORT="$(find_available_port "$preferred_port" 50)"; then
    echo "error: no available frontend port found from $preferred_port to $((preferred_port + 49))"
    exit 1
  fi
  if [[ "$FRONTEND_PORT" != "$preferred_port" ]]; then
    echo "warn: port $preferred_port is in use, fallback to $FRONTEND_PORT"
  fi
  FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
}

start_frontend() {
  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    local pid
    pid="$(cat "$FRONTEND_PID_FILE")"
    if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
      if [[ -f "$FRONTEND_PORT_FILE" ]]; then
        FRONTEND_PORT="$(cat "$FRONTEND_PORT_FILE")"
      fi
      FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
      echo "frontend already running (pid=$pid, port=$FRONTEND_PORT)"
      return
    fi
    rm -f "$FRONTEND_PID_FILE"
  fi

  select_frontend_port
  nohup zsh -lc "cd \"$ROOT_DIR\" && BACKEND_PORT=$BACKEND_PORT bash scripts/lib/pnpm-safe.sh --dir apps/command-center dev --host 127.0.0.1 --port $FRONTEND_PORT" >"$FRONTEND_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$FRONTEND_PID_FILE"
  echo "$FRONTEND_PORT" >"$FRONTEND_PORT_FILE"
  FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
  echo "frontend started (pid=$pid, port=$FRONTEND_PORT, log=$FRONTEND_LOG)"
}

wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in {1..40}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$name ready: $url"
      return 0
    fi
    sleep 0.5
  done
  echo "error: $name not ready ($url)"
  return 1
}

run_runtime_gc_preflight
run_db_migrations
start_backend
start_frontend
if [[ -z "$FRONTEND_URL" ]]; then
  FRONTEND_URL="http://127.0.0.1:$DEFAULT_FRONTEND_PORT"
fi
wait_for_url "$BACKEND_URL" "backend"
wait_for_url "$FRONTEND_URL" "frontend"

echo "dev stack up"
echo "- UI: $FRONTEND_URL"
echo "- API: http://127.0.0.1:$BACKEND_PORT"
echo "- stop: ./scripts/dev-down.sh"
