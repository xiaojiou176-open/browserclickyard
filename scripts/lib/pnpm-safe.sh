#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

prepare_workspace_bridge_for_pnpm() {
  # shellcheck source=/dev/null
  source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
  uiq_export_node_env "$ROOT_DIR"
  if uiq_should_skip_node_link_repair; then
    return 0
  fi
  if ! uiq_workspace_node_modules_topology_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
    uiq_link_workspace_node_modules "$ROOT_DIR"
    uiq_export_node_env "$ROOT_DIR"
  fi
  if uiq_workspace_install_state_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
    return 0
  fi
  uiq_rematerialize_authoritative_workspace_node_modules "$ROOT_DIR" "pnpm-safe"
  uiq_workspace_install_state_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"
}

resolve_corepack_root() {
  if [[ -n "${COREPACK_HOME:-}" ]]; then
    printf '%s\n' "$COREPACK_HOME"
    return 0
  fi
  printf '%s\n' "$HOME/.cache/node/corepack"
}

resolve_pnpm_cjs() {
  local package_manager=""
  package_manager="$(node -p "require('$ROOT_DIR/package.json').packageManager || ''" 2>/dev/null || true)"
  local version="${package_manager#pnpm@}"
  version="${version%%+*}"
  local candidates=()
  if [[ -n "$version" && "$version" != "$package_manager" ]]; then
    candidates+=("$(resolve_corepack_root)/v1/pnpm/$version/dist/pnpm.cjs")
  fi
  candidates+=(
    "/usr/local/lib/node_modules/corepack/dist/pnpm.js"
    "/usr/lib/node_modules/corepack/dist/pnpm.js"
    "/opt/homebrew/lib/node_modules/corepack/dist/pnpm.js"
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

if pnpm_cjs="$(resolve_pnpm_cjs)"; then
  prepare_workspace_bridge_for_pnpm
  exec node "$pnpm_cjs" "$@"
fi

if command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
  prepare_workspace_bridge_for_pnpm
  exec corepack pnpm "$@"
fi

if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  prepare_workspace_bridge_for_pnpm
  exec pnpm "$@"
fi

echo "::error::unable to resolve a working pnpm entrypoint" >&2
exit 127
