#!/usr/bin/env bash
set -euo pipefail

uiq_read_heartbeat_interval() {
  local raw="${1:-${UIQ_HEARTBEAT_INTERVAL_SEC:-20}}"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -gt 0 ]]; then
    echo "$raw"
    return 0
  fi
  echo "20"
}

uiq_start_pid_heartbeat() {
  local label="$1"
  local pid="$2"
  local interval="${3:-$(uiq_read_heartbeat_interval)}"
  local log_hint="${4:-}"
  (
    local start_ts now elapsed ts
    start_ts="$(date +%s)"
    while kill -0 "$pid" >/dev/null 2>&1; do
      now="$(date +%s)"
      elapsed="$((now - start_ts))"
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      if [[ -n "$log_hint" ]]; then
        printf '[heartbeat][%s] %s still running (%ss elapsed, every %ss, pid=%s, log=%s)\n' "$ts" "$label" "$elapsed" "$interval" "$pid" "$log_hint" >&2
      else
        printf '[heartbeat][%s] %s still running (%ss elapsed, every %ss, pid=%s)\n' "$ts" "$label" "$elapsed" "$interval" "$pid" >&2
      fi
      sleep "$interval"
    done
  ) >/dev/null &
  echo "$!"
}

uiq_stop_heartbeat() {
  local hb_pid="${1:-}"
  if [[ -z "$hb_pid" ]]; then
    return 0
  fi
  if kill -0 "$hb_pid" >/dev/null 2>&1; then
    kill "$hb_pid" >/dev/null 2>&1 || true
    wait "$hb_pid" >/dev/null 2>&1 || true
  fi
}

uiq_run_with_heartbeat() {
  local label="${1:-}"
  shift || true

  local log_hint=""
  if [[ "${1:-}" == "--log" ]]; then
    log_hint="${2:-}"
    shift 2 || true
  fi
  if [[ "${1:-}" == "--" ]]; then
    shift || true
  fi

  if [[ -z "$label" || "$#" -eq 0 ]]; then
    echo "error: usage uiq_run_with_heartbeat <label> [--log <path>] -- <command> [args...]" >&2
    return 2
  fi

  "$@" &
  local cmd_pid="$!"
  local hb_pid
  hb_pid="$(uiq_start_pid_heartbeat "$label" "$cmd_pid" "$(uiq_read_heartbeat_interval)" "$log_hint")"

  local rc=0
  if wait "$cmd_pid"; then
    rc=0
  else
    rc=$?
  fi
  uiq_stop_heartbeat "$hb_pid"
  return "$rc"
}
