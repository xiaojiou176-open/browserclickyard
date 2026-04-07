#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

parent_node_modules="$(uiq_resolve_parent_workspace_node_modules_root "$ROOT_DIR")"

if ! uiq_assert_no_parent_workspace_node_modules "$ROOT_DIR"; then
  echo "[no-parent-workspace-node-modules] legacy parent root still present" >&2
  if [[ -d "$parent_node_modules" || -L "$parent_node_modules" ]]; then
    find "$parent_node_modules" -maxdepth 2 \
      \( -name '.pnpm' -o -name '.repair-stamp' -o -name '.governance-entry-users' \) \
      -print 2>/dev/null || true
  fi
  exit 1
fi

echo "[no-parent-workspace-node-modules] PASS"
