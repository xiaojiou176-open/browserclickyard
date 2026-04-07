#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

LOG_CONTRACT="configs/governance/logging-governance.yaml"
failures=0
declare -A allowed_automation_files=()

fail() {
  echo "[check-no-wild-log-surfaces] FAIL: $1" >&2
  failures=$((failures + 1))
}

while IFS= read -r relative_path; do
  [[ -z "$relative_path" ]] && continue
  allowed_automation_files["$relative_path"]=1
done < <(
  rg --no-filename --no-line-number '^[[:space:]]+path_pattern: \.runtime-cache/logs/automation/' "$LOG_CONTRACT" \
    | sed -E 's/^[[:space:]]*path_pattern: \.runtime-cache\/logs\/automation\///'
)

for candidate in ./*.log ./logs; do
  if [[ -e "$candidate" ]]; then
    fail "unexpected root log surface: ${candidate#./}"
  fi
done

if [[ -e ".runtime-cache/logs/tooling" ]]; then
  fail "deprecated log surface present: .runtime-cache/logs/tooling"
fi

if [[ -d ".runtime-cache/logs/automation" ]]; then
  while IFS= read -r child_path; do
    child_name="$(basename "$child_path")"
    canonical_name="${child_name%%.[0-9]*}"
    if [[ -z "${allowed_automation_files[$canonical_name]:-}" ]]; then
      fail "unexpected automation log surface: .runtime-cache/logs/automation/${child_name}"
    fi
  done < <(find ".runtime-cache/logs/automation" -mindepth 1 -maxdepth 1 -type f | sort)
fi

if (( failures > 0 )); then
  exit 1
fi

echo "[check-no-wild-log-surfaces] PASS"
