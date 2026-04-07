#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/uiq-runtime-cache.XXXXXX")"
REPORT_PATH="${UIQ_REPRO_WITHOUT_CACHE_REPORT_PATH:-$ROOT_DIR/.runtime-cache/artifacts/ci/repro-without-cache.json}"
LOCK_PATH="${UIQ_REPRO_WITHOUT_CACHE_LOCK_PATH:-$ROOT_DIR/.runtime-cache/artifacts/ci/repro-without-cache.lock}"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
STATUS="running"
CURRENT_STAGE="startup"
export REPORT_PATH LOCK_PATH STARTED_AT STATUS TEMP_ROOT CURRENT_STAGE

mkdir -p "$(dirname "$REPORT_PATH")"
LOCK_DIR="${LOCK_PATH}.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[check-mainline-repro-without-cache] another instance is already running; refusing concurrent run" >&2
  STATUS="blocked"
  export STATUS
  python3 - <<'PY'
import json
import os
from pathlib import Path

payload = {
    "generated_at": os.environ["STARTED_AT"],
    "status": os.environ["STATUS"],
    "report_path": os.environ["REPORT_PATH"],
    "lock_path": os.environ["LOCK_PATH"],
    "temp_root": os.environ["TEMP_ROOT"],
    "runtime_root": "",
    "python_env_root": "",
    "node_modules_root": "",
    "command": "",
    "reason": "concurrent_instance_detected",
}
Path(os.environ["REPORT_PATH"]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  rm -rf "$TEMP_ROOT"
  exit 3
fi

write_report() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

payload = {
    "generated_at": os.environ["STARTED_AT"],
    "status": os.environ["STATUS"],
    "report_path": os.environ["REPORT_PATH"],
    "lock_path": os.environ["LOCK_PATH"],
    "temp_root": os.environ["TEMP_ROOT"],
    "runtime_root": os.environ.get("UIQ_RUNTIME_CACHE_ROOT", ""),
    "python_env_root": os.environ.get("UIQ_PYTHON_ENV_ROOT", ""),
    "node_modules_root": os.environ.get("UIQ_NODE_MODULES_DIR", ""),
    "command": os.environ.get("COMMAND", ""),
    "stage": os.environ.get("CURRENT_STAGE", ""),
}
Path(os.environ["REPORT_PATH"]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

cleanup() {
  write_report
  rm -rf "$LOCK_DIR"
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"
export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1
uiq_repair_shared_module_links "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

export UIQ_RUNTIME_CACHE_ROOT="$TEMP_ROOT/runtime"
export UIQ_MCP_RUNTIME_CACHE_ROOT="$TEMP_ROOT/runtime"
export UIQ_PYTHON_ENV_ROOT="$TEMP_ROOT/python-env"
export UV_PROJECT_ENVIRONMENT="$UIQ_PYTHON_ENV_ROOT"
export UIQ_PNPM_STORE_DIR="$TEMP_ROOT/pnpm-store"
export PNPM_STORE_PATH="$UIQ_PNPM_STORE_DIR"
export npm_config_store_dir="$UIQ_PNPM_STORE_DIR"
export UIQ_NODE_MODULES_DIR="$TEMP_ROOT/node-modules"
export npm_config_modules_dir="$UIQ_NODE_MODULES_DIR"
export npm_config_virtual_store_dir="${UIQ_NODE_MODULES_DIR}/.pnpm"
export PATH="${UIQ_NODE_MODULES_DIR}/.bin:${PATH}"
export UIQ_RUNTIME_CACHE_ROOT UIQ_MCP_RUNTIME_CACHE_ROOT UIQ_PYTHON_ENV_ROOT UIQ_PNPM_STORE_DIR UIQ_NODE_MODULES_DIR

COMMAND="${UIQ_REPRO_WITHOUT_CACHE_COMMAND:-}"
export COMMAND
write_report
echo "[check-mainline-repro-without-cache] runtime root: $UIQ_RUNTIME_CACHE_ROOT"
if [[ -n "$COMMAND" ]]; then
  echo "[check-mainline-repro-without-cache] command: $COMMAND"
  CURRENT_STAGE="custom-command"
  export CURRENT_STAGE
  write_report
  if bash -lc "$COMMAND"; then
    STATUS="passed"
    CURRENT_STAGE="completed"
    export STATUS CURRENT_STAGE
    exit 0
  fi
  run_rc=$?
else
  run_stage() {
    local stage_name="$1"
    shift
    CURRENT_STAGE="$stage_name"
    export CURRENT_STAGE
    write_report
    echo "[check-mainline-repro-without-cache][stage] $stage_name"
    "$@"
  }

  if run_stage "pnpm-install-safe" bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile \
    && run_stage "docs-gate" bash scripts/docs-gate.sh \
    && run_stage "root-allowlist" bash scripts/lib/node-governance-entry.sh scripts/ci/check-root-allowlist.mjs \
    && run_stage "cache-governance" bash scripts/lib/node-governance-entry.sh scripts/ci/check-cache-governance.mjs \
    && run_stage "worktree-hygiene" bash scripts/check-worktree-hygiene.sh \
    && run_stage "typecheck" bash scripts/lib/pnpm-safe.sh typecheck \
    && run_stage "pytest-settings" bash scripts/lib/python-exec.sh pytest -q -o addopts='' tests/test_settings.py \
    && run_stage "verify-run-evidence-tests" node --test scripts/ci/verify-run-evidence.test.mjs; then
    STATUS="passed"
    CURRENT_STAGE="completed"
    export STATUS CURRENT_STAGE
    exit 0
  fi
  run_rc=$?
fi
STATUS="failed"
export STATUS CURRENT_STAGE
exit "${run_rc:-1}"
