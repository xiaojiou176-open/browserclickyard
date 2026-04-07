#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/runtime-gc.sh [options]

Options:
  --scope <logs|runs|cache|automation|backups|extras|all>
                         Cleanup scope (default: RUNTIME_GC_SCOPE or all).
                         'all' covers logs/runs/cache/backups plus disposable/scratch extras only.
  --retention-days <N>   Delete logs/cache files older than N days (default: RUNTIME_GC_RETENTION_DAYS or 7)
  --keep-runs <N>        Keep latest N run directories under artifacts/runs (default: RUNTIME_GC_KEEP_RUNS or 50)
  --dir-size-threshold-mb <N>
                         Trigger cleanup for automation pytest leftovers/backups/extras only when directory size >= N MB
                         (default: RUNTIME_GC_DIR_SIZE_THRESHOLD_MB or 256)
  --max-delete-per-run <N>
                         Maximum number of delete operations in one run (default: RUNTIME_GC_MAX_DELETE_PER_RUN or 500)
  --max-log-size-mb <N>  Max size for non-rotating root log files in logs scope; oversized files are truncated to tail lines
                         (default: RUNTIME_GC_MAX_LOG_SIZE_MB or 64)
  --log-tail-lines <N>   Tail lines kept when truncating oversized non-rotating log files (default: RUNTIME_GC_LOG_TAIL_LINES or 4000)
  --runtime-root <DIR>   Runtime root directory (default: RUNTIME_ROOT or .runtime-cache)
  --report-out <FILE>    Write the structured cleanup report JSON to this path
  --dry-run              Print planned deletions to stderr without removing files
  --fail-on-error        Exit non-zero when cleanup errors happen
  -h, --help             Show this help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH to run runtime-gc.sh" >&2
  exit 1
fi

runtime_governance_query() {
  node "$ROOT_DIR/scripts/lib/runtime-governance.mjs" "$@"
}

runtime_root="${RUNTIME_ROOT:-.runtime-cache}"
retention_days="${RUNTIME_GC_RETENTION_DAYS:-7}"
keep_runs="${RUNTIME_GC_KEEP_RUNS:-50}"
dir_size_threshold_mb="${RUNTIME_GC_DIR_SIZE_THRESHOLD_MB:-256}"
scope="${RUNTIME_GC_SCOPE:-all}"
max_delete_per_run="${RUNTIME_GC_MAX_DELETE_PER_RUN:-500}"
max_log_size_mb="${RUNTIME_GC_MAX_LOG_SIZE_MB:-64}"
log_tail_lines="${RUNTIME_GC_LOG_TAIL_LINES:-4000}"
report_out=""
dry_run=0
fail_on_error=0
report_events_file="$(mktemp)"
trap 'rm -f "$report_events_file"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      scope="${2:-}"
      shift 2
      ;;
    --retention-days)
      retention_days="${2:-}"
      shift 2
      ;;
    --keep-runs)
      keep_runs="${2:-}"
      shift 2
      ;;
    --dir-size-threshold-mb)
      dir_size_threshold_mb="${2:-}"
      shift 2
      ;;
    --max-delete-per-run)
      max_delete_per_run="${2:-}"
      shift 2
      ;;
    --max-log-size-mb)
      max_log_size_mb="${2:-}"
      shift 2
      ;;
    --log-tail-lines)
      log_tail_lines="${2:-}"
      shift 2
      ;;
    --runtime-root)
      runtime_root="${2:-}"
      shift 2
      ;;
    --report-out)
      report_out="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --fail-on-error)
      fail_on_error=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$retention_days" =~ ^[0-9]+$ ]]; then
  echo "error: --retention-days must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$keep_runs" =~ ^[0-9]+$ ]]; then
  echo "error: --keep-runs must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$dir_size_threshold_mb" =~ ^[0-9]+$ ]]; then
  echo "error: --dir-size-threshold-mb must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$max_delete_per_run" =~ ^[0-9]+$ ]]; then
  echo "error: --max-delete-per-run must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$max_log_size_mb" =~ ^[0-9]+$ ]]; then
  echo "error: --max-log-size-mb must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$log_tail_lines" =~ ^[0-9]+$ ]]; then
  echo "error: --log-tail-lines must be a non-negative integer" >&2
  exit 1
fi
case "$scope" in
  logs|runs|cache|automation|backups|extras|all)
    ;;
  *)
    echo "error: --scope must be one of logs|runs|cache|automation|backups|extras|all" >&2
    exit 1
    ;;
esac

logs_dir="$runtime_root/logs"
runs_dir="$runtime_root/artifacts/runs"
cache_dir="$runtime_root/cache"
automation_dir="$runtime_root/automation"
backups_dir="$runtime_root/backups"
metrics_dir="$runtime_root/metrics"
# Extra tool-output directories not covered by named scopes above.
mapfile -t extras_scope_relpaths < <(runtime_governance_query scope-paths extras scratch,disposable_generated)
extras_scope_dirs=()
for rel_path in "${extras_scope_relpaths[@]}"; do
  extras_scope_dirs+=("$runtime_root/$rel_path")
done
state_path="${RUNTIME_GC_STATE_PATH:-$metrics_dir/runtime-gc-state.json}"
dir_size_threshold_bytes=$((dir_size_threshold_mb * 1024 * 1024))
max_log_size_bytes=$((max_log_size_mb * 1024 * 1024))

logs_deleted=0
logs_truncated=0
runs_deleted=0
cache_deleted=0
automation_deleted=0
backups_deleted=0
extras_deleted=0
bytes_freed=0
errors=0
delete_operations=0
limit_reached=0
abort_requested=0
previous_error_total=0
previous_bytes_freed_total=0

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(python3 - <<'PY'
import time
print(time.time())
PY
)"

scope_enabled() {
  local target_scope="$1"
  [[ "$scope" == "all" || "$scope" == "$target_scope" ]]
}

path_size_bytes() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    echo 0
    return 0
  fi
  du -sk "$target" 2>/dev/null | awk '{print int($1 * 1024)}'
}

mtime_epoch() {
  local target="$1"
  if stat -f "%m" "$target" >/dev/null 2>&1; then
    stat -f "%m" "$target"
    return 0
  fi
  stat -c "%Y" "$target"
}

record_error() {
  local message="$1"
  errors=$((errors + 1))
  echo "runtime-gc error: $message" >&2
  if [[ "$fail_on_error" -eq 1 ]]; then
    abort_requested=1
  fi
}

read_previous_totals() {
  if [[ ! -f "$state_path" ]]; then
    return 0
  fi
  local previous
  if ! previous="$(python3 - "$state_path" <<'PY'
import json
import sys

state_path = sys.argv[1]
try:
    with open(state_path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception:
    print("0 0")
    raise SystemExit(0)

if not isinstance(payload, dict):
    print("0 0")
    raise SystemExit(0)

error_total = payload.get("error_total", payload.get("errors", 0))
bytes_total = payload.get("bytes_freed_total", payload.get("bytes_freed", 0))

try:
    error_total = max(0, int(error_total))
except Exception:
    error_total = 0

try:
    bytes_total = max(0, int(bytes_total))
except Exception:
    bytes_total = 0

print(f"{error_total} {bytes_total}")
PY
)"; then
    return 0
  fi
  previous_error_total="${previous%% *}"
  previous_bytes_freed_total="${previous##* }"
}

remove_target() {
  local target="$1"
  local target_scope="$2"

  if (( delete_operations >= max_delete_per_run )); then
    limit_reached=1
    return 1
  fi

  local size_bytes
  size_bytes="$(path_size_bytes "$target")"

  if [[ "$dry_run" -eq 1 ]]; then
    echo "[dry-run] remove $target" >&2
    printf 'selected\t%s\t%s\t%s\t%s\n' "$target_scope" "stale_candidate" "$size_bytes" "$target" >>"$report_events_file"
  else
    if ! rm -rf -- "$target"; then
      record_error "failed to remove '$target'"
      return 1
    fi
    printf 'removed\t%s\t%s\t%s\t%s\n' "$target_scope" "stale_candidate" "$size_bytes" "$target" >>"$report_events_file"
  fi

  delete_operations=$((delete_operations + 1))
  bytes_freed=$((bytes_freed + size_bytes))
  case "$target_scope" in
    logs) logs_deleted=$((logs_deleted + 1)) ;;
    runs) runs_deleted=$((runs_deleted + 1)) ;;
    cache) cache_deleted=$((cache_deleted + 1)) ;;
    automation) automation_deleted=$((automation_deleted + 1)) ;;
    backups) backups_deleted=$((backups_deleted + 1)) ;;
    extras) extras_deleted=$((extras_deleted + 1)) ;;
  esac
  return 0
}

cleanup_old_files() {
  local dir="$1"
  local target_scope="$2"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  while IFS= read -r -d '' candidate; do
    if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
      break
    fi
    if ! remove_target "$candidate" "$target_scope"; then
      if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
        break
      fi
    fi
  done < <(find "$dir" -type f -mtime +"$retention_days" -print0)

  if [[ "$dry_run" -eq 1 ]]; then
    while IFS= read -r -d '' empty_dir; do
      echo "[dry-run] remove empty dir $empty_dir" >&2
    done < <(find "$dir" -type d -empty -mindepth 1 -print0)
    return 0
  fi

  if ! find "$dir" -type d -empty -mindepth 1 -delete; then
    record_error "failed to remove empty directories under '$dir'"
  fi
}

cleanup_old_files_when_over_threshold() {
  local dir="$1"
  local target_scope="$2"

  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  local dir_size_bytes
  dir_size_bytes="$(path_size_bytes "$dir")"

  if (( dir_size_threshold_bytes > 0 && dir_size_bytes < dir_size_threshold_bytes )); then
    if [[ "$dry_run" -eq 1 ]]; then
      echo "[dry-run] skip $target_scope cleanup (size ${dir_size_bytes}B < threshold ${dir_size_threshold_bytes}B): $dir" >&2
    fi
    printf 'skipped\t%s\t%s\t%s\t%s\n' "$target_scope" "below_threshold" "$dir_size_bytes" "$dir" >>"$report_events_file"
    return 0
  fi

  cleanup_old_files "$dir" "$target_scope"
}

cleanup_automation_pytest_leftovers_when_over_threshold() {
  local dir="$1"

  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  local dir_size_bytes
  dir_size_bytes="$(path_size_bytes "$dir")"
  if (( dir_size_threshold_bytes > 0 && dir_size_bytes < dir_size_threshold_bytes )); then
    if [[ "$dry_run" -eq 1 ]]; then
      echo "[dry-run] skip automation cleanup (size ${dir_size_bytes}B < threshold ${dir_size_threshold_bytes}B): $dir" >&2
    fi
    printf 'skipped\tautomation\t%s\t%s\t%s\n' "below_threshold" "$dir_size_bytes" "$dir" >>"$report_events_file"
    return 0
  fi

  while IFS= read -r -d '' candidate; do
    if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
      break
    fi
    if ! remove_target "$candidate" "automation"; then
      if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
        break
      fi
    fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -name 'pytest-*' -mtime +"$retention_days" -print0)
}

cleanup_runs_by_count() {
  if [[ ! -d "$runs_dir" ]]; then
    return 0
  fi

  local run_rows=()
  while IFS= read -r -d '' run_dir; do
    run_rows+=("$(mtime_epoch "$run_dir")|$run_dir")
  done < <(find "$runs_dir" -mindepth 1 -maxdepth 1 -type d -print0)

  if (( ${#run_rows[@]} == 0 )); then
    return 0
  fi

  local sorted_runs=()
  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    sorted_runs+=("$row")
  done < <(printf '%s\n' "${run_rows[@]}" | sort -t'|' -k1,1nr)

  local total_runs="${#sorted_runs[@]}"
  if (( total_runs <= keep_runs )); then
    return 0
  fi

  local idx
  for ((idx = keep_runs; idx < total_runs; idx++)); do
    if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
      break
    fi
    local run_path="${sorted_runs[$idx]#*|}"
    if ! remove_target "$run_path" "runs"; then
      if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
        break
      fi
    fi
  done
}

truncate_oversized_non_rotating_logs() {
  if [[ ! -d "$logs_dir" ]]; then
    return 0
  fi

  if (( max_log_size_bytes <= 0 )); then
    return 0
  fi

  while IFS= read -r -d '' log_file; do
    if [[ "$abort_requested" -eq 1 || "$limit_reached" -eq 1 ]]; then
      break
    fi

    local file_size
    file_size="$(path_size_bytes "$log_file")"
    if (( file_size < max_log_size_bytes )); then
      continue
    fi

    if (( delete_operations >= max_delete_per_run )); then
      limit_reached=1
      break
    fi

    if [[ "$dry_run" -eq 1 ]]; then
      echo "[dry-run] truncate oversized log (>=${max_log_size_mb}MB): $log_file" >&2
      printf 'selected\tlogs\t%s\t%s\t%s\n' "oversized_log_truncate" "$file_size" "$log_file" >>"$report_events_file"
    else
      local tmp_file
      tmp_file="$(mktemp "${log_file}.tmp.XXXXXX")"
      if ! tail -n "$log_tail_lines" "$log_file" >"$tmp_file"; then
        rm -f "$tmp_file" >/dev/null 2>&1 || true
        record_error "failed to tail oversized log '$log_file'"
        continue
      fi
      if ! mv -f "$tmp_file" "$log_file"; then
        rm -f "$tmp_file" >/dev/null 2>&1 || true
        record_error "failed to truncate oversized log '$log_file'"
        continue
      fi
      local truncated_size
      truncated_size="$(path_size_bytes "$log_file")"
      if (( truncated_size > file_size )); then
        truncated_size="$file_size"
      fi
      bytes_freed=$((bytes_freed + file_size - truncated_size))
      printf 'truncated\tlogs\t%s\t%s\t%s\n' "oversized_log_truncate" "$file_size" "$log_file" >>"$report_events_file"
    fi

    logs_truncated=$((logs_truncated + 1))
    delete_operations=$((delete_operations + 1))
  done < <(find "$logs_dir" -mindepth 1 -maxdepth 1 -type f -name '*.log' -print0)
}

build_result_json() {
  local last_run_at="$1"
  local duration_seconds="$2"
  local total_deleted="$3"
  local status="$4"
  local bytes_freed_total="$5"
  local error_total="$6"

  LAST_RUN_AT="$last_run_at" \
  DURATION_SECONDS="$duration_seconds" \
  RUNTIME_ROOT="$runtime_root" \
  STATE_PATH="$state_path" \
  SCOPE="$scope" \
  DRY_RUN="$dry_run" \
  FAIL_ON_ERROR="$fail_on_error" \
  RETENTION_DAYS="$retention_days" \
  KEEP_RUNS="$keep_runs" \
  MAX_DELETE_PER_RUN="$max_delete_per_run" \
  MAX_LOG_SIZE_MB="$max_log_size_mb" \
  LOG_TAIL_LINES="$log_tail_lines" \
  LIMIT_REACHED="$limit_reached" \
  LOGS_DELETED="$logs_deleted" \
  LOGS_TRUNCATED="$logs_truncated" \
  RUNS_DELETED="$runs_deleted" \
  CACHE_DELETED="$cache_deleted" \
  AUTOMATION_DELETED="$automation_deleted" \
  BACKUPS_DELETED="$backups_deleted" \
  EXTRAS_DELETED="$extras_deleted" \
  TOTAL_DELETED="$total_deleted" \
  BYTES_FREED="$bytes_freed" \
  BYTES_FREED_TOTAL="$bytes_freed_total" \
  ERRORS="$errors" \
  ERROR_TOTAL="$error_total" \
  DIR_SIZE_THRESHOLD_MB="$dir_size_threshold_mb" \
  STATUS="$status" \
  REPORT_EVENTS_FILE="$report_events_file" \
  STARTED_AT="$started_at" \
  python3 - <<'PY'
import json
import os


def read_int(name: str, default: int = 0) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def read_float(name: str, default: float = 0.0) -> float:
    raw = os.getenv(name, str(default)).strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        return default


payload = {
    "version": 1,
    "started_at": os.getenv("STARTED_AT", ""),
    "last_run_at": os.getenv("LAST_RUN_AT", ""),
    "duration_seconds": round(read_float("DURATION_SECONDS"), 6),
    "runtime_root": os.getenv("RUNTIME_ROOT", ""),
    "state_path": os.getenv("STATE_PATH", ""),
    "scope": os.getenv("SCOPE", "all"),
    "dry_run": read_int("DRY_RUN") == 1,
    "fail_on_error": read_int("FAIL_ON_ERROR") == 1,
    "retention_days": read_int("RETENTION_DAYS"),
    "keep_runs": read_int("KEEP_RUNS"),
    "dir_size_threshold_mb": read_int("DIR_SIZE_THRESHOLD_MB"),
    "max_delete_per_run": read_int("MAX_DELETE_PER_RUN"),
    "max_log_size_mb": read_int("MAX_LOG_SIZE_MB"),
    "log_tail_lines": read_int("LOG_TAIL_LINES"),
    "max_delete_reached": read_int("LIMIT_REACHED") == 1,
    "deleted": {
        "logs": read_int("LOGS_DELETED"),
        "logs_truncated": read_int("LOGS_TRUNCATED"),
        "runs": read_int("RUNS_DELETED"),
        "cache": read_int("CACHE_DELETED"),
        "automation": read_int("AUTOMATION_DELETED"),
        "backups": read_int("BACKUPS_DELETED"),
        "extras": read_int("EXTRAS_DELETED"),
        "total": read_int("TOTAL_DELETED"),
    },
    "bytes_freed": read_int("BYTES_FREED"),
    "bytes_freed_total": read_int("BYTES_FREED_TOTAL"),
    "errors": read_int("ERRORS"),
    "error_total": read_int("ERROR_TOTAL"),
    "status": os.getenv("STATUS", "ok"),
    "events": [],
}
events_path = os.getenv("REPORT_EVENTS_FILE", "").strip()
if events_path:
    try:
        with open(events_path, encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.rstrip("\n")
                if not line:
                    continue
                action, scope, reason, size_bytes, path = (line.split("\t", 4) + ["", "", "", "", ""])[:5]
                payload["events"].append(
                    {
                        "action": action,
                        "scope": scope,
                        "reason": reason,
                        "sizeBytes": int(size_bytes) if size_bytes else 0,
                        "path": path,
                    }
                )
    except Exception:
        pass
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
PY
}

persist_state() {
  local payload_json="$1"
  mkdir -p "$(dirname "$state_path")"
  local tmp_state
  tmp_state="$(mktemp "${state_path}.tmp.XXXXXX")"
  printf '%s\n' "$payload_json" >"$tmp_state"
  mv -f "$tmp_state" "$state_path"
}

read_previous_totals
mkdir -p "$runtime_root"

if scope_enabled "logs"; then
  cleanup_old_files "$logs_dir" "logs"
  if [[ "$abort_requested" -eq 0 && "$limit_reached" -eq 0 ]]; then
    truncate_oversized_non_rotating_logs
  fi
fi
if [[ "$abort_requested" -eq 0 ]] && scope_enabled "runs"; then
  cleanup_runs_by_count
fi
if [[ "$abort_requested" -eq 0 ]] && scope_enabled "cache"; then
  cleanup_old_files "$cache_dir" "cache"
fi
if [[ "$abort_requested" -eq 0 && "$scope" == "automation" ]]; then
  cleanup_automation_pytest_leftovers_when_over_threshold "$automation_dir"
fi
if [[ "$abort_requested" -eq 0 ]] && scope_enabled "backups"; then
  cleanup_old_files_when_over_threshold "$backups_dir" "backups"
fi
if [[ "$abort_requested" -eq 0 ]] && (scope_enabled "all" || scope_enabled "extras"); then
  # Clean tool-output directories that accumulate on every local run
  # and belong to disposable/scratch tiers only.
  for _extras_dir in "${extras_scope_dirs[@]}"; do
    [[ "$abort_requested" -eq 0 ]] || break
    cleanup_old_files_when_over_threshold "$_extras_dir" "extras"
  done
fi

total_deleted=$((logs_deleted + runs_deleted + cache_deleted + automation_deleted + backups_deleted + extras_deleted))
last_run_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ended_epoch="$(python3 - <<'PY'
import time
print(time.time())
PY
)"
duration_seconds="$(python3 - "$started_epoch" "$ended_epoch" <<'PY'
import sys
start = float(sys.argv[1])
end = float(sys.argv[2])
print(max(0.0, end - start))
PY
)"

if [[ "$dry_run" -eq 1 ]]; then
  bytes_freed_total="$previous_bytes_freed_total"
else
  bytes_freed_total=$((previous_bytes_freed_total + bytes_freed))
fi
error_total=$((previous_error_total + errors))

status="ok"
if [[ "$errors" -gt 0 ]]; then
  status="partial"
fi
if [[ "$fail_on_error" -eq 1 && "$errors" -gt 0 ]]; then
  status="error"
fi

payload_json="$(build_result_json "$last_run_at" "$duration_seconds" "$total_deleted" "$status" "$bytes_freed_total" "$error_total")"
persist_state "$payload_json"
if [[ -n "$report_out" ]]; then
  mkdir -p "$(dirname "$report_out")"
  printf '%s\n' "$payload_json" >"$report_out"
fi
printf '%s\n' "$payload_json"

if [[ "$fail_on_error" -eq 1 && "$errors" -gt 0 ]]; then
  exit 1
fi
