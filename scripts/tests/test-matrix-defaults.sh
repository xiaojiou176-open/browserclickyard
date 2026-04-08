#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/test-matrix-defaults.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

unset UIQ_SUITE_WEB_E2E
unset UIQ_SUITE_FRONTEND_E2E
unset UIQ_SUITE_FRONTEND_UNIT
unset UIQ_SUITE_BACKEND
unset UIQ_SUITE_TEST_TRUTH_GATE
unset UIQ_SUITE_AUTOMATION_CHECK
unset UIQ_SUITE_ORCHESTRATOR_MCP
unset UIQ_SUITE_COVERAGE_GATE
unset UIQ_SUITE_MUTATION_GATE
unset CI
unset UIQ_WEB_PORT
unset UIQ_E2E_PORT
unset UIQ_FRONTEND_E2E_PORT

export UIQ_TEST_LOG_DIR="$tmp_dir/logs"
export UIQ_CONTAINER_GATE_NAME="test-matrix"
export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR="1"
export UIQ_TEST_MATRIX_CMD_APPS_WEB_E2E="true"
export UIQ_TEST_MATRIX_CMD_FRONTEND_E2E="true"
export UIQ_TEST_MATRIX_CMD_FRONTEND_E2E_NONSTUB="true"
export UIQ_TEST_MATRIX_CMD_E2E_AUTHENTICITY_GATE="true"
export UIQ_TEST_MATRIX_CMD_FRONTEND_UNIT="true"
export UIQ_TEST_MATRIX_CMD_BACKEND_PYTEST="true"
export UIQ_TEST_MATRIX_CMD_TEST_TRUTH_GATE="true"
export UIQ_TEST_MATRIX_CMD_ORCHESTRATOR_MCP_GATE="true"
export UIQ_TEST_MATRIX_CMD_AUTOMATION_CHECK="true"
export UIQ_TEST_MATRIX_CMD_COVERAGE_GATE="true"
export UIQ_TEST_MATRIX_CMD_MUTATION_GATE="true"
export UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE="1"

output="$(bash scripts/test-matrix.sh serial 2>&1)"

if ! grep -Fq "ports: web_e2e=4173 frontend_e2e=43173" <<<"$output"; then
  echo "expected default ports line with frontend_e2e=43173" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

for suite in apps-web-e2e frontend-e2e e2e-authenticity-gate frontend-unit backend-pytest test-truth-gate orchestrator-mcp-gate; do
  if ! grep -Fq "[run] $suite" <<<"$output"; then
    echo "expected default-enabled suite '$suite' to run" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
done

if ! grep -Eq "effective\\(.*frontend_e2e=6" <<<"$output"; then
  echo "expected local serial default frontend_e2e workers to be 6" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if ! grep -Fq "[run] automation-check" <<<"$output"; then
  echo "expected automation-check to run by default" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if ! grep -Fq "[run] mutation-gate" <<<"$output"; then
  echo "expected mutation-gate to run by default" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if ! grep -Fq "[run] coverage-gate" <<<"$output"; then
  echo "expected coverage-gate to run by default" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

ci_output="$(CI=true bash scripts/test-matrix.sh serial 2>&1)"
if ! grep -Eq "effective\\(.*frontend_e2e=4" <<<"$ci_output"; then
  echo "expected CI serial default frontend_e2e workers to be 4" >&2
  printf '%s\n' "$ci_output" >&2
  exit 1
fi

legacy_output="$(UIQ_PARALLEL_BUDGET_MODE=fixed bash scripts/test-matrix.sh serial 2>&1)"
if ! grep -Fq "deprecated; using auto" <<<"$legacy_output"; then
  echo "expected deprecated alias warning for UIQ_PARALLEL_BUDGET_MODE=fixed" >&2
  printf '%s\n' "$legacy_output" >&2
  exit 1
fi

echo "test-matrix defaults passed"
