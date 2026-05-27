#!/usr/bin/env bash
set -euo pipefail

print_backend_log_tail() {
  local log_path="$1"
  local lines="${2:-80}"
  if [[ -f "$log_path" ]]; then
    echo "[backend] last ${lines} log lines from ${log_path}:"
    tail -n "$lines" "$log_path" || true
  else
    echo "[backend] log file not found: ${log_path}"
  fi
}

wait_for_backend_health() {
  local base_url="$1"
  local retries="${2:-60}"
  local interval_seconds="${3:-1}"
  local pid="${4:-}"
  local label="${5:-backend}"
  local log_path="${6:-}"
  for attempt in $(seq 1 "$retries"); do
    if curl -fsS "$base_url/health/" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "[$label] backend process exited before health check became ready (pid=$pid, attempt=${attempt}/${retries})"
      if [[ -n "$log_path" ]]; then
        print_backend_log_tail "$log_path" 120
      fi
      return 1
    fi
    if (( attempt == 1 || attempt % 10 == 0 || attempt == retries )); then
      echo "[$label] waiting for backend health (attempt ${attempt}/${retries}, url=${base_url}/health/)"
    fi
    sleep "$interval_seconds"
  done
  return 1
}

stop_pid_if_running() {
  local pid="${1:-}"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi
}

ensure_backend_running() {
  local base_url="$1"
  local backend_port="$2"
  local log_path="$3"
  local label="${4:-backend}"
  local health_retries="${5:-60}"
  local health_interval="${6:-1}"
  if curl -fsS "$base_url/health/" >/dev/null 2>&1; then
    echo "[$label] using existing backend"
    return 0
  fi

  local -a launcher=()
  if [[ -x "./scripts/lib/python-exec.sh" ]]; then
    launcher=("./scripts/lib/python-exec.sh" "uvicorn")
  else
    echo "[$label] backend launcher unavailable: expected ./scripts/lib/python-exec.sh"
    return 1
  fi

  echo "[$label] backend not running, starting temporary backend on ${base_url}"
  echo "[$label] backend launcher: ${launcher[*]}"
  mkdir -p "$(dirname "$log_path")"
  "${launcher[@]}" app.main:app --host 127.0.0.1 --port "$backend_port" >"$log_path" 2>&1 &
  BACKEND_PID=$!
  echo "[$label] spawned backend pid=${BACKEND_PID} log=${log_path}"
  if wait_for_backend_health "$base_url" "$health_retries" "$health_interval" "$BACKEND_PID" "$label" "$log_path"; then
    echo "[$label] temporary backend ready (pid=${BACKEND_PID})"
    return 0
  fi

  echo "[$label] backend failed to start after $((health_retries * health_interval))s, see ${log_path}"
  print_backend_log_tail "$log_path" 120
  return 1
}
