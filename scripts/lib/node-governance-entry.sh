#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/lib/node-governance-entry.sh <script> [args...]" >&2
  exit 2
fi

uiq_export_node_env "$ROOT_DIR"
UIQ_NODE_EXECUTABLE_RESOLVED="$(uiq_resolve_node_executable || true)"

if [[ -z "$UIQ_NODE_EXECUTABLE_RESOLVED" ]]; then
  echo "error: unable to resolve a real Node executable outside ${UIQ_NODE_MODULES_DIR}/.bin" >&2
  exit 127
fi

if ! uiq_shared_node_cache_ready_for_shortcut "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
  uiq_repair_shared_module_links "$ROOT_DIR"
fi
case "${UIQ_SKIP_WORKSPACE_NODE_LINKS:-0}" in
  1|true|TRUE|yes|YES|on|ON) ;;
  *)
    if ! uiq_workspace_node_modules_topology_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
      uiq_link_workspace_node_modules "$ROOT_DIR"
    fi
    ;;
esac
"$UIQ_NODE_EXECUTABLE_RESOLVED" "$@"
