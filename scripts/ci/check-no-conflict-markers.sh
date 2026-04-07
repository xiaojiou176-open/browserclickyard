#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

marker_output="$(mktemp)"
cleanup() {
  rm -f "$marker_output"
}
trap cleanup EXIT

if git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- . >"$marker_output" 2>/dev/null; then
  echo "[check-no-conflict-markers] FAIL conflict markers found in tracked files:" >&2
  cat "$marker_output" >&2
  exit 1
fi

echo "[check-no-conflict-markers] PASS"
