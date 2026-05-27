#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

REPORT_DIR="$ROOT_DIR/.runtime-cache/reports/mutation/py"
WORKSPACE_DIR="$ROOT_DIR/.runtime-cache/temp/mutation-workspaces/py"
LOG_PATH="$REPORT_DIR/mutmut-run.log"
META_PATH="$REPORT_DIR/run-meta.json"
RESULTS_PATH="$REPORT_DIR/mutmut-results.txt"
LEGACY_MUTMUT_STATS_PATH="$ROOT_DIR/mutants/mutmut-stats.json"
RUNTIME_MUTMUT_STATS_PATH="$REPORT_DIR/mutmut-stats.json"
RUNTIME_MUTMUT_CACHE_PATH="$WORKSPACE_DIR/.mutmut-cache"
RUNTIME_MUTANTS_PATH="$WORKSPACE_DIR/mutants"
MUTMUT_CMD="bash scripts/lib/python-exec.sh mutmut run"

mkdir -p "$REPORT_DIR"
mkdir -p "$WORKSPACE_DIR"

WORKSPACE_NODE_LINKS=(
  "$ROOT_DIR/node_modules"
  "$ROOT_DIR/apps/command-center/node_modules"
  "$ROOT_DIR/tooling/automation/node_modules"
  "$ROOT_DIR/tests/web-harness/node_modules"
  "$ROOT_DIR/services/mcp-server/node_modules"
  "$ROOT_DIR/tests/node_modules"
  "$ROOT_DIR/tests/frontend-e2e/node_modules"
)

restore_workspace_node_links() {
  uiq_export_node_env "$ROOT_DIR"
  uiq_link_workspace_node_modules "$ROOT_DIR"
}

# Keep py mutation deterministic across CI jobs by resetting mutmut runtime state.
for path in .mutmut-cache mutants; do
  if [[ -e "$path" ]]; then
    node - "$path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
fs.rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
NODE
  fi
done

for link_path in "${WORKSPACE_NODE_LINKS[@]}"; do
  if [[ -L "$link_path" ]]; then
    rm -f "$link_path"
  fi
done

started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

set +e
bash scripts/lib/python-exec.sh mutmut run 2>&1 | tee "$LOG_PATH"
cmd_rc=${PIPESTATUS[0]}
set -e

finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
if [[ -f "$LEGACY_MUTMUT_STATS_PATH" ]]; then
  cp "$LEGACY_MUTMUT_STATS_PATH" "$RUNTIME_MUTMUT_STATS_PATH"
  mutmut_stats_present=true
else
  mutmut_stats_present=false
fi

rm -rf "$RUNTIME_MUTMUT_CACHE_PATH" "$RUNTIME_MUTANTS_PATH"
if [[ -e "$ROOT_DIR/.mutmut-cache" ]]; then
  mv "$ROOT_DIR/.mutmut-cache" "$RUNTIME_MUTMUT_CACHE_PATH"
fi
if [[ -e "$ROOT_DIR/mutants" ]]; then
  mv "$ROOT_DIR/mutants" "$RUNTIME_MUTANTS_PATH"
fi

set +e
bash scripts/lib/python-exec.sh mutmut results --all true >"$RESULTS_PATH" 2>&1
results_rc=$?
set -e

if [[ $cmd_rc -eq 0 ]]; then
  run_status="succeeded"
else
  run_status="failed"
fi

cat > "$META_PATH" <<EOF_META
{
  "status": "$run_status",
  "command": "$MUTMUT_CMD",
  "startedAt": "$started_at",
  "finishedAt": "$finished_at",
  "exitCode": $cmd_rc,
  "logPath": "$LOG_PATH",
  "resultsPath": "$RESULTS_PATH",
  "resultsExitCode": $results_rc,
  "mutmutStatsPath": "$RUNTIME_MUTMUT_STATS_PATH",
  "mutmutStatsPresent": $mutmut_stats_present,
  "runtimeWorkspaceDir": "$WORKSPACE_DIR",
  "runtimeWorkspacePaths": [
    "$RUNTIME_MUTMUT_CACHE_PATH",
    "$RUNTIME_MUTANTS_PATH"
  ],
  "legacyRuntimePaths": [
    ".mutmut-cache",
    "mutants"
  ],
  "nextActions": [
    "Inspect the mutmut execution log at $LOG_PATH",
    "Re-run 'pnpm mutation:py:strict' after fixing failing Python tests or mutmut configuration",
    "Run 'pnpm mutation:summary' to refresh consolidated mutation status"
  ]
}
EOF_META

restore_workspace_node_links

exit $cmd_rc
