#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/ports.sh"

MODE="${1:-${UIQ_PREFLIGHT_MODE:-full}}"
if [[ "$MODE" != "full" && "$MODE" != "minimal" ]]; then
  echo "usage: ./scripts/preflight.sh [full|minimal]"
  exit 1
fi

if [[ "$MODE" == "minimal" ]]; then
  TOTAL_STEPS=2
else
  TOTAL_STEPS=9
fi

declare -a PIDS=()
declare -a LABELS=()

launch_task() {
  local step="$1"
  local label="$2"
  shift 2
  local prefix="[${step}/${TOTAL_STEPS}][${label}]"

  (
    echo "${prefix} START"
    "$@" \
      > >(awk -v p="$prefix" '{ print p " " $0; fflush(); }') \
      2> >(awk -v p="$prefix" '{ print p " " $0; fflush(); }' >&2)
    local rc=$?
    if (( rc == 0 )); then
      echo "${prefix} PASS"
    else
      echo "${prefix} FAIL (exit ${rc})" >&2
    fi
    exit "$rc"
  ) &

  PIDS+=("$!")
  LABELS+=("${step}/${TOTAL_STEPS} ${label}")
}

wait_tasks() {
  local first_rc=0
  local failed=0
  local -a failures=()

  for i in "${!PIDS[@]}"; do
    set +e
    wait "${PIDS[$i]}"
    rc=$?
    set -e

    if (( rc == 0 )); then
      continue
    fi
    ((failed += 1))
    failures+=("${LABELS[$i]} (exit ${rc})")
    if (( first_rc == 0 )); then
      first_rc="$rc"
    fi
  done

  PIDS=()
  LABELS=()

  if (( failed > 0 )); then
    echo "preflight failed (${failed} task(s)):" >&2
    for item in "${failures[@]}"; do
      echo " - ${item}" >&2
    done
    return "$first_rc"
  fi
  return 0
}

if [[ "$MODE" == "minimal" ]]; then
  launch_task "1" "orchestrator run contract tests" \
    bash scripts/lib/node-bin.sh tsx --test packages/orchestrator/src/commands/run.test.ts packages/orchestrator/src/commands/run.runid.test.ts
  launch_task "2" "mcp server typecheck" pnpm mcp:check
  wait_tasks
else
  automation_base_url="${BASE_URL:-}"
  automation_test_command="cd tooling/automation && pnpm test"
  if [[ -z "$automation_base_url" ]]; then
    automation_port_seed="${AUTOMATION_BACKEND_PORT:-${BACKEND_PORT:-17380}}"
    validate_port_number "$automation_port_seed" "AUTOMATION_BACKEND_PORT/BACKEND_PORT"
    if ! automation_port="$(find_available_port "$automation_port_seed" 100)"; then
      echo "error: unable to reserve backend port for automation tests near ${automation_port_seed}" >&2
      exit 1
    fi
    automation_base_url="http://127.0.0.1:${automation_port}"
    automation_test_command="cd tooling/automation && BASE_URL=${automation_base_url} AUTOMATION_BACKEND_PORT=${automation_port} BACKEND_PORT=${automation_port} pnpm test"
    echo "[preflight] automation tests isolated to ${automation_base_url}"
  fi

  echo "[preflight] wave=short-first (wave1 fast gates, wave2 heavy checks)"

  # Wave 1: fast checks first. Fail early to avoid spending time on long suites.
  launch_task "1" "security scan" ./scripts/security-scan.sh
  launch_task "2" "backend lint" bash -lc "cd services/api && RUFF_CACHE_DIR=../../.runtime-cache/cache/ruff ../../scripts/lib/python-exec.sh ruff check ."
  launch_task "4" "frontend lint" bash -lc "cd apps/command-center && pnpm run lint"
  launch_task "8" "orchestrator run contract tests" \
    bash scripts/lib/node-bin.sh tsx --test packages/orchestrator/src/commands/run.test.ts packages/orchestrator/src/commands/run.runid.test.ts
  launch_task "9" "mcp server typecheck" pnpm mcp:check

  wait_tasks

  # Wave 2: heavy/long-running checks run in parallel only after fast gates pass.
  launch_task "3" "backend tests" bash scripts/lib/python-exec.sh pytest
  launch_task "5" "frontend build" bash -lc "cd apps/command-center && pnpm run build"
  launch_task "6" "frontend ui audit" bash -lc "cd apps/command-center && pnpm run audit:ui"
  launch_task "7" "automation tests" bash -lc "$automation_test_command"
  wait_tasks
fi

echo "preflight passed"
