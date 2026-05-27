#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

tmp_dir="$(mktemp -d)"
workspace_root="$tmp_dir/workspace/repo"
node_root="$workspace_root/node_modules"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$node_root/.pnpm/node_modules"

export UIQ_NODE_MODULES_DIR="$node_root"
uiq_export_node_env "$workspace_root"

if [[ "$npm_config_modules_dir" != "node_modules" ]]; then
  echo "expected authoritative workspace node root to export canonical npm_config_modules_dir" >&2
  printf 'actual=%s\n' "$npm_config_modules_dir" >&2
  exit 1
fi

if [[ "$npm_config_virtual_store_dir" != "node_modules/.pnpm" ]]; then
  echo "expected authoritative workspace node root to export canonical npm_config_virtual_store_dir" >&2
  printf 'actual=%s\n' "$npm_config_virtual_store_dir" >&2
  exit 1
fi

set +e
missing_marker_output="$(
  UIQ_NODE_MODULES_DIR="$node_root" uiq_workspace_install_state_ready "$workspace_root" 2>&1
)"
missing_marker_status=$?
set -e

if [[ "$missing_marker_status" -eq 0 ]]; then
  echo "expected empty node_modules store to fail install-state guard" >&2
  exit 1
fi

if ! grep -Eq "missing-workspace-state|empty-pnpm-store" <<<"$missing_marker_output"; then
  echo "expected missing install marker reason in guard output" >&2
  echo "$missing_marker_output" >&2
  exit 1
fi

cat >"$workspace_root/package.json" <<'JSON'
{
  "name": "uiq-install-state-guard-fixture",
  "private": true,
  "dependencies": {},
  "devDependencies": {}
}
JSON

cat >"$node_root/.pnpm-workspace-state-v1.json" <<'JSON'
{
  "projects": {
    "/workspace": {
      "name": "browserclickyard",
      "version": "0.1.0"
    }
  }
}
JSON

set +e
failure_output="$(
  UIQ_NODE_MODULES_DIR="$node_root" uiq_workspace_install_state_ready "$workspace_root" 2>&1
)"
failure_status=$?
set -e

if [[ "$failure_status" -eq 0 ]]; then
  echo "expected workspace-state mismatch to fail install-state guard" >&2
  exit 1
fi

if ! grep -Fq "workspace-state-root-mismatch" <<<"$failure_output"; then
  echo "expected workspace-state mismatch reason in guard output" >&2
  echo "$failure_output" >&2
  exit 1
fi

cat >"$node_root/.pnpm-workspace-state-v1.json" <<JSON
{
  "projects": {
    "${workspace_root}": {
      "name": "browserclickyard",
      "version": "0.1.0"
    }
  }
}
JSON

UIQ_NODE_MODULES_DIR="$node_root" uiq_workspace_install_state_ready "$workspace_root"

cat >"$workspace_root/package.json" <<'JSON'
{
  "name": "uiq-install-state-guard-fixture",
  "private": true,
  "dependencies": {
    "vitest": "^3.2.4"
  },
  "devDependencies": {}
}
JSON

set +e
missing_dep_output="$(
  UIQ_NODE_MODULES_DIR="$node_root" uiq_workspace_install_state_ready "$workspace_root" 2>&1
)"
missing_dep_status=$?
set -e

if [[ "$missing_dep_status" -eq 0 ]]; then
  echo "expected missing direct dependency links to fail install-state guard" >&2
  exit 1
fi

if ! grep -Fq "missing-direct-dependency-links" <<<"$missing_dep_output"; then
  echo "expected missing direct dependency reason in guard output" >&2
  echo "$missing_dep_output" >&2
  exit 1
fi

mkdir -p "$node_root/vitest"
cat >"$node_root/vitest/package.json" <<'JSON'
{
  "name": "vitest",
  "version": "3.2.4"
}
JSON

UIQ_NODE_MODULES_DIR="$node_root" uiq_workspace_install_state_ready "$workspace_root"

echo "node install-state guard checks passed"
