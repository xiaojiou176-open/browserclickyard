#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

tmp_parent="$(mktemp -d)"
workspace_root="$tmp_parent/workspace/repo"
authoritative_root="$workspace_root/node_modules"
runner_temp_root="$tmp_parent/runner-temp"
override_root="$runner_temp_root/uiq-node-modules"
disallowed_parent_root="$tmp_parent/workspace/node_modules"

cleanup() {
  rm -rf "$tmp_parent"
}
trap cleanup EXIT

mkdir -p "$workspace_root" "$authoritative_root" "$override_root"

default_probe="$(
  (
    unset RUNNER_TEMP
    unset UIQ_NODE_MODULES_DIR
    uiq_node_modules_contract_probe "$workspace_root"
  )
)"

python3 - "$default_probe" "$authoritative_root" <<'PY'
import json
import os
import sys

payload = json.loads(sys.argv[1])
authoritative_root = os.path.realpath(sys.argv[2])

if payload["resolutionMode"] != "workspace_default":
    raise SystemExit("expected workspace_default resolution mode")
if payload["resolvedSharedNodeRoot"] != authoritative_root:
    raise SystemExit("expected default shared node root to match authoritative workspace root")
if not payload["rootBridge"]["pointsToAuthoritativeWorkspaceRoot"]:
    raise SystemExit("expected root bridge to point to authoritative workspace root")
PY

export RUNNER_TEMP="$runner_temp_root"
UIQ_NODE_MODULES_DIR="$override_root"
rm -rf "$workspace_root/node_modules"
ln -s "$override_root" "$workspace_root/node_modules"
override_probe="$(
  UIQ_NODE_MODULES_DIR="$UIQ_NODE_MODULES_DIR" uiq_node_modules_contract_probe "$workspace_root"
)"

python3 - "$override_probe" "$override_root" <<'PY'
import json
import os
import sys

payload = json.loads(sys.argv[1])
override_root = os.path.realpath(sys.argv[2])

if payload["resolutionMode"] != "explicit":
    raise SystemExit("expected explicit resolution mode when UIQ_NODE_MODULES_DIR is set")
if payload["resolvedSharedNodeRoot"] != override_root:
    raise SystemExit("expected explicit override to become the resolved shared node root")
if not payload["rootBridge"]["pointsToResolvedSharedRoot"]:
    raise SystemExit("expected root bridge to point to explicit override root")
PY

invalid_output="$(
  set +e
  UIQ_NODE_MODULES_DIR="$disallowed_parent_root" uiq_resolve_node_modules_dir "$workspace_root" 2>&1
  rc=$?
  set -e
  printf 'RC=%s\n%s\n' "$rc" "$(
    printf '%s' ''
  )"
)"

if ! grep -Fq "RC=1" <<<"$invalid_output"; then
  echo "expected disallowed parent workspace override to fail" >&2
  echo "$invalid_output" >&2
  exit 1
fi

if ! grep -Fq "UIQ_NODE_MODULES_DIR must stay inside the repo-local node_modules root" <<<"$invalid_output"; then
  echo "expected explicit spill-path rejection message" >&2
  echo "$invalid_output" >&2
  exit 1
fi

UIQ_NODE_MODULES_DIR="$authoritative_root"
uiq_link_workspace_node_modules "$workspace_root"

authoritative_export_probe="$(
  (
    export RUNNER_TEMP="$runner_temp_root"
    unset npm_config_modules_dir
    unset npm_config_virtual_store_dir
    UIQ_NODE_MODULES_DIR="$authoritative_root"
    uiq_export_node_env "$workspace_root"
    printf '%s\n%s\n' "$npm_config_modules_dir" "$npm_config_virtual_store_dir"
  )
)"

authoritative_modules_dir="$(printf '%s\n' "$authoritative_export_probe" | sed -n '1p')"
authoritative_virtual_store_dir="$(printf '%s\n' "$authoritative_export_probe" | sed -n '2p')"

if [[ "$authoritative_modules_dir" != "node_modules" ]]; then
  echo "expected repo-local authoritative export to keep npm_config_modules_dir project-relative" >&2
  printf 'actual=%s\n' "$authoritative_modules_dir" >&2
  exit 1
fi

if [[ "$authoritative_virtual_store_dir" != "node_modules/.pnpm" ]]; then
  echo "expected repo-local authoritative export to keep npm_config_virtual_store_dir project-relative" >&2
  printf 'actual=%s\n' "$authoritative_virtual_store_dir" >&2
  exit 1
fi

override_export_probe="$(
  (
    export RUNNER_TEMP="$runner_temp_root"
    unset npm_config_modules_dir
    unset npm_config_virtual_store_dir
    UIQ_NODE_MODULES_DIR="$override_root"
    uiq_export_node_env "$workspace_root"
    printf '%s\n%s\n' "$npm_config_modules_dir" "$npm_config_virtual_store_dir"
  )
)"

override_modules_dir="$(printf '%s\n' "$override_export_probe" | sed -n '1p')"
override_virtual_store_dir="$(printf '%s\n' "$override_export_probe" | sed -n '2p')"
normalized_override_root="$(uiq_normalize_abs_path "$override_root")"
normalized_override_virtual_store_dir="$(uiq_normalize_abs_path "$override_root/.pnpm")"

if [[ "$override_modules_dir" != "$normalized_override_root" ]]; then
  echo "expected explicit runner-temp bridge export to preserve absolute npm_config_modules_dir" >&2
  printf 'actual=%s\n' "$override_modules_dir" >&2
  exit 1
fi

if [[ "$override_virtual_store_dir" != "$normalized_override_virtual_store_dir" ]]; then
  echo "expected explicit runner-temp bridge export to preserve absolute npm_config_virtual_store_dir" >&2
  printf 'actual=%s\n' "$override_virtual_store_dir" >&2
  exit 1
fi

if [[ -e "$disallowed_parent_root" || -L "$disallowed_parent_root" ]]; then
  echo "expected repo-local bridge creation to keep parent workspace node_modules absent" >&2
  exit 1
fi

if ! uiq_assert_no_parent_workspace_node_modules "$workspace_root"; then
  echo "expected parent workspace guard to accept clean repo-local topology" >&2
  exit 1
fi

if ! uiq_workspace_node_modules_topology_ready "$workspace_root" "$authoritative_root"; then
  echo "expected canonical workspace node_modules topology to be ready" >&2
  exit 1
fi

rm -f "$workspace_root/apps/command-center/node_modules"
mkdir -p "$workspace_root/apps/command-center/home/runner/work/pagestress/pagestress"
ln -s ../../../../../../node_modules \
  "$workspace_root/apps/command-center/home/runner/work/pagestress/pagestress/node_modules"

if uiq_workspace_node_modules_topology_ready "$workspace_root" "$authoritative_root"; then
  echo "expected corrupted workspace bridge topology to be rejected" >&2
  exit 1
fi

echo "node-modules contract probe checks passed"
