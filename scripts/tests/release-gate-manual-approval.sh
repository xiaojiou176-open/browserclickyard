#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/release-gate-test.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

repo_dir="$tmp_dir/repo"
mkdir -p "$repo_dir/scripts"
cp scripts/release-gate.sh "$repo_dir/scripts/release-gate.sh"
chmod +x "$repo_dir/scripts/release-gate.sh"

cd "$repo_dir"
git init -q
git config user.name "Release Gate Test"
git config user.email "release-gate-test@example.com"

echo "base" > base.txt
git add base.txt
git commit -q -m "base"
git tag v0.0.1

for i in $(seq 1 51); do
  printf 'file %s\n' "$i" > "file-$i.txt"
done
git add .
git commit -q -m "touch 51 files"

output_path="$tmp_dir/result.json"
set +e
output="$(bash scripts/release-gate.sh --tag=v0.0.1 --output="$output_path" 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "expected release gate to hard-block when decision=MANUAL_APPROVAL_REQUIRED" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if [[ ! -f "$output_path" ]]; then
  echo "expected output report to be generated" >&2
  exit 1
fi

python3 - "$output_path" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    payload = json.load(handle)

assert payload["status"] == "AUDIT_ONLY", payload
assert payload["decision"] == "MANUAL_APPROVAL_REQUIRED", payload
assert payload["reason_code"] == "changed_files_gt_50", payload
assert payload["changed_files"] > 50, payload
PY

if ! grep -Fq "decision: MANUAL_APPROVAL_REQUIRED" <<<"$output"; then
  echo "expected summary output to keep decision line for compatibility" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "release-gate manual-approval hard-block passed"
