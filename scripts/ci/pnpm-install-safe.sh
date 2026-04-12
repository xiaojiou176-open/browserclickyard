#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/lib/node-toolchain.sh"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
uiq_export_node_env "$ROOT_DIR"

package_manager_spec() {
  node -p "require('$ROOT_DIR/package.json').packageManager || ''" 2>/dev/null || true
}

resolve_corepack_js() {
  local candidates=(
    "/usr/lib/node_modules/corepack/dist/corepack.js"
    "/usr/local/lib/node_modules/corepack/dist/corepack.js"
    "/opt/homebrew/lib/node_modules/corepack/dist/corepack.js"
  )
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_bootstrap_corepack_prefix() {
  if [[ -n "${UIQ_BOOTSTRAP_COREPACK_PREFIX:-}" ]]; then
    printf '%s\n' "$UIQ_BOOTSTRAP_COREPACK_PREFIX"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* ]]; then
    printf '%s\n' "${RUNNER_TEMP}/uiq-corepack-bootstrap"
    return 0
  fi
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/corepack-bootstrap"
}

bootstrap_corepack_binary() {
  local prefix="${1:-$(resolve_bootstrap_corepack_prefix)}"
  local version="${UIQ_BOOTSTRAP_COREPACK_VERSION:-0.34.6}"
  mkdir -p "$prefix"
  echo "[pnpm-install-safe] installing corepack@${version} into ${prefix}" >&2
  run_node_cli_env env npm_config_prefix="$prefix" npm install -g "corepack@${version}" >/dev/null
  export PATH="${prefix}/bin:${PATH}"
}

prepare_package_manager_with_corepack() {
  local package_manager="$1"
  local log_file=""
  local status=0
  log_file="$(mktemp)"

  if ! command -v corepack >/dev/null 2>&1; then
    bootstrap_corepack_binary
  fi

  if run_node_cli_env corepack prepare "$package_manager" --activate >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi
  status=$?

  if grep -Fq "Cannot find matching keyid" "$log_file"; then
    echo "[pnpm-install-safe] detected corepack keyid mismatch; bootstrapping a newer corepack release" >&2
    bootstrap_corepack_binary
    if run_node_cli_env corepack prepare "$package_manager" --activate >"$log_file" 2>&1; then
      rm -f "$log_file"
      return 0
    fi
    status=$?
  fi

  cat "$log_file" >&2 || true
  rm -f "$log_file"
  return "$status"
}

pnpm_runtime_defaults() {
  if [[ -n "${UIQ_CONTAINER_GATE_NAME:-}" ]] || [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '%s %s\n' "${UIQ_PNPM_CHILD_CONCURRENCY:-1}" "${UIQ_PNPM_NETWORK_CONCURRENCY:-2}"
    return 0
  fi
  printf '%s %s\n' "${UIQ_PNPM_CHILD_CONCURRENCY:-4}" "${UIQ_PNPM_NETWORK_CONCURRENCY:-8}"
}

run_node_cli_env() {
  env -u NODE_OPTIONS "$@"
}

should_repair_node_links() {
  case "${UIQ_SKIP_NODE_LINK_REPAIR:-0}" in
    1|true|TRUE|yes|YES|on|ON) return 1 ;;
  esac
  if [[ -n "${UIQ_CONTAINER_GATE_NAME:-}" ]]; then
    return 1
  fi
  [[ "${UIQ_NODE_MODULES_DIR:-}" != "/node_modules" ]]
}

prepare_workspace_node_links() {
  if should_repair_node_links; then
    uiq_cleanup_root_node_artifacts "$ROOT_DIR"
    mkdir -p "$UIQ_NODE_MODULES_DIR" "${UIQ_NODE_MODULES_DIR}/.pnpm"
  fi
}

reset_node_modules_root() {
  local node_root="${1:-}"
  if [[ -z "$node_root" ]]; then
    return 0
  fi

  if [[ -d "$node_root" && ! -L "$node_root" ]]; then
    find "$node_root" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    mkdir -p "$node_root" "${node_root}/.pnpm" || true
    return 0
  fi

  rm -rf "$node_root" || true
  mkdir -p "$node_root" || true
}

repair_workspace_after_install() {
  local had_skip_shared_repair=0
  local previous_skip_shared_repair=""
  if should_repair_node_links; then
    uiq_cleanup_root_node_artifacts "$ROOT_DIR"
    echo "[pnpm-install-safe] repairing shared module links" >&2
    uiq_link_workspace_node_modules "$ROOT_DIR"
    if [[ -n "${RUNNER_TEMP:-}" && "$UIQ_NODE_MODULES_DIR" == "${RUNNER_TEMP}"/* ]]; then
      if uiq_refresh_direct_shared_links "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
        echo "[pnpm-install-safe] post-install shortcut: refreshed direct dependency links inside isolated runner temp" >&2
      else
        echo "[pnpm-install-safe] isolated runner temp still needs full topology repair" >&2
        uiq_repair_shared_module_links "$ROOT_DIR"
      fi
    else
      uiq_repair_shared_module_links "$ROOT_DIR"
    fi
    echo "[pnpm-install-safe] shared module links ready" >&2
    return 0
  fi

  if [[ -n "${UIQ_CONTAINER_GATE_NAME:-}" ]]; then
    if [[ -n "${UIQ_SKIP_SHARED_MODULE_LINK_REPAIR+x}" ]]; then
      had_skip_shared_repair=1
      previous_skip_shared_repair="${UIQ_SKIP_SHARED_MODULE_LINK_REPAIR}"
    fi
    if uiq_container_gate_root_resolution_targets_ready "$UIQ_NODE_MODULES_DIR"; then
      if [[ "$had_skip_shared_repair" -eq 1 ]]; then
        export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR="$previous_skip_shared_repair"
      fi
      echo "[pnpm-install-safe] container gate shortcut: root-resolution targets already ready" >&2
      return 0
    fi
    if uiq_refresh_direct_shared_links "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
      echo "[pnpm-install-safe] container gate shortcut: refreshed direct dependency links" >&2
      if uiq_container_gate_root_resolution_targets_ready "$UIQ_NODE_MODULES_DIR"; then
        if [[ "$had_skip_shared_repair" -eq 1 ]]; then
          export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR="$previous_skip_shared_repair"
        fi
        echo "[pnpm-install-safe] container gate shortcut: root-resolution targets ready" >&2
        return 0
      fi
      echo "[pnpm-install-safe] container gate shortcut: critical root-resolution targets still missing; continuing into full topology repair" >&2
    else
      echo "[pnpm-install-safe] container gate direct dependency refresh incomplete; continuing into full topology repair" >&2
    fi
    unset UIQ_SKIP_SHARED_MODULE_LINK_REPAIR
    uiq_repair_shared_module_links "$ROOT_DIR"
    if [[ "$had_skip_shared_repair" -eq 1 ]]; then
      export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR="$previous_skip_shared_repair"
    fi
    echo "[pnpm-install-safe] container gate shared module links ready" >&2
    return 0
  fi
}

ensure_pnpm_entrypoint() {
  local pnpm_cjs=""
  if pnpm_cjs="$(resolve_pnpm_cjs)"; then
    run_node_cli_env node "$pnpm_cjs" --version >/dev/null
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1 && run_node_cli_env pnpm --version >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    return 1
  fi
  local package_manager=""
  package_manager="$(package_manager_spec)"
  if [[ -z "$package_manager" ]]; then
    return 1
  fi
  prepare_package_manager_with_corepack "$package_manager"
  if pnpm_cjs="$(resolve_pnpm_cjs)"; then
    run_node_cli_env node "$pnpm_cjs" --version >/dev/null
    return 0
  fi
  run_node_cli_env pnpm --version >/dev/null
}

retry_install_after_reset() {
  local reason="$1"
  local preserve_store="${2:-0}"
  shift 2 || true
  local corepack_home="${COREPACK_HOME:-$(uiq_resolve_corepack_home)}"
  local pnpm_store_dir="${UIQ_PNPM_STORE_DIR:-$(uiq_resolve_pnpm_store_dir)}"
  local retry_package_import_method="${UIQ_PNPM_RETRY_PACKAGE_IMPORT_METHOD:-copy}"
  echo "[pnpm-install-safe] ${reason}; resetting shared node/corepack roots and retrying once" >&2
  reset_node_modules_root "$UIQ_NODE_MODULES_DIR"
  rm -rf "$corepack_home" || true
  if [[ "$preserve_store" != "1" ]]; then
    rm -rf "$pnpm_store_dir" || true
  fi
  export COREPACK_HOME="$corepack_home"
  export UIQ_PNPM_STORE_DIR="$pnpm_store_dir"
  mkdir -p "$COREPACK_HOME" "$UIQ_PNPM_STORE_DIR" || true
  local previous_child_concurrency="${UIQ_PNPM_CHILD_CONCURRENCY-}"
  local previous_network_concurrency="${UIQ_PNPM_NETWORK_CONCURRENCY-}"
  local previous_package_import_method="${npm_config_package_import_method-}"
  export UIQ_PNPM_CHILD_CONCURRENCY="${UIQ_PNPM_RETRY_CHILD_CONCURRENCY:-1}"
  export UIQ_PNPM_NETWORK_CONCURRENCY="${UIQ_PNPM_RETRY_NETWORK_CONCURRENCY:-1}"
  export npm_config_package_import_method="$retry_package_import_method"
  echo "[pnpm-install-safe] retry uses package-import-method=$retry_package_import_method" >&2
  ensure_pnpm_entrypoint
  run_pnpm install "$@"
  repair_workspace_after_install
  if [[ -n "${previous_child_concurrency}" ]]; then
    export UIQ_PNPM_CHILD_CONCURRENCY="$previous_child_concurrency"
  else
    unset UIQ_PNPM_CHILD_CONCURRENCY
  fi
  if [[ -n "${previous_network_concurrency}" ]]; then
    export UIQ_PNPM_NETWORK_CONCURRENCY="$previous_network_concurrency"
  else
    unset UIQ_PNPM_NETWORK_CONCURRENCY
  fi
  if [[ -n "${previous_package_import_method}" ]]; then
    export npm_config_package_import_method="$previous_package_import_method"
  else
    unset npm_config_package_import_method
  fi
  exit 0
}

resolve_pnpm_cjs() {
  local package_manager=""
  package_manager="$(package_manager_spec)"
  local version="${package_manager#pnpm@}"
  version="${version%%+*}"
  local corepack_root="${COREPACK_HOME:-$HOME/.cache/node/corepack}"
  if [[ -n "$version" && "$version" != "$package_manager" ]]; then
    local candidate="$corepack_root/v1/pnpm/$version/dist/pnpm.cjs"
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

run_pnpm() {
  local child_concurrency=""
  local network_concurrency=""
  read -r child_concurrency network_concurrency < <(pnpm_runtime_defaults)
  local pnpm_cjs=""
  if pnpm_cjs="$(resolve_pnpm_cjs)"; then
    run_node_cli_env \
      npm_config_child_concurrency="$child_concurrency" \
      npm_config_network_concurrency="$network_concurrency" \
      node "$pnpm_cjs" "$@" || return $?
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1 && run_node_cli_env pnpm --version >/dev/null 2>&1; then
    run_node_cli_env \
      npm_config_child_concurrency="$child_concurrency" \
      npm_config_network_concurrency="$network_concurrency" \
      pnpm "$@" || return $?
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    if run_node_cli_env corepack pnpm --version >/dev/null 2>&1; then
      run_node_cli_env \
        npm_config_child_concurrency="$child_concurrency" \
        npm_config_network_concurrency="$network_concurrency" \
        corepack pnpm "$@" || return $?
      return 0
    fi
  fi
  echo "::error::pnpm is unavailable and corepack fallback is not present" >&2
  return 127
}

log_file="$(mktemp)"
install_succeeded=0
cleanup_install_attempt() {
  rm -f "$log_file"
  if [[ "${install_succeeded:-0}" -eq 1 ]]; then
    return 0
  fi
  # Failed installs must not leave workspace bridges pointing at dead temp roots.
  if should_repair_node_links; then
    uiq_cleanup_root_node_artifacts "$ROOT_DIR"
  fi
}
trap cleanup_install_attempt EXIT

echo "[pnpm-install-safe] first attempt: pnpm install $*" >&2
prepare_workspace_node_links
ensure_pnpm_entrypoint
if run_pnpm install "$@" 2>&1 | tee "$log_file"; then
  repair_workspace_after_install
  install_succeeded=1
  exit 0
fi
first_status=${PIPESTATUS[0]}

if ! grep -Eiq "ERR_PNPM_ENOENT|ENOENT: no such file or directory, copyfile|ENOENT: no such file or directory, mkdir '.*/node_modules'|ENOENT: no such file or directory, open '.*/node_modules/\\.pnpm/.*/package\\.json'" "$log_file"; then
  if grep -Eiq "ERR_PNPM_ENOSPC|ENOSPC: no space left on device" "$log_file"; then
    echo "[pnpm-install-safe] detected ENOSPC, resetting repo-scoped install roots and retrying once" >&2
    df -h || true
    retry_install_after_reset "detected ENOSPC" 0 "$@"
  fi
  if grep -Eiq "ERR_PNPM_ENOTEMPTY|ENOTEMPTY: directory not empty|ERR_PNPM_EIO|EIO: i/o error|Unknown system error -74|Bad message" "$log_file"; then
    retry_install_after_reset "detected transient store/workdir corruption" 0 "$@"
  fi
  if [[ "$first_status" -eq 137 || "$first_status" -eq 143 ]] || grep -Eiq "Killed[[:space:]]+node|Killed[[:space:]]+pnpm" "$log_file"; then
    retry_install_after_reset "detected killed pnpm install" 1 "$@"
  fi
  echo "[pnpm-install-safe] non-recoverable install error, not retrying" >&2
  exit "$first_status"
fi

retry_install_after_reset "detected pnpm store integrity issue" 0 "$@"
