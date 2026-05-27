#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH to run cleanup-runtime.sh" >&2
  exit 1
fi

TTL_HOURS=72
MAX_SIZE_GB=2
TARGET=".runtime-cache"
DRY_RUN=1
ALLOW_OUTSIDE_WORKSPACE=0
CONFIRM_APPLY=0
REPORT_OUT=""
MANAGED_SUBDIRS=()
PROTECTED_SUBDIRS=()
REPORT_ROWS="$(mktemp)"
FAST_DIR_TARGETS=("container-gates" "container-runs")

runtime_governance_query() {
  node "$ROOT_DIR/scripts/lib/runtime-governance.mjs" "$@"
}

load_runtime_governance_lists() {
  mapfile -t MANAGED_SUBDIRS < <(runtime_governance_query cleanup-managed-subdirs)
  mapfile -t PROTECTED_SUBDIRS < <(runtime_governance_query protected-subdirs)
}

runtime_class_info_json() {
  runtime_governance_query class-info "$1"
}

read_runtime_class_field() {
  local class_json="$1"
  local field_name="$2"
  python3 - "$class_json" "$field_name" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
value = payload.get(sys.argv[2], "")
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

join_space_separated() {
  if [[ $# -eq 0 ]]; then
    printf '(none)'
    return 0
  fi
  printf '%s' "$1"
  shift
  for item in "$@"; do
    printf ', %s' "$item"
  done
}

load_runtime_governance_lists

usage() {
  cat <<'USAGE'
Usage: scripts/cleanup-runtime.sh [options]

Options:
  --ttl-hours <hours>      Delete files older than this age (default: 72)
  --max-size-gb <gb>       Max retained size across managed dirs (default: 2)
  --target <path>          Runtime root to clean (default: .runtime-cache)
  --report-out <file>      Write structured cleanup selection report JSON to this path
  --allow-outside-workspace
                           Allow cleaning targets outside repo/.runtime-cache
  --dry-run                Preview cleanup actions (default)
  --apply                  Execute deletions
  --confirm-apply          Confirm destructive mode without env var
  -h, --help               Show help

Managed subdirectories under target:
USAGE
  printf '  %s\n' "$(join_space_separated "${MANAGED_SUBDIRS[@]}")"
  cat <<'USAGE'

Protected subdirectories rejected by cleanup-runtime:
USAGE
  printf '  %s\n' "$(join_space_separated "${PROTECTED_SUBDIRS[@]}")"
  cat <<'USAGE'

Safety:
  --apply requires CLEANUP_CONFIRM=YES or --confirm-apply.
  runtime_state and evidence_keep tiers are refused even when targeted directly.
USAGE
}

file_size() {
  local path="$1"
  if stat -c%s "$path" >/dev/null 2>&1; then
    stat -c%s "$path"
  else
    stat -f%z "$path"
  fi
}

file_mtime() {
  local path="$1"
  if stat -c%Y "$path" >/dev/null 2>&1; then
    stat -c%Y "$path"
  else
    stat -f%m "$path"
  fi
}

dir_size_bytes() {
  local path="$1"
  local size_kb=""
  size_kb="$(du -sk "$path" 2>/dev/null | awk '{print $1}')"
  if [[ -z "$size_kb" ]]; then
    echo "0"
    return 0
  fi
  awk -v kb="$size_kb" 'BEGIN { printf "%.0f", kb * 1024 }'
}

looks_like_run_id() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{8}-[0-9]{6}-[0-9]+$ ]]
}

fast_dir_target() {
  local dir_name="$1"
  local candidate=""
  for candidate in "${FAST_DIR_TARGETS[@]}"; do
    if [[ "$candidate" == "$dir_name" ]]; then
      return 0
    fi
  done
  return 1
}

append_manifest_row() {
  local mtime="$1"
  local size="$2"
  local kind="$3"
  local path="$4"
  printf '%s\t%s\t%s\t%s\n' "$mtime" "$size" "$kind" "$path" >>"$manifest"
}

append_file_candidate() {
  local path="$1"
  local size=""
  local mtime=""
  size="$(file_size "$path")"
  mtime="$(file_mtime "$path")"
  append_manifest_row "$mtime" "$size" "file" "$path"
}

append_dir_candidate() {
  local path="$1"
  local size=""
  local mtime=""
  size="$(dir_size_bytes "$path")"
  mtime="$(file_mtime "$path")"
  append_manifest_row "$mtime" "$size" "dir" "$path"
}

collect_file_cleanup_units() {
  local dir="$1"
  while IFS= read -r -d '' file; do
    append_file_candidate "$file"
  done < <(find "$dir" -type f -print0)
}

collect_run_scoped_cleanup_units() {
  local dir="$1"
  local top_entry=""
  local child=""
  local grandchild=""
  local immediate_run_found=0
  local nested_run_found=0

  while IFS= read -r -d '' top_entry; do
    immediate_run_found=0
    while IFS= read -r -d '' child; do
      if looks_like_run_id "$(basename "$child")"; then
        append_dir_candidate "$child"
        immediate_run_found=1
      fi
    done < <(find "$top_entry" -mindepth 1 -maxdepth 1 -type d -print0)
    if (( immediate_run_found )); then
      continue
    fi

    nested_run_found=0
    while IFS= read -r -d '' child; do
      while IFS= read -r -d '' grandchild; do
        if looks_like_run_id "$(basename "$grandchild")"; then
          append_dir_candidate "$grandchild"
          nested_run_found=1
        fi
      done < <(find "$child" -mindepth 1 -maxdepth 1 -type d -print0)
    done < <(find "$top_entry" -mindepth 1 -maxdepth 1 -type d -print0)
    if (( nested_run_found )); then
      continue
    fi

    append_dir_candidate "$top_entry"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -print0)

  while IFS= read -r -d '' top_file; do
    append_file_candidate "$top_file"
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f -print0)
}

bytes_human() {
  local bytes="$1"
  awk -v b="$bytes" 'BEGIN {
    split("B KB MB GB TB", unit, " ");
    i = 1;
    while (b >= 1024 && i < 5) {
      b /= 1024;
      i++;
    }
    printf "%.2f %s", b, unit[i];
  }'
}

resolve_path() {
  local input="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$input" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
    return
  fi

  if command -v realpath >/dev/null 2>&1; then
    local resolved=""
    if resolved="$(realpath "$input" 2>/dev/null)"; then
      printf '%s\n' "$resolved"
      return
    fi
  fi

  case "$input" in
    /*) printf '%s\n' "$input" ;;
    *) printf '%s/%s\n' "$PWD" "$input" ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ttl-hours)
      [[ $# -ge 2 ]] || { echo "missing value for --ttl-hours" >&2; exit 2; }
      TTL_HOURS="$2"
      shift 2
      ;;
    --max-size-gb)
      [[ $# -ge 2 ]] || { echo "missing value for --max-size-gb" >&2; exit 2; }
      MAX_SIZE_GB="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || { echo "missing value for --target" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --report-out)
      [[ $# -ge 2 ]] || { echo "missing value for --report-out" >&2; exit 2; }
      REPORT_OUT="$2"
      shift 2
      ;;
    --allow-outside-workspace)
      ALLOW_OUTSIDE_WORKSPACE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --apply)
      DRY_RUN=0
      shift
      ;;
    --confirm-apply)
      CONFIRM_APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$TTL_HOURS" =~ ^[0-9]+$ ]]; then
  echo "--ttl-hours must be a non-negative integer" >&2
  exit 2
fi

if ! awk -v v="$MAX_SIZE_GB" 'BEGIN { exit !(v ~ /^[0-9]+(\.[0-9]+)?$/) }'; then
  echo "--max-size-gb must be a non-negative number" >&2
  exit 2
fi

MAX_SIZE_BYTES="$(awk -v g="$MAX_SIZE_GB" 'BEGIN { printf "%.0f", g * 1073741824 }')"
TTL_SECONDS=$((TTL_HOURS * 3600))

if [[ "$TARGET" = /* ]]; then
  TARGET_DIR="$TARGET"
else
  TARGET_DIR="$ROOT_DIR/$TARGET"
fi

RUNTIME_CACHE_ROOT="$(resolve_path "$ROOT_DIR/.runtime-cache")"
TARGET_DIR="$(resolve_path "$TARGET_DIR")"

if (( DRY_RUN == 0 )) && [[ "${CLEANUP_CONFIRM:-}" != "YES" ]] && (( CONFIRM_APPLY == 0 )); then
  echo "[cleanup-runtime] --apply requires explicit confirmation" >&2
  echo "[cleanup-runtime] set CLEANUP_CONFIRM=YES or pass --confirm-apply" >&2
  exit 2
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "[cleanup-runtime] target not found, nothing to clean: $TARGET_DIR"
  exit 0
fi

path_is_within() {
  local candidate="$1"
  local root="$2"
  [[ "$candidate" == "$root" || "$candidate" == "$root/"* ]]
}

manifest="$(mktemp)"
sorted_manifest="$(mktemp)"
trap 'rm -f "$manifest" "$sorted_manifest" "$REPORT_ROWS"' EXIT

RUNTIME_ANCHOR="$RUNTIME_CACHE_ROOT"
if ! path_is_within "$TARGET_DIR" "$RUNTIME_CACHE_ROOT"; then
  if (( ALLOW_OUTSIDE_WORKSPACE == 0 )); then
    echo "[cleanup-runtime] refusing target outside repo/.runtime-cache: $TARGET_DIR" >&2
    echo "[cleanup-runtime] rerun with --allow-outside-workspace to override" >&2
    exit 2
  fi
  if [[ "$TARGET_DIR" == */.runtime-cache ]]; then
    RUNTIME_ANCHOR="$TARGET_DIR"
  elif [[ "$TARGET_DIR" == */.runtime-cache/* ]]; then
    RUNTIME_ANCHOR="${TARGET_DIR%%/.runtime-cache/*}/.runtime-cache"
  else
    echo "[cleanup-runtime] refusing outside target that is not under a .runtime-cache root: $TARGET_DIR" >&2
    exit 2
  fi
  echo "[cleanup-runtime] warning: allowing outside target due to --allow-outside-workspace: $TARGET_DIR" >&2
fi

candidate_dirs=()
if [[ "$TARGET_DIR" == "$RUNTIME_ANCHOR" ]]; then
  for sub in "${MANAGED_SUBDIRS[@]}"; do
    dir="$RUNTIME_ANCHOR/$sub"
    if [[ -d "$dir" ]]; then
      candidate_dirs+=("$dir")
    fi
  done
else
  rel_to_anchor="${TARGET_DIR#"$RUNTIME_ANCHOR"/}"
  managed_name="${rel_to_anchor%%/*}"
  if [[ "$TARGET_DIR" != "$RUNTIME_ANCHOR/$managed_name" ]]; then
    echo "[cleanup-runtime] refusing nested target. Use .runtime-cache or one managed dir directly." >&2
    exit 2
  fi
  class_info="$(runtime_class_info_json "$managed_name" || true)"
  if [[ -z "$class_info" ]]; then
    echo "[cleanup-runtime] refusing unmanaged target directory: $TARGET_DIR" >&2
    echo "[cleanup-runtime] managed subdirs: ${MANAGED_SUBDIRS[*]}" >&2
    exit 2
  fi
  retention_tier="$(read_runtime_class_field "$class_info" "retention_tier")"
  if [[ "$retention_tier" == "runtime_state" || "$retention_tier" == "evidence_keep" ]]; then
    echo "[cleanup-runtime] refusing protected runtime tier '$retention_tier': $TARGET_DIR" >&2
    echo "[cleanup-runtime] protected subdirs: ${PROTECTED_SUBDIRS[*]}" >&2
    exit 2
  fi
  if [[ -d "$TARGET_DIR" ]]; then
    candidate_dirs+=("$TARGET_DIR")
  fi
fi

if (( ${#candidate_dirs[@]} == 0 )); then
  echo "[cleanup-runtime] no managed directories found under: $TARGET_DIR"
  exit 0
fi

for dir in "${candidate_dirs[@]}"; do
  dir_name="$(basename "$dir")"
  if fast_dir_target "$dir_name"; then
    collect_run_scoped_cleanup_units "$dir"
  else
    collect_file_cleanup_units "$dir"
  fi
done

if [[ ! -s "$manifest" ]]; then
  echo "[cleanup-runtime] no files to clean in managed directories"
  exit 0
fi

LC_ALL=C sort -n -k1,1 "$manifest" >"$sorted_manifest"

declare -a row_size
declare -a row_path
declare -a row_reason
declare -a row_kind

index=0
total_before=0
ttl_delete_bytes=0
now_epoch="$(date +%s)"

while IFS=$'\t' read -r mtime size kind path; do
  row_size[index]="$size"
  row_path[index]="$path"
  row_reason[index]=""
  row_kind[index]="$kind"

  total_before=$((total_before + size))
  age_seconds=$((now_epoch - mtime))
  if (( TTL_SECONDS >= 0 && age_seconds > TTL_SECONDS )); then
    row_reason[index]="ttl"
    ttl_delete_bytes=$((ttl_delete_bytes + size))
  fi
  index=$((index + 1))
done <"$sorted_manifest"

projected_after_ttl=$((total_before - ttl_delete_bytes))
size_delete_bytes=0
if (( projected_after_ttl > MAX_SIZE_BYTES )); then
  for i in "${!row_path[@]}"; do
    if [[ -n "${row_reason[i]}" ]]; then
      continue
    fi
    row_reason[i]="size"
    size_delete_bytes=$((size_delete_bytes + row_size[i]))
    projected_after_ttl=$((projected_after_ttl - row_size[i]))
    if (( projected_after_ttl <= MAX_SIZE_BYTES )); then
      break
    fi
  done
fi

final_projected=$projected_after_ttl

echo "[cleanup-runtime] mode: $([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo apply)"
echo "[cleanup-runtime] target: $TARGET_DIR"
echo "[cleanup-runtime] ttl-hours: $TTL_HOURS"
echo "[cleanup-runtime] max-size-gb: $MAX_SIZE_GB"
echo "[cleanup-runtime] files scanned: ${#row_path[@]}"
echo "[cleanup-runtime] size before: $(bytes_human "$total_before")"
echo "[cleanup-runtime] ttl cleanup: $(bytes_human "$ttl_delete_bytes")"
echo "[cleanup-runtime] size cleanup: $(bytes_human "$size_delete_bytes")"
echo "[cleanup-runtime] projected size after: $(bytes_human "$final_projected")"

delete_count=0
delete_bytes=0
for i in "${!row_path[@]}"; do
  reason="${row_reason[i]}"
  [[ -n "$reason" ]] || continue

  delete_count=$((delete_count + 1))
  delete_bytes=$((delete_bytes + row_size[i]))
  printf '%s\t%s\t%s\t%s\n' "${row_reason[i]}" "${row_size[i]}" "${row_kind[i]}" "${row_path[i]}" >>"$REPORT_ROWS"

  if (( DRY_RUN == 1 )); then
    echo "[cleanup-runtime] [dry-run] delete ($reason, ${row_kind[i]}): ${row_path[i]}"
    continue
  fi

  if [[ "${row_kind[i]}" == "dir" ]]; then
    rm -rf -- "${row_path[i]}"
  else
    rm -f -- "${row_path[i]}"
  fi
  echo "[cleanup-runtime] deleted ($reason, ${row_kind[i]}): ${row_path[i]}"
done

if (( DRY_RUN == 0 )); then
  for dir in "${candidate_dirs[@]}"; do
    find "$dir" -type d -empty -delete 2>/dev/null || true
  done
fi

echo "[cleanup-runtime] files selected: $delete_count"
echo "[cleanup-runtime] bytes selected: $(bytes_human "$delete_bytes")"

if [[ -n "$REPORT_OUT" ]]; then
  mkdir -p "$(dirname "$REPORT_OUT")"
  REPORT_TARGET="$TARGET_DIR" \
  REPORT_MODE="$([[ $DRY_RUN -eq 1 ]] && echo dry-run || echo apply)" \
  REPORT_TTL_HOURS="$TTL_HOURS" \
  REPORT_MAX_SIZE_GB="$MAX_SIZE_GB" \
  REPORT_FILES_SCANNED="${#row_path[@]}" \
  REPORT_TOTAL_BEFORE="$total_before" \
  REPORT_TTL_DELETE_BYTES="$ttl_delete_bytes" \
  REPORT_SIZE_DELETE_BYTES="$size_delete_bytes" \
  REPORT_FINAL_PROJECTED="$final_projected" \
  REPORT_DELETE_COUNT="$delete_count" \
  REPORT_DELETE_BYTES="$delete_bytes" \
  REPORT_ROWS_PATH="$REPORT_ROWS" \
  python3 - <<'PY' >"$REPORT_OUT"
import json
import os
from pathlib import Path

payload = {
    "mode": os.environ["REPORT_MODE"],
    "target": os.environ["REPORT_TARGET"],
    "ttlHours": int(os.environ["REPORT_TTL_HOURS"]),
    "maxSizeGb": float(os.environ["REPORT_MAX_SIZE_GB"]),
    "filesScanned": int(os.environ["REPORT_FILES_SCANNED"]),
    "sizeBeforeBytes": int(os.environ["REPORT_TOTAL_BEFORE"]),
    "ttlDeleteBytes": int(os.environ["REPORT_TTL_DELETE_BYTES"]),
    "sizeDeleteBytes": int(os.environ["REPORT_SIZE_DELETE_BYTES"]),
    "projectedSizeAfterBytes": int(os.environ["REPORT_FINAL_PROJECTED"]),
    "selectedCount": int(os.environ["REPORT_DELETE_COUNT"]),
    "selectedBytes": int(os.environ["REPORT_DELETE_BYTES"]),
    "selected": [],
}
rows_path = Path(os.environ["REPORT_ROWS_PATH"])
if rows_path.exists():
    for line in rows_path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        reason, size_bytes, kind, path = (line.split("\t", 3) + ["", "", "", ""])[:4]
        payload["selected"].append(
            {
                "reason": reason,
                "sizeBytes": int(size_bytes) if size_bytes else 0,
                "kind": kind,
                "path": path,
            }
        )
print(json.dumps(payload, ensure_ascii=False, indent=2))
PY
fi
