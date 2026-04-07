#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_parent="$(mktemp -d)"
runtime_root="$tmp_parent/.runtime-cache"

cleanup() {
  rm -rf "$tmp_parent"
}
trap cleanup EXIT

mkdir -p \
  "$runtime_root/coverage" \
  "$runtime_root/pytest-cache" \
  "$runtime_root/reports" \
  "$runtime_root/test-output" \
  "$runtime_root/automation/pytest-stale" \
  "$runtime_root/automation/universal"

printf 'coverage\n' >"$runtime_root/coverage/stale.txt"
printf 'pytest cache\n' >"$runtime_root/pytest-cache/cache.txt"
printf 'report\n' >"$runtime_root/reports/keep.txt"
printf 'state\n' >"$runtime_root/test-output/state.db"
printf 'pytest run residue\n' >"$runtime_root/automation/pytest-stale/run.log"
printf 'ledger\n' >"$runtime_root/automation/universal/index.json"
printf 'task\n' >"$runtime_root/automation/tasks.json"

touch -t 202001010000 \
  "$runtime_root/coverage/stale.txt" \
  "$runtime_root/pytest-cache/cache.txt" \
  "$runtime_root/reports/keep.txt" \
  "$runtime_root/test-output/state.db" \
  "$runtime_root/automation/pytest-stale" \
  "$runtime_root/automation/pytest-stale/run.log" \
  "$runtime_root/automation/universal/index.json" \
  "$runtime_root/automation/tasks.json"

all_output="$(
  bash scripts/runtime-gc.sh \
    --runtime-root "$runtime_root" \
    --scope all \
    --retention-days 0 \
    --dir-size-threshold-mb 0 \
    --dry-run 2>&1
)"

for expected in \
  "$runtime_root/coverage/stale.txt" \
  "$runtime_root/pytest-cache/cache.txt"; do
  if ! grep -Fq "$expected" <<<"$all_output"; then
    echo "expected runtime-gc --scope all dry-run to include $expected" >&2
    exit 1
  fi
done
for protected_target in \
  "$runtime_root/reports/keep.txt" \
  "$runtime_root/test-output/state.db" \
  "$runtime_root/automation/pytest-stale/run.log"; do
  if grep -Fq "$protected_target" <<<"$all_output"; then
    echo "runtime-gc --scope all must not target protected surface $protected_target" >&2
    exit 1
  fi
done

automation_output="$(
  bash scripts/runtime-gc.sh \
    --runtime-root "$runtime_root" \
    --scope automation \
    --retention-days 0 \
    --dir-size-threshold-mb 0 \
    --dry-run 2>&1
)"

if ! grep -Fq "$runtime_root/automation/pytest-stale" <<<"$automation_output"; then
  echo "expected automation scope to target pytest-* leftovers" >&2
  exit 1
fi
for protected_target in \
  "$runtime_root/automation/tasks.json" \
  "$runtime_root/automation/universal/index.json"; do
  if grep -Fq "$protected_target" <<<"$automation_output"; then
    echo "automation scope must not target runtime ledgers $protected_target" >&2
    exit 1
  fi
done

echo "runtime-gc tier boundary checks passed"
