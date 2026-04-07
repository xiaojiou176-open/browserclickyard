#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/lib/node-bin.sh <binary> [args...]" >&2
  exit 2
fi

uiq_export_node_env "$ROOT_DIR"

if ! uiq_should_skip_node_link_repair && ! uiq_workspace_node_modules_topology_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
  uiq_link_workspace_node_modules "$ROOT_DIR"
  uiq_export_node_env "$ROOT_DIR"
fi

if ! uiq_workspace_install_state_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"; then
  uiq_rematerialize_authoritative_workspace_node_modules "$ROOT_DIR" "node-bin"
  uiq_workspace_install_state_ready "$ROOT_DIR" "$UIQ_NODE_MODULES_DIR"
fi

bin_name="$1"
shift
shared_bin_path="${UIQ_NODE_MODULES_DIR}/.bin/${bin_name}"
shared_store_dir="${UIQ_NODE_MODULES_DIR}/.pnpm"

sanitize_node_options() {
  local raw="${NODE_OPTIONS:-}"
  local -a parts=()
  local -a kept=()
  local part=""
  read -r -a parts <<< "$raw"
  for part in "${parts[@]}"; do
    case "$part" in
      --preserve-symlinks|--preserve-symlinks-main) ;;
      *) kept+=("$part") ;;
    esac
  done
  if [[ "${#kept[@]}" -eq 0 ]]; then
    printf ''
    return 0
  fi
  printf '%s' "${kept[*]}"
}

exec_with_sanitized_node_options() {
  local sanitized_node_options="$1"
  shift
  if [[ -n "$sanitized_node_options" ]]; then
    exec env NODE_OPTIONS="$sanitized_node_options" "$@"
  fi
  exec env -u NODE_OPTIONS "$@"
}

exec_with_raw_node_options() {
  local raw_node_options="${NODE_OPTIONS:-}"
  if [[ -n "$raw_node_options" ]]; then
    exec env NODE_OPTIONS="$raw_node_options" "$@"
  fi
  exec env -u NODE_OPTIONS "$@"
}

resolve_shared_store_entry() {
  local relative_target="$1"
  python3 - "$shared_store_dir" "$relative_target" <<'PY'
from pathlib import Path
import re
import sys
store = Path(sys.argv[1])
target = sys.argv[2]
if not store.exists():
    raise SystemExit(1)
matches = sorted(store.glob(f"*/node_modules/{target}"))
if not matches:
    raise SystemExit(1)

def resolve_store_entry(candidate: Path) -> str:
    current = candidate
    while current.parent != current:
        if current.parent.name == ".pnpm":
            return current.name
        current = current.parent
    return candidate.parent.parent.name

def parse_version(candidate: Path) -> tuple[int, ...]:
    store_entry = resolve_store_entry(candidate)
    match = re.search(r"@(\d+(?:\.\d+){0,3})", store_entry)
    if not match:
        return (0,)
    return tuple(int(part) for part in match.group(1).split("."))

matches.sort(key=lambda candidate: (parse_version(candidate), str(candidate)))
print(matches[-1])
PY
}

resolve_shared_package_bin() {
  local target=""
  case "$bin_name" in
    eslint) target="eslint/bin/eslint.js" ;;
    vite) target="vite/bin/vite.js" ;;
    vitest) target="vitest/vitest.mjs" ;;
    playwright) target="@playwright/test/cli.js" ;;
    stryker) target="@stryker-mutator/core/bin/stryker.js" ;;
    tsx) target="tsx/dist/cli.mjs" ;;
    tsc) target="typescript/bin/tsc" ;;
    tsserver) target="typescript/bin/tsserver" ;;
    stylelint) target="stylelint/bin/stylelint.mjs" ;;
    commitlint) target="@commitlint/cli/lib/cli.js" ;;
    *) return 1 ;;
  esac
  resolve_shared_store_entry "$target"
}

sanitized_node_options="$(sanitize_node_options)"
node_executable="$(uiq_resolve_node_executable || true)"

if [[ -x "$shared_bin_path" ]]; then
  exec_with_sanitized_node_options "$sanitized_node_options" "$shared_bin_path" "$@"
fi

if shared_store_target="$(resolve_shared_package_bin 2>/dev/null)"; then
  if [[ -z "$node_executable" ]]; then
    echo "error: unable to resolve a real Node executable outside ${UIQ_NODE_MODULES_DIR}/.bin" >&2
    exit 127
  fi
  exec_with_sanitized_node_options "$sanitized_node_options" "$node_executable" "$shared_store_target" "$@"
fi

echo "error: missing Node binary '${bin_name}' at ${shared_bin_path}; repo-local node_modules bins are forbidden" >&2
exit 127
