#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

to_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

is_weak_automation_token() {
  local normalized
  normalized="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  normalized="${normalized//[[:space:]]/}"
  if [[ -z "$normalized" ]]; then
    return 0
  fi
  if (( ${#normalized} < 16 )); then
    return 0
  fi
  [[ "$normalized" =~ (replace|placeholder|changeme|dummy|example|fake|test-token|strong-token) ]]
}

resolve_nonstub_automation_token() {
  local candidate=""
  for candidate in "${UIQ_AUTOMATION_TOKEN:-}" "${AUTOMATION_API_TOKEN:-}" "${AUTOMATION_TOKEN:-}"; do
    if [[ -n "${candidate// }" ]] && ! is_weak_automation_token "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' 'uiq-local-nonstub-token-1234567890'
}

require_host_diagnostic_reason() {
  local reason="${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON:-}"
  if [[ -z "${reason// }" ]]; then
    echo "error: UIQ_ALLOW_HOST_GATE_DIAGNOSTIC=1 requires UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON" >&2
    exit 1
  fi
}

if [[ -z "${UIQ_CONTAINER_GATE_NAME:-}" ]]; then
  if [[ "$(to_bool "${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC:-0}")" == "1" ]]; then
    require_host_diagnostic_reason
    echo "warn: running verify-all on host diagnostic path. reason=${UIQ_ALLOW_HOST_GATE_DIAGNOSTIC_REASON}"
  else
    exec bash "$ROOT_DIR/scripts/ci/run-gate-in-container.sh" verify-all
  fi
fi

source "$ROOT_DIR/scripts/lib/ports.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"
uiq_repair_shared_module_links "$ROOT_DIR"

PNPM_SAFE="bash scripts/lib/pnpm-safe.sh"

RUN_SUFFIX="$(date +%s)"
WEB_RUN_ID="verify-web-${RUN_SUFFIX}"
TAURI_RUN_ID="verify-tauri-${RUN_SUFFIX}"
SWIFT_RUN_ID="verify-swift-${RUN_SUFFIX}"

resolve_web_runtime_port() {
  local runner_name="${RUNNER_NAME:-}"
  local suffix=""
  if [[ "$runner_name" =~ -([0-9]{2})$ ]]; then
    suffix="${BASH_REMATCH[1]}"
  fi

  if [[ -z "$suffix" ]]; then
    local candidate
    local path_candidates=("${GITHUB_WORKSPACE:-}" "${PWD:-}" "${RUNNER_TEMP:-}")
    for candidate in "${path_candidates[@]}"; do
      if [[ -z "$candidate" ]]; then
        continue
      fi
      # Prefer runner-like fragments such as pool-core02-01 embedded in CI paths.
      if [[ "$candidate" =~ pool-core[0-9]{2}-([0-9]{2})([^0-9]|$) ]]; then
        suffix="${BASH_REMATCH[1]}"
        break
      fi
    done
  fi

  local preferred_port
  case "$suffix" in
    01) preferred_port="44173" ;;
    02) preferred_port="44174" ;;
    03) preferred_port="44175" ;;
    *) preferred_port="${UIQ_WEB_PORT:-44173}" ;;
  esac

  if ! validate_port_number "$preferred_port" "UIQ_WEB_PORT"; then
    return 1
  fi
  if find_available_port "$preferred_port" 200 >/dev/null 2>&1; then
    find_available_port "$preferred_port" 200
    return 0
  fi
  if find_available_port 45000 1000 >/dev/null 2>&1; then
    find_available_port 45000 1000
    return 0
  fi
  echo "error: no available verify-all web runtime port found" >&2
  return 1
}

WEB_RUNTIME_PORT="$(resolve_web_runtime_port)"
WEB_RUNTIME_BASE_URL="http://127.0.0.1:${WEB_RUNTIME_PORT}"
ENABLE_COVERAGE_GATE="$(to_bool "${UIQ_VERIFY_ENABLE_COVERAGE_GATE:-1}")"
CI_CONTEXT="$(to_bool "${CI:-}")"
DEFAULT_MUTATION_GATE="1"
ENABLE_MUTATION_GATE="$(to_bool "${UIQ_VERIFY_ENABLE_MUTATION_GATE:-$DEFAULT_MUTATION_GATE}")"
ENABLE_E2E_AUTHENTICITY="$(to_bool "${UIQ_VERIFY_ENABLE_E2E_AUTHENTICITY:-1}")"
ENABLE_FRONTEND_NONSTUB="$(to_bool "${UIQ_VERIFY_ENABLE_FRONTEND_NONSTUB:-1}")"
BRANCH_PROTECTION_STRICT="$(to_bool "${UIQ_VERIFY_BRANCH_PROTECTION_STRICT:-0}")"
PARALLEL_OPTIONAL_GATES="$(to_bool "${UIQ_VERIFY_PARALLEL_OPTIONAL_GATES:-1}")"
ENABLE_TAURI_GATE="$(to_bool "${UIQ_VERIFY_ENABLE_TAURI_GATE:-0}")"
COVERAGE_GATE_EXPLICIT="${UIQ_VERIFY_ENABLE_COVERAGE_GATE+x}"
MUTATION_GATE_EXPLICIT="${UIQ_VERIFY_ENABLE_MUTATION_GATE+x}"
BRANCH_PROTECTION_EXPLICIT="${UIQ_VERIFY_BRANCH_PROTECTION_STRICT+x}"

if [[ "$CI_CONTEXT" == "1" ]]; then
  if [[ -z "$COVERAGE_GATE_EXPLICIT" ]]; then
    ENABLE_COVERAGE_GATE="1"
  fi
  if [[ -z "$MUTATION_GATE_EXPLICIT" ]]; then
    ENABLE_MUTATION_GATE="1"
  fi
  if [[ -z "$BRANCH_PROTECTION_EXPLICIT" ]]; then
    if [[ "${GITHUB_EVENT_NAME:-}" == "push" || "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
      BRANCH_PROTECTION_STRICT="1"
    else
      BRANCH_PROTECTION_STRICT="0"
    fi
  fi
fi

bootstrap_trusted_bin_dirs() {
  local pnpm_bin
  pnpm_bin="$(command -v pnpm || true)"
  if [[ -z "$pnpm_bin" ]]; then
    return 0
  fi

  local pnpm_dir
  pnpm_dir="$(cd "$(dirname "$pnpm_bin")" && pwd)"
  local current="${UIQ_TRUSTED_BIN_DIRS:-}"
  if [[ -z "$current" ]]; then
    export UIQ_TRUSTED_BIN_DIRS="${pnpm_dir}"
    return 0
  fi
  if [[ ",${current}," == *",${pnpm_dir},"* ]]; then
    return 0
  fi
  export UIQ_TRUSTED_BIN_DIRS="${current},${pnpm_dir}"
}

bootstrap_trusted_bin_dirs

load_repo_env_if_present() {
  local env_file="$ROOT_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

load_repo_env_if_present

if [[ -z "${GEMINI_API_KEY:-}" && -n "${LIVE_GEMINI_API_KEY:-}" ]]; then
  export GEMINI_API_KEY="${LIVE_GEMINI_API_KEY}"
fi

CONTRACT_ARTIFACT_PATHS=(
  "tests/web-harness/src/api-gen"
  "tests/web-harness/msw/handlers.ts"
)

capture_contract_artifacts_state() {
  local status_snapshot diff_snapshot untracked_snapshot
  status_snapshot="$(git status --porcelain -- "${CONTRACT_ARTIFACT_PATHS[@]}")"
  diff_snapshot="$(git --no-pager diff -- "${CONTRACT_ARTIFACT_PATHS[@]}")"
  untracked_snapshot="$(git ls-files --others --exclude-standard -- "${CONTRACT_ARTIFACT_PATHS[@]}")"
  printf "%s\n--STATUS--\n%s\n--UNTRACKED--\n%s\n--DIFF--\n%s\n" \
    "${CONTRACT_ARTIFACT_PATHS[*]}" \
    "$status_snapshot" \
    "$untracked_snapshot" \
    "$diff_snapshot"
}

verify_generated_contract_artifacts_clean() {
  local before_state="$1"
  local after_state
  after_state="$(capture_contract_artifacts_state)"
  if [[ "$before_state" == "$after_state" ]]; then
    echo "[contract-artifacts] PASS generated artifacts are synced with source"
    return 0
  fi

  echo "[contract-artifacts] FAIL generated artifacts changed after contracts:generate"
  echo "[contract-artifacts] action: run 'pnpm contracts:generate' and commit:"
  echo "[contract-artifacts]   - tests/web-harness/src/api-gen/**"
  echo "[contract-artifacts]   - tests/web-harness/msw/handlers.ts"
  git --no-pager diff -- "${CONTRACT_ARTIFACT_PATHS[@]}" | sed -n '1,120p'
  return 1
}

run_optional_gates() {
  local commands=()
  if [[ "$ENABLE_COVERAGE_GATE" == "1" ]]; then
    commands+=("${PNPM_SAFE} test:coverage")
  fi
  if [[ "$ENABLE_MUTATION_GATE" == "1" ]]; then
    commands+=("${PNPM_SAFE} mutation:effective")
  fi

  if [[ "${#commands[@]}" -eq 0 ]]; then
    echo "[optional-gates] coverage/mutation disabled by config"
    return 0
  fi

  if [[ "${#commands[@]}" -eq 1 || "$PARALLEL_OPTIONAL_GATES" != "1" ]]; then
    local index=1
    local total="${#commands[@]}"
    for command in "${commands[@]}"; do
      echo "[optional-gates:${index}/${total}] ${command}"
      bash -lc "${command}"
      index=$((index + 1))
    done
    return 0
  fi

  local pids=()
  for command in "${commands[@]}"; do
    (
      set -euo pipefail
      bash -lc "${command}"
    ) &
    pids+=("$!")
  done

  local gate_failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      gate_failed=1
    fi
  done
  if [[ "$gate_failed" -ne 0 ]]; then
    return 1
  fi
}

run_branch_protection_gate() {
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
    current_branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-${GITHUB_BASE_REF:-}}}"
  fi
  if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
    echo "[branch-protection] skip: cannot infer current branch."
    echo "[branch-protection] action: run 'bash scripts/ci/check-branch-protection.sh --branch <branch>' manually."
    if [[ "$BRANCH_PROTECTION_STRICT" == "1" ]]; then
      echo "[branch-protection] strict mode: infer-branch failure is blocking"
      return 1
    fi
    return 0
  fi

  set +e
  bash scripts/ci/check-branch-protection.sh --branch "$current_branch"
  local status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "[branch-protection] verification failed with exit code $status."
    echo "[branch-protection] action: ensure gh auth/repo permission and keep exactly one aggregate required check."
    echo "[branch-protection] rerun: bash scripts/ci/check-branch-protection.sh --branch $current_branch"
    if [[ "$status" -eq 2 ]]; then
      if [[ "$BRANCH_PROTECTION_STRICT" == "1" ]]; then
        echo "[branch-protection] strict mode: non-policy failure is blocking"
        return "$status"
      fi
      echo "[branch-protection] non-policy failure (auth/permission/transport); treating as non-blocking."
      return 0
    fi
    if [[ "$BRANCH_PROTECTION_STRICT" == "1" ]]; then
      echo "[branch-protection] strict mode: failing verify-all"
      return "$status"
    fi
  fi
}

CONTRACT_ARTIFACT_STATE_BEFORE_GENERATE="$(capture_contract_artifacts_state)"

echo "[1/14] lockfile drift gate"
"${ROOT_DIR}/scripts/lib/pnpm-safe.sh" gate:lock:drift

echo "[2/14] contracts:generate"
"${ROOT_DIR}/scripts/lib/pnpm-safe.sh" contracts:generate

echo "[3/14] contract artifact drift check"
verify_generated_contract_artifacts_clean "$CONTRACT_ARTIFACT_STATE_BEFORE_GENERATE"

echo "[4/14] lint matrix (scripts/lint-all.sh)"
bash scripts/lint-all.sh

echo "[5/14] env governance reduction enforce"
"${ROOT_DIR}/scripts/lib/pnpm-safe.sh" env:governance:enforce

echo "[6/14] diff-doc-linkage gate"
"${ROOT_DIR}/scripts/lib/pnpm-safe.sh" gate:docs:diff-linkage

echo "[7/14] optional coverage/mutation gates"
run_optional_gates

echo "[8/14] e2e authenticity gate"
if [[ "$ENABLE_E2E_AUTHENTICITY" == "1" ]]; then
  "${ROOT_DIR}/scripts/lib/pnpm-safe.sh" gate:e2e:authenticity
else
  echo "Skipping e2e authenticity gate: UIQ_VERIFY_ENABLE_E2E_AUTHENTICITY=0"
fi

echo "[9/14] frontend nonstub e2e"
if [[ "$ENABLE_FRONTEND_NONSTUB" == "1" ]]; then
  NONSTUB_BACKEND_PORT="${UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT:-28173}"
  NONSTUB_AUTOMATION_TOKEN="$(resolve_nonstub_automation_token)"
  export UIQ_AUTOMATION_TOKEN="${NONSTUB_AUTOMATION_TOKEN}"
  export AUTOMATION_API_TOKEN="${NONSTUB_AUTOMATION_TOKEN}"
  export AUTOMATION_TOKEN="${NONSTUB_AUTOMATION_TOKEN}"
  UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT="${NONSTUB_BACKEND_PORT}" \
  BACKEND_PORT="${NONSTUB_BACKEND_PORT}" \
  VITE_DEFAULT_BASE_URL="http://127.0.0.1:${NONSTUB_BACKEND_PORT}" \
  "${ROOT_DIR}/scripts/lib/pnpm-safe.sh" test:e2e:frontend:nonstub
else
  echo "Skipping frontend nonstub e2e: UIQ_VERIFY_ENABLE_FRONTEND_NONSTUB=0"
fi

echo "[10/14] web pr profile"
UIQ_WEB_PORT="$WEB_RUNTIME_PORT" "${ROOT_DIR}/scripts/lib/pnpm-safe.sh" uiq run --profile pr --target web.ci --run-id "$WEB_RUN_ID" --base-url "$WEB_RUNTIME_BASE_URL"

echo "[11/14] verify run evidence (web pr)"
node scripts/ci/verify-run-evidence.mjs --profile pr --runs-dir .runtime-cache/artifacts/runs --run-id "$WEB_RUN_ID"

echo "[12/14] tauri smoke profile"
if [[ "$ENABLE_TAURI_GATE" == "1" ]]; then
  "${ROOT_DIR}/scripts/lib/pnpm-safe.sh" uiq run --profile tauri.smoke --target tauri.macos --run-id "$TAURI_RUN_ID"
else
  echo "Skipping tauri smoke: set UIQ_VERIFY_ENABLE_TAURI_GATE=1 to enable local/CI tauri gate"
  TAURI_RUN_ID=""
fi

echo "[13/14] swift smoke profile"
# 不要动 Quotio！swift.macos 默认 bundleId 为空，必须显式设 SWIFT_BUNDLE_ID 或传 --bundle-id
if [ -z "${SWIFT_BUNDLE_ID:-}" ]; then
  echo "Skipping swift smoke: SWIFT_BUNDLE_ID is not set (target default is empty)"
  SWIFT_RUN_ID=""
else
  "${ROOT_DIR}/scripts/lib/pnpm-safe.sh" uiq run --profile swift.smoke --target swift.macos --run-id "$SWIFT_RUN_ID" --bundle-id "${SWIFT_BUNDLE_ID}"
fi

echo "[14/14] branch protection verification"
run_branch_protection_gate

echo "DONE"
echo "web_manifest=.runtime-cache/artifacts/runs/${WEB_RUN_ID}/manifest.json"
if [[ -n "${TAURI_RUN_ID:-}" ]]; then
  echo "tauri_manifest=.runtime-cache/artifacts/runs/${TAURI_RUN_ID}/manifest.json"
fi
if [[ -n "${SWIFT_RUN_ID:-}" ]]; then
  echo "swift_manifest=.runtime-cache/artifacts/runs/${SWIFT_RUN_ID}/manifest.json"
fi
