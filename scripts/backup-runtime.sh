#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/backup-runtime.sh [options]

Options:
  --runtime-root <DIR>     Runtime root directory to archive (default: RUNTIME_ROOT or .runtime-cache)
  --backup-dir <DIR>       Backup output directory (default: <runtime-root>/backups)
  --retention-days <N>     Delete backup archives older than N days (default: 14)
  --keep-count <N>         Keep latest N backup archives after age cleanup (default: 20)
  --dry-run                Preview backup target and retention deletions without filesystem changes
  -h, --help               Show this help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

runtime_root="${RUNTIME_ROOT:-.runtime-cache}"
backup_dir="$runtime_root/backups"
retention_days="14"
keep_count="20"
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-root)
      runtime_root="${2:-}"
      shift 2
      ;;
    --backup-dir)
      backup_dir="${2:-}"
      shift 2
      ;;
    --retention-days)
      retention_days="${2:-}"
      shift 2
      ;;
    --keep-count)
      keep_count="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
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
if ! [[ "$keep_count" =~ ^[0-9]+$ ]]; then
  echo "error: --keep-count must be a non-negative integer" >&2
  exit 1
fi

mtime_epoch() {
  local target="$1"
  if stat -f "%m" "$target" >/dev/null 2>&1; then
    stat -f "%m" "$target"
    return 0
  fi
  stat -c "%Y" "$target"
}

remove_archive() {
  local archive="$1"
  if [[ "$dry_run" -eq 1 ]]; then
    echo "[dry-run] remove backup $archive"
    return 0
  fi
  rm -f -- "$archive"
}

cleanup_old_backups() {
  if [[ ! -d "$backup_dir" ]]; then
    return 0
  fi
  while IFS= read -r -d '' archive; do
    remove_archive "$archive"
  done < <(find "$backup_dir" -maxdepth 1 -type f -name 'runtime-*.tgz' -mtime +"$retention_days" -print0)
}

cleanup_backup_count() {
  if [[ ! -d "$backup_dir" ]]; then
    return 0
  fi

  local rows=()
  while IFS= read -r -d '' archive; do
    rows+=("$(mtime_epoch "$archive")|$archive")
  done < <(find "$backup_dir" -maxdepth 1 -type f -name 'runtime-*.tgz' -print0)

  if (( ${#rows[@]} == 0 )); then
    return 0
  fi

  local sorted=()
  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    sorted+=("$row")
  done < <(printf '%s\n' "${rows[@]}" | sort -t'|' -k1,1nr)

  local total="${#sorted[@]}"
  if (( total <= keep_count )); then
    return 0
  fi

  local idx
  for ((idx = keep_count; idx < total; idx++)); do
    remove_archive "${sorted[$idx]#*|}"
  done
}

if [[ "$dry_run" -eq 1 ]]; then
  echo "[dry-run] backup target: $backup_dir/runtime-$(date -u +%Y%m%d-%H%M%S).tgz"
else
  if [[ ! -d "$runtime_root" ]]; then
    echo "backup failed: runtime root is missing: $runtime_root" >&2
    exit 1
  fi
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  target="$backup_dir/runtime-$stamp.tgz"
  tar -czf "$target" --exclude="$backup_dir" "$runtime_root"
  if [[ ! -s "$target" ]]; then
    echo "backup failed: archive is missing or empty" >&2
    exit 1
  fi
  if ! tar -tzf "$target" >/dev/null 2>&1; then
    echo "backup failed: archive integrity check failed" >&2
    exit 1
  fi
  echo "backup created: $target"
fi

cleanup_old_backups
cleanup_backup_count
