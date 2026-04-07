#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

health_url="${CANARY_HEALTH_URL:-}"
backup_file="${CANARY_ROLLBACK_BACKUP_FILE:-}"
window_seconds="${CANARY_WINDOW_SECONDS:-180}"
interval_seconds="${CANARY_INTERVAL_SECONDS:-15}"
max_failures="${CANARY_MAX_FAILURES:-3}"
output_path="${CANARY_GUARD_OUTPUT:-.runtime-cache/release-gate/canary-guard.json}"

for arg in "$@"; do
  case "$arg" in
    --health-url=*) health_url="${arg#*=}" ;;
    --backup-file=*) backup_file="${arg#*=}" ;;
    --window-seconds=*) window_seconds="${arg#*=}" ;;
    --interval-seconds=*) interval_seconds="${arg#*=}" ;;
    --max-failures=*) max_failures="${arg#*=}" ;;
    --output=*) output_path="${arg#*=}" ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$health_url" ]]; then
  echo "CANARY_HEALTH_URL (or --health-url=...) is required" >&2
  exit 2
fi
if [[ -z "$backup_file" ]]; then
  echo "CANARY_ROLLBACK_BACKUP_FILE (or --backup-file=...) is required" >&2
  exit 2
fi
if [[ ! -f "$backup_file" ]]; then
  echo "Rollback backup file not found: $backup_file" >&2
  exit 2
fi
if ! [[ "$window_seconds" =~ ^[0-9]+$ ]] || [[ "$window_seconds" -lt 10 ]]; then
  echo "window-seconds must be integer >= 10" >&2
  exit 2
fi
if ! [[ "$interval_seconds" =~ ^[0-9]+$ ]] || [[ "$interval_seconds" -lt 1 ]]; then
  echo "interval-seconds must be integer >= 1" >&2
  exit 2
fi
if ! [[ "$max_failures" =~ ^[0-9]+$ ]] || [[ "$max_failures" -lt 1 ]]; then
  echo "max-failures must be integer >= 1" >&2
  exit 2
fi

attempts=$(( window_seconds / interval_seconds ))
if [[ "$attempts" -lt 1 ]]; then
  attempts=1
fi

started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
total_failures=0
rollback_triggered=0
rollback_exit_code=0
last_error=""

for ((i = 1; i <= attempts; i++)); do
  if curl --silent --show-error --fail --max-time 5 "$health_url" >/dev/null; then
    echo "[canary] probe ${i}/${attempts}: healthy"
  else
    total_failures=$((total_failures + 1))
    last_error="probe_${i}_failed"
    echo "[canary] probe ${i}/${attempts}: failed (total_failures=${total_failures})"
    if [[ "$total_failures" -gt "$max_failures" ]]; then
      echo "[canary] threshold exceeded; triggering rollback..."
      rollback_triggered=1
      if bash scripts/rollback-runtime.sh "$backup_file"; then
        rollback_exit_code=0
      else
        rollback_exit_code=$?
      fi
      break
    fi
  fi
  sleep "$interval_seconds"
done

finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
status="passed"
reason_code="canary_healthy"
if [[ "$rollback_triggered" -eq 1 ]]; then
  if [[ "$rollback_exit_code" -eq 0 ]]; then
    status="rolled_back"
    reason_code="canary_threshold_exceeded_rollback_succeeded"
  else
    status="failed"
    reason_code="canary_threshold_exceeded_rollback_failed"
  fi
elif [[ "$total_failures" -gt 0 ]]; then
  status="audit_only"
  reason_code="canary_probe_failures_within_budget"
fi

python3 - "$output_path" "$started_at" "$finished_at" "$health_url" "$attempts" "$interval_seconds" "$max_failures" "$total_failures" "$status" "$reason_code" "$rollback_triggered" "$rollback_exit_code" "$backup_file" "$last_error" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

(
    output_path,
    started_at,
    finished_at,
    health_url,
    attempts,
    interval_seconds,
    max_failures,
    total_failures,
    status,
    reason_code,
    rollback_triggered,
    rollback_exit_code,
    backup_file,
    last_error,
) = sys.argv[1:15]

payload = {
    "started_at": started_at,
    "finished_at": finished_at,
    "health_url": health_url,
    "attempts": int(attempts),
    "interval_seconds": int(interval_seconds),
    "max_failures": int(max_failures),
    "total_failures": int(total_failures),
    "status": status,
    "reason_code": reason_code,
    "rollback_triggered": bool(int(rollback_triggered)),
    "rollback_exit_code": int(rollback_exit_code),
    "rollback_backup_file": backup_file,
    "last_error": last_error or None,
}

path = Path(output_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(payload, ensure_ascii=False))
PY

cp "$output_path" .runtime-cache/release-gate/canary-guard-latest.json

echo "[canary] status=${status} reason=${reason_code} report=${output_path}"
if [[ "$status" == "failed" ]]; then
  exit 1
fi
