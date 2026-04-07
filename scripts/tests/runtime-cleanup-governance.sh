#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_parent="$(mktemp -d)"
runtime_root="$tmp_parent/.runtime-cache"
report_path="$tmp_parent/cleanup-report.json"

cleanup() {
  rm -rf "$tmp_parent"
}
trap cleanup EXIT

mkdir -p \
  "$runtime_root/coverage" \
  "$runtime_root/pytest-cache" \
  "$runtime_root/reports" \
  "$runtime_root/automation" \
  "$runtime_root/test-output"

printf 'coverage\n' >"$runtime_root/coverage/stale.txt"
printf 'pytest\n' >"$runtime_root/pytest-cache/cache.txt"
printf 'report\n' >"$runtime_root/reports/keep.txt"
printf 'ledger\n' >"$runtime_root/automation/tasks.json"
printf 'state\n' >"$runtime_root/test-output/state.db"

touch -t 202001010000 \
  "$runtime_root/coverage/stale.txt" \
  "$runtime_root/pytest-cache/cache.txt" \
  "$runtime_root/reports/keep.txt" \
  "$runtime_root/automation/tasks.json" \
  "$runtime_root/test-output/state.db"

dry_run_output="$(
  bash scripts/cleanup-runtime.sh \
    --dry-run \
    --allow-outside-workspace \
    --target "$runtime_root" \
    --report-out "$report_path" \
    --ttl-hours 1 \
    --max-size-gb 999 2>&1
)"

if ! grep -Fq "$runtime_root/coverage/stale.txt" <<<"$dry_run_output"; then
  echo "expected cleanup-runtime dry-run to include disposable coverage file" >&2
  exit 1
fi
if ! grep -Fq "$runtime_root/pytest-cache/cache.txt" <<<"$dry_run_output"; then
  echo "expected cleanup-runtime dry-run to include scratch pytest cache file" >&2
  exit 1
fi
for protected_target in \
  "$runtime_root/reports/keep.txt" \
  "$runtime_root/automation/tasks.json" \
  "$runtime_root/test-output/state.db"; do
  if grep -Fq "$protected_target" <<<"$dry_run_output"; then
    echo "cleanup-runtime dry-run must not select protected target $protected_target" >&2
    exit 1
  fi
done

python3 - "$report_path" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
selected_paths = {item["path"] for item in payload["selected"]}
assert payload["mode"] == "dry-run"
assert any(path.endswith("/coverage/stale.txt") for path in selected_paths)
assert any(path.endswith("/pytest-cache/cache.txt") for path in selected_paths)
assert all("/reports/keep.txt" not in path for path in selected_paths)
assert all("/automation/tasks.json" not in path for path in selected_paths)
assert all("/test-output/state.db" not in path for path in selected_paths)
PY

for protected_dir in reports automation test-output; do
  set +e
  protected_output="$(
    bash scripts/cleanup-runtime.sh \
      --dry-run \
      --allow-outside-workspace \
      --target "$runtime_root/$protected_dir" 2>&1
  )"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "expected cleanup-runtime to reject protected dir $protected_dir" >&2
    exit 1
  fi
  if ! grep -Fq "refusing protected runtime tier" <<<"$protected_output"; then
    echo "expected protected-tier refusal for $protected_dir" >&2
    exit 1
  fi
done

echo "runtime-cleanup governance checks passed"
