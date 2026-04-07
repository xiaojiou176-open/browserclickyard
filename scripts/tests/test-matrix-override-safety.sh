#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/test-matrix-override-safety.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

export UIQ_SUITE_WEB_E2E=0
export UIQ_SUITE_FRONTEND_E2E=0
export UIQ_SUITE_FRONTEND_UNIT=1
export UIQ_SUITE_BACKEND=0
export UIQ_SUITE_AUTOMATION_CHECK=0
export UIQ_SUITE_ORCHESTRATOR_MCP=0
export UIQ_SUITE_TEST_TRUTH_GATE=0
export UIQ_SUITE_COVERAGE_GATE=0
export UIQ_SUITE_MUTATION_GATE=0
export UIQ_TEST_LOG_DIR="$tmp_dir/logs"
export UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE="1"

assert_rejected_payload() {
  local payload="$1"
  local marker="$2"

  set +e
  local output
  output="$(UIQ_TEST_MATRIX_CMD_FRONTEND_UNIT="$payload" bash scripts/test-matrix.sh serial 2>&1)"
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "expected override payload to be rejected: $payload" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  if [[ -e "$marker" ]]; then
    echo "dangerous payload executed unexpectedly and created marker: $marker" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  if ! grep -Fq "error: invalid override command for frontend-unit" <<<"$output"; then
    echo "expected invalid override error for payload: $payload" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

marker_semicolon="$tmp_dir/semicolon-pwned"
assert_rejected_payload "true;touch $marker_semicolon" "$marker_semicolon"

marker_subshell="$tmp_dir/subshell-pwned"
assert_rejected_payload "true \$(touch $marker_subshell)" "$marker_subshell"

echo "test-matrix override safety passed"
