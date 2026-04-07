#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"

cleanup_node_artifacts() {
  uiq_cleanup_root_node_artifacts "$ROOT_DIR"
}

trap cleanup_node_artifacts EXIT
if uiq_dir_has_entries "${UIQ_NODE_MODULES_DIR}/.pnpm"; then
  uiq_refresh_direct_shared_links "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR" || true
fi
uiq_link_workspace_node_modules "$ROOT_DIR"
# Nested governance-entry invocations should reuse the shared-link topology
# prepared above instead of re-entering the same repair lock.
export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1
export UIQ_SKIP_WORKSPACE_NODE_LINKS=1

ensure_docs_gate_node_deps() {
  local node_exec=""
  node_exec="$(uiq_resolve_node_executable || true)"
  if [[ -z "$node_exec" ]]; then
    echo "error: unable to resolve a real Node executable outside ${UIQ_NODE_MODULES_DIR}/.bin" >&2
    return 127
  fi

  if env UIQ_NODE_MODULES_DIR="$UIQ_NODE_MODULES_DIR" "$node_exec" --input-type=module \
    -e 'await import("./scripts/lib/yaml-loader.mjs")' >/dev/null 2>&1; then
    return 0
  fi

  echo "[docs-gate] bootstrapping shared node deps for governance checks"
  bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile
  if uiq_dir_has_entries "${UIQ_NODE_MODULES_DIR}/.pnpm"; then
    uiq_refresh_direct_shared_links "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR" || true
  fi
  uiq_link_workspace_node_modules "$ROOT_DIR"
  if env UIQ_NODE_MODULES_DIR="$UIQ_NODE_MODULES_DIR" "$node_exec" --input-type=module \
    -e 'await import("./scripts/lib/yaml-loader.mjs")' >/dev/null 2>&1; then
    return 0
  fi

  echo "error: docs-gate YAML runtime is still unavailable after bootstrap" >&2
  return 127
}

REQUIRED_FILES=(
  "AGENTS.md"
  "CLAUDE.md"
  "CONTRIBUTING.md"
  "SECURITY.md"
  "CHANGELOG.md"
  "LICENSE"
  "CITATION.cff"
  ".github/CODEOWNERS"
  ".github/dependabot.yml"
  ".github/ISSUE_TEMPLATE/config.yml"
  ".github/pull_request_template.md"
  "docs/architecture.md"
  "docs/index.md"
  "docs/ai/agent-guide.md"
  "docs/mcp.md"
  "docs/quality-gates.md"
  "docs/how-to/mcp-clients-setup.md"
  "docs/how-to/mcp-quickstart-1pager.md"
  "docs/reference/dependency-governance.md"
  "docs/reference/ci-governance.md"
  "docs/reference/cache-governance.md"
  "docs/reference/configuration.md"
  "docs/reference/logging-and-cache-policy.md"
  "docs/reference/public-artifact-policy.md"
  "docs/reference/public-readiness.md"
  "docs/reference/runtime-paths.md"
  "docs/reference/runtime-storage-policy.md"
  "docs/reference/universal-api.md"
  "configs/drivers/capabilities.registry.json"
  "configs/governance/dependency-boundaries.yaml"
  "scripts/ci/check-no-conflict-markers.sh"
  "scripts/ci/check-driver-capability-registry-sync.mjs"
  "scripts/ci/check-doc-governance-consistency.mjs"
  "scripts/ci/check-docs-ssot.mjs"
  "scripts/ci/check-diff-doc-linkage.mjs"
  "scripts/ci/check-root-allowlist.mjs"
  "scripts/ci/check-cache-governance.mjs"
  "scripts/ci/check-runtime-cache-contract.mjs"
  "scripts/ci/check-config-governance-convergence.mjs"
  "scripts/ci/check-hard-cutover-legacy-paths.mjs"
  "scripts/ci/check-python-baseline.mjs"
  "scripts/ci/check-no-nested-runtime-cache.mjs"
  "scripts/ci/check-workspace-runtime-pollution.mjs"
  "scripts/ci/check-public-artifact-policy.mjs"
  "scripts/ci/check-sensitive-surface-leaks.mjs"
  "scripts/ci/check-dependency-boundaries.mjs"
  "scripts/ci/check-workflow-topology-sync.mjs"
  "scripts/ci/render-ci-governance-doc.mjs"
  "scripts/ci/render-public-artifact-policy-doc.mjs"
  "scripts/ci/render-public-readiness-doc.mjs"
  "scripts/ci/check-system2-gates-6-8.mjs"
  "configs/governance/ci-governance.yaml"
  "configs/governance/root-allowlist.yaml"
  "configs/governance/cache-governance.yaml"
  "configs/governance/logging-governance.yaml"
  "configs/governance/public-artifact-policy.yaml"
  "configs/governance/public-readiness.yaml"
  "configs/governance/runtime-paths.yaml"
  "configs/governance/resolution-overrides.yaml"
  "configs/governance/upstream-inventory.yaml"
  "configs/governance/host-managed-upstream-exceptions.yaml"
)

REQUIRED_DIRS=(
  "docs"
  "docs/ai"
  "docs/how-to"
  "docs/reference"
)

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
LOG_DIR="$ROOT_DIR/.runtime-cache/docs-gate/$RUN_ID"
mkdir -p "$LOG_DIR"

CHECK_NAMES=()
CHECK_CMDS=()
CHECK_LOGS=()
CHECK_PIDS=()
FAILED_INDEXES=()
FAIL_COUNT=0

add_check() {
  local name="$1"
  local cmd="$2"
  CHECK_NAMES+=("$name")
  CHECK_CMDS+=("$cmd")
  CHECK_LOGS+=("$LOG_DIR/$name.log")
}

start_checks() {
  local i
  for i in "${!CHECK_NAMES[@]}"; do
    local name="${CHECK_NAMES[$i]}"
    local cmd="${CHECK_CMDS[$i]}"
    local log_file="${CHECK_LOGS[$i]}"
    echo "[docs-gate] START $name -> $log_file"
    (
      set +e
      bash -lc "$cmd"
    ) >"$log_file" 2>&1 &
    CHECK_PIDS+=("$!")
  done
}

wait_checks() {
  local i
  local has_failure=0

  for i in "${!CHECK_NAMES[@]}"; do
    local name="${CHECK_NAMES[$i]}"
    local pid="${CHECK_PIDS[$i]}"
    local log_file="${CHECK_LOGS[$i]}"
    local exit_code=0

    if wait "$pid"; then
      exit_code=0
    else
      exit_code=$?
    fi

    if [[ "$exit_code" -eq 0 ]]; then
      echo "[docs-gate] PASS  $name"
    else
      echo "[docs-gate] FAIL  $name (exit=$exit_code, log=$log_file)"
      FAILED_INDEXES+=("$i")
      FAIL_COUNT=$((FAIL_COUNT + 1))
      has_failure=1
    fi
  done

  return "$has_failure"
}

print_failure_summary() {
  local idx
  echo "[docs-gate] ===== FAILURE SUMMARY ====="
  for idx in "${FAILED_INDEXES[@]}"; do
    local name="${CHECK_NAMES[$idx]}"
    local cmd="${CHECK_CMDS[$idx]}"
    local log_file="${CHECK_LOGS[$idx]}"
    echo "[docs-gate] check=$name"
    echo "[docs-gate] cmd=$cmd"
    echo "[docs-gate] log=$log_file"
    echo "[docs-gate] ---- tail($name) ----"
    if [[ -s "$log_file" ]]; then
      tail -n 40 "$log_file" || true
    else
      echo "[docs-gate] (no stderr/stdout captured from $name; check command wiring and exit path)"
    fi
    echo "[docs-gate] ----------------------"
  done
}

verify_required_layout() {
  local missing=0
  local dir
  local file

  for dir in "${REQUIRED_DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
      echo "[docs-gate] missing required directory: $dir"
      missing=1
    fi
  done

  for file in "${REQUIRED_FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
      echo "[docs-gate] missing required file: $file"
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    return 1
  fi

  return 0
}

if ! verify_required_layout; then
  echo "[docs-gate] FAIL (required docs layout check failed)"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[docs-gate] node is required for docs SSOT checks"
  exit 1
fi

ensure_docs_gate_node_deps

add_check "doc-governance-consistency" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-doc-governance-consistency.mjs"
add_check "no-conflict-markers" "bash scripts/ci/check-no-conflict-markers.sh"
add_check "driver-capability-registry-sync" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-driver-capability-registry-sync.mjs"
add_check "docs-ssot" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-docs-ssot.mjs"
add_check "diff-doc-linkage" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-diff-doc-linkage.mjs"
add_check "workflow-topology-sync" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-workflow-topology-sync.mjs"
add_check "ci-governance-render" "bash scripts/lib/node-governance-entry.sh scripts/ci/render-ci-governance-doc.mjs --check"
add_check "cache-governance-render" "bash scripts/lib/node-governance-entry.sh scripts/ci/render-governance-docs.mjs --check --only docs/reference/cache-governance.md"
add_check "public-artifact-policy-render" "bash scripts/lib/node-governance-entry.sh scripts/ci/render-public-artifact-policy-doc.mjs --check"
add_check "public-readiness-render" "bash scripts/lib/node-governance-entry.sh scripts/ci/render-public-readiness-doc.mjs --check"
add_check "runtime-paths-render" "bash scripts/lib/node-governance-entry.sh scripts/ci/render-governance-docs.mjs --check --only docs/reference/runtime-paths.md"
add_check "root-allowlist" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-root-allowlist.mjs"
add_check "cache-governance" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-cache-governance.mjs"
add_check "runtime-cache-contract" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-runtime-cache-contract.mjs"
add_check "config-governance-convergence" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-config-governance-convergence.mjs"
add_check "hard-cutover-legacy-paths" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-hard-cutover-legacy-paths.mjs"
add_check "python-baseline" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-python-baseline.mjs"
add_check "no-nested-runtime-cache" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-no-nested-runtime-cache.mjs"
add_check "workspace-runtime-pollution" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-workspace-runtime-pollution.mjs"
add_check "public-artifact-policy" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-public-artifact-policy.mjs"
add_check "sensitive-surface-gate" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-sensitive-surface-leaks.mjs"
add_check "dependency-boundaries" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-dependency-boundaries.mjs"
add_check "system2-gates-6-8" "bash scripts/lib/node-governance-entry.sh scripts/ci/check-system2-gates-6-8.mjs"

echo "[docs-gate] running ${#CHECK_NAMES[@]} checks in parallel"
start_checks

if wait_checks; then
  echo "[docs-gate] PASS (logs: $LOG_DIR)"
  exit 0
fi

print_failure_summary
echo "[docs-gate] FAIL ($FAIL_COUNT/${#CHECK_NAMES[@]} checks failed, logs: $LOG_DIR)"
exit 1
