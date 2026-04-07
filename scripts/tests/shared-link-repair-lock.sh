#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/shared-link-repair-lock.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

lock_root="$tmp_dir/node-modules"
mkdir -p "$lock_root/.repair-lock"

sleep 5 &
holder_pid="$!"
printf '%s\n' "$holder_pid" > "$lock_root/.repair-lock/pid"

set +e
output="$(
  UIQ_NODE_MODULES_DIR="$lock_root" \
  UIQ_SHARED_MODULE_REPAIR_LOCK_TIMEOUT_SEC=2 \
  bash -lc "source '$ROOT_DIR/scripts/lib/node-toolchain.sh'; uiq_repair_shared_module_links '$ROOT_DIR'" 2>&1
)"
rc=$?
set -e

kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

if [[ "$rc" -eq 0 ]]; then
  echo "expected uiq_repair_shared_module_links to time out while lock is held" >&2
  exit 1
fi

if ! grep -Fq "[shared-link-repair] waiting for repair lock held by pid=${holder_pid}" <<<"$output"; then
  echo "expected lock wait message to mention holder pid ${holder_pid}" >&2
  echo "$output" >&2
  exit 1
fi

if ! grep -Fq "timed out waiting for shared module repair lock" <<<"$output"; then
  echo "expected lock timeout message" >&2
  echo "$output" >&2
  exit 1
fi

echo "shared-link-repair lock messaging checks passed"
