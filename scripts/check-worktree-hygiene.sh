#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"

run_gate() {
  local label="$1"
  shift
  echo "[hygiene] RUN  ${label}"
  "$@"
  echo "[hygiene] PASS ${label}"
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[hygiene] Not a git repository: $ROOT_DIR" >&2
  exit 2
fi

run_gate "root-allowlist" bash scripts/lib/node-governance-entry.sh scripts/ci/check-root-allowlist.mjs
run_gate "cache-governance" bash scripts/lib/node-governance-entry.sh scripts/ci/check-cache-governance.mjs
run_gate "no-nested-runtime-cache" bash scripts/lib/node-governance-entry.sh scripts/ci/check-no-nested-runtime-cache.mjs
run_gate "workspace-runtime-pollution" bash scripts/lib/node-governance-entry.sh scripts/ci/check-workspace-runtime-pollution.mjs
run_gate "dependency-boundaries" bash scripts/lib/node-governance-entry.sh scripts/ci/check-dependency-boundaries.mjs
run_gate "python-baseline" bash scripts/lib/node-governance-entry.sh scripts/ci/check-python-baseline.mjs
run_gate "logs-wild-surfaces" bash scripts/ci/check-no-wild-log-surfaces.sh

if git diff --name-only --diff-filter=U | grep -q '.'; then
  echo "[hygiene] FAIL unmerged conflict entries exist" >&2
  exit 1
fi

conflict_markers="$(git grep -nE '^(<<<<<<< |>>>>>>> )' -- . || true)"
if [[ -n "$conflict_markers" ]]; then
  echo "[hygiene] FAIL conflict markers found in tracked files" >&2
  echo "$conflict_markers" >&2
  exit 1
fi

echo "[hygiene] PASS canonical gates and conflict residue checks are clean"
