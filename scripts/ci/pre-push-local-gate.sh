#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

to_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

HEAVY_MODE="$(to_bool "${UIQ_PREPUSH_HEAVY:-1}")"
ALLOW_LIGHT_PREPUSH="$(to_bool "${UIQ_ALLOW_LIGHT_PREPUSH:-0}")"
ALLOW_LIGHT_PREPUSH_REASON="${UIQ_ALLOW_LIGHT_PREPUSH_REASON:-}"

run_step() {
  local label="$1"
  shift
  echo "[pre-push][${label}] START"
  "$@"
  echo "[pre-push][${label}] PASS"
}

run_step "atomic-commit-gate" pnpm gate:commit:atomic
run_step "lockfile-drift-gate" pnpm gate:lock:drift
run_step "lint-all" pnpm lint:all
run_step "e2e-authenticity-gate" pnpm gate:e2e:authenticity
run_step "workflow-policy-guard" bash scripts/release/check-workflow-pnpm-version-guard.sh
run_step "workflow-runner-governance" bash scripts/lib/node-governance-entry.sh scripts/ci/check-workflow-runner-governance.mjs
run_step "preflight-minimal" bash scripts/preflight.sh minimal

commit_range=""
if git rev-parse --verify --quiet "@{upstream}" >/dev/null; then
  commit_range="@{upstream}...HEAD"
elif git rev-parse --verify --quiet "origin/main" >/dev/null; then
  # Shallow clones (common in CI) may not have enough history for merge-base.
  # Fall back instead of hard-failing the whole gate.
  base="$(git merge-base origin/main HEAD 2>/dev/null || true)"
  if [[ -n "$base" ]]; then
    commit_range="${base}..HEAD"
  fi
elif git rev-parse --verify --quiet "HEAD~1" >/dev/null; then
  commit_range="HEAD~1..HEAD"
fi

staged_files="$(git diff --cached --name-only)"
range_files=""
if [[ -n "$commit_range" ]]; then
  range_files="$(git diff --name-only "$commit_range" 2>/dev/null || true)"
elif git rev-parse --verify --quiet "HEAD" >/dev/null; then
  range_files="$(git show --name-only --pretty=format: HEAD)"
fi

changed_files="$(
  {
    printf '%s\n' "$staged_files"
    printf '%s\n' "$range_files"
  } | sed '/^$/d' | sort -u
)"

code_change_detected=0
if [[ -n "${changed_files}" ]] && printf '%s\n' "${changed_files}" | grep -Eq '^(apps/|tooling/automation/|services/api/|contracts/|apps/command-center/|packages/|tests/)'; then
  code_change_detected=1
fi
if [[ -n "${changed_files}" ]] && printf '%s\n' "${changed_files}" | grep -Eq '^(configs/)'; then
  code_change_detected=1
fi
if [[ -n "${changed_files}" ]] && printf '%s\n' "${changed_files}" | grep -Eq '^(\.github/|scripts/)'; then
  code_change_detected=1
fi
if [[ -n "${changed_files}" ]] && printf '%s\n' "${changed_files}" | grep -Eq '^(package\.json|pnpm-lock\.yaml|pyproject\.toml|uv\.lock|Dockerfile|docker-compose(\.[^/]+)?\.ya?ml|compose(\.[^/]+)?\.ya?ml|\.pre-commit-config\.yaml)$'; then
  code_change_detected=1
fi

if [[ "$HEAVY_MODE" == "1" ]]; then
  run_step "test-matrix" bash scripts/ci/run-gate-in-container.sh test-matrix
  run_step "verify-all" env UIQ_VERIFY_ENABLE_COVERAGE_GATE=0 UIQ_VERIFY_ENABLE_MUTATION_GATE=0 UIQ_VERIFY_ENABLE_E2E_AUTHENTICITY=0 UIQ_VERIFY_ENABLE_FRONTEND_NONSTUB=0 bash scripts/ci/run-gate-in-container.sh verify-all
else
  if [[ "$code_change_detected" == "1" && "$ALLOW_LIGHT_PREPUSH" == "1" && -z "${ALLOW_LIGHT_PREPUSH_REASON// }" ]]; then
    echo "[pre-push] FAIL: UIQ_ALLOW_LIGHT_PREPUSH=1 requires UIQ_ALLOW_LIGHT_PREPUSH_REASON for auditability." >&2
    exit 1
  fi
  if [[ "$code_change_detected" == "1" && "$ALLOW_LIGHT_PREPUSH" != "1" ]]; then
    echo "[pre-push] FAIL: code changes detected but heavy gates are disabled (UIQ_PREPUSH_HEAVY=$HEAVY_MODE)." >&2
    echo "[pre-push] Rerun with UIQ_PREPUSH_HEAVY=1 for full local parity, or set UIQ_ALLOW_LIGHT_PREPUSH=1 to bypass explicitly." >&2
    exit 1
  fi
  if [[ "$code_change_detected" == "1" && "$ALLOW_LIGHT_PREPUSH" == "1" ]]; then
    echo "[pre-push] WARN: light pre-push override enabled. reason=${ALLOW_LIGHT_PREPUSH_REASON}"
  fi
  echo "[pre-push] heavy gates skipped (UIQ_PREPUSH_HEAVY=$HEAVY_MODE)"
fi

echo "pre-push local quality gate passed"
