#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 <label> <command...>" >&2
  exit 64
fi

label="$1"
shift

max_attempts="${UIQ_VITEST_COVERAGE_RETRIES:-3}"
if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: UIQ_VITEST_COVERAGE_RETRIES must be a positive integer" >&2
  exit 64
fi

attempt=1
cleanup_vitest_coverage_tmp() {
  local candidate_dirs=()
  if [[ -n "${UIQ_FRONTEND_COVERAGE_DIR:-}" ]]; then
    candidate_dirs+=("${UIQ_FRONTEND_COVERAGE_DIR}")
  fi
  if [[ -n "${UIQ_APPS_WEB_COVERAGE_DIR:-}" ]]; then
    candidate_dirs+=("${UIQ_APPS_WEB_COVERAGE_DIR}")
  fi
  for dir in "${candidate_dirs[@]}"; do
    [[ -d "$dir" ]] || continue
    rm -rf "$dir/.tmp" 2>/dev/null || true
    find "$dir" -maxdepth 1 -type f -name 'coverage-*.json' -delete 2>/dev/null || true
  done
}

while (( attempt <= max_attempts )); do
  log_file="$(mktemp "${TMPDIR:-/tmp}/uiq-vitest-coverage-${label}.XXXXXX")"
  if "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    exit 0
  fi

  status=$?
  if grep -Eq "ENOENT: no such file or directory, open '.*coverage-[0-9]+\\.json'" "$log_file" && (( attempt < max_attempts )); then
    cleanup_vitest_coverage_tmp
    echo "[vitest-coverage-retry][$label] retrying after transient coverage temp-file failure (attempt ${attempt}/${max_attempts})" >&2
    tail -n 40 "$log_file" >&2 || true
    rm -f "$log_file"
    attempt=$((attempt + 1))
    sleep 1
    continue
  fi

  cat "$log_file"
  rm -f "$log_file"
  exit "$status"
done
