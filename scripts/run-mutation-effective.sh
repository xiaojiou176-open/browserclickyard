#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PNPM_SAFE=(bash scripts/lib/pnpm-safe.sh)

ts_rc=0
py_rc=0
summary_rc=0

set +e
"${PNPM_SAFE[@]}" run mutation:ts
ts_rc=$?
"${PNPM_SAFE[@]}" run mutation:py:strict
py_rc=$?
UIQ_MUTATION_SUMMARY_STRICT=1 "${PNPM_SAFE[@]}" run mutation:summary
summary_rc=$?
set -e

if (( ts_rc != 0 || py_rc != 0 || summary_rc != 0 )); then
  echo "[mutation][effective] failed: ts_rc=${ts_rc}, py_rc=${py_rc}, summary_rc=${summary_rc}" >&2
  echo "[mutation][effective] See .runtime-cache/reports/mutation/latest-summary.json and .runtime-cache/reports/mutation/py/mutmut-run.log for actionable details." >&2
  exit 1
fi

echo "[mutation][effective] passed: ts, py and summary gates are ready."
