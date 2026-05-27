#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"

cleanup_node_artifacts() {
  uiq_cleanup_root_node_artifacts "$ROOT_DIR"
}

snapshot() {
  ls -1A | grep -vx 'node_modules' | sort
}

BEFORE="$(mktemp)"
AFTER="$(mktemp)"
trap 'cleanup_node_artifacts; rm -f "$BEFORE" "$AFTER"' EXIT

uiq_repair_shared_module_links "$ROOT_DIR"
if ! uiq_workspace_node_modules_topology_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
  uiq_link_workspace_node_modules "$ROOT_DIR"
fi

snapshot >"$BEFORE"

COMMANDS="${UIQ_ROOT_SMOKE_COMMANDS:-UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 UIQ_SKIP_WORKSPACE_NODE_LINKS=1 bash scripts/lib/node-governance-entry.sh scripts/ci/check-root-allowlist.mjs && UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 UIQ_SKIP_WORKSPACE_NODE_LINKS=1 bash scripts/lib/node-governance-entry.sh scripts/ci/check-cache-governance.mjs && UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 UIQ_SKIP_WORKSPACE_NODE_LINKS=1 bash scripts/lib/node-governance-entry.sh scripts/ci/check-no-nested-runtime-cache.mjs && UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 UIQ_SKIP_WORKSPACE_NODE_LINKS=1 bash scripts/lib/node-governance-entry.sh scripts/ci/check-workspace-runtime-pollution.mjs && UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 UIQ_SKIP_WORKSPACE_NODE_LINKS=1 bash scripts/lib/node-governance-entry.sh scripts/ci/check-config-governance-convergence.mjs}"
echo "[smoke-root-cleanliness] running: $COMMANDS"
bash -lc "$COMMANDS"

# Nested governance helpers may materialize repo-root node tooling while they
# run; compare the post-command root after the same cleanup boundary is applied.
cleanup_node_artifacts
snapshot >"$AFTER"

NEW_ENTRIES="$(comm -13 "$BEFORE" "$AFTER" || true)"
if [[ -n "$NEW_ENTRIES" ]]; then
  echo "[smoke-root-cleanliness] FAIL: new root entries materialized" >&2
  echo "$NEW_ENTRIES" >&2
  exit 1
fi

echo "[smoke-root-cleanliness] PASS"
