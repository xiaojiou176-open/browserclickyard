#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/heartbeat.sh"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found"
  exit 1
fi

if ! bash scripts/lib/pnpm-safe.sh --version >/dev/null 2>&1; then
  echo "error: unable to resolve a working pnpm entrypoint"
  echo "hint: ensure corepack is available or the pinned pnpm runtime can be resolved"
  exit 1
fi

uiq_export_node_env "$ROOT_DIR"
uiq_sync_python_env
uiq_run_with_heartbeat "setup.node-deps" -- bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile
uiq_cleanup_root_node_artifacts "$ROOT_DIR"
uiq_run_with_heartbeat "setup.playwright-install" -- bash scripts/lib/node-bin.sh playwright install chromium

hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "${hooks_path}" ]]; then
  echo "warning: skipping pre-commit hook install because core.hooksPath is set to '${hooks_path}'"
  echo "hint: unset core.hooksPath or install the repo hooks into your custom hooks directory manually"
else
  uiq_run_with_heartbeat "setup.pre-commit-install" -- \
    bash scripts/lib/python-exec.sh pre-commit install --hook-type pre-commit --hook-type pre-push --hook-type commit-msg
fi

echo "setup complete"
