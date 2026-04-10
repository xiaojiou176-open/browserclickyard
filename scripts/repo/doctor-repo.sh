#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

read_bool() {
  local raw="${1:-}"
  case "$raw" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

# Most doctor gates only need the already-prepared shared node topology.
# Re-running shared-link repair before every node-governance entry makes the
# PR gate dramatically slower without changing the assertions those gates make.
export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1

if ! read_bool "${UIQ_DOCTOR_REPO_SKIP_REDUNDANT_GOVERNANCE:-0}"; then
  bash scripts/lib/pnpm-safe.sh gate:root:allowlist
  bash scripts/lib/pnpm-safe.sh gate:cache:governance
  bash scripts/lib/pnpm-safe.sh gate:cache:contract
  bash scripts/lib/pnpm-safe.sh gate:config:convergence
  bash scripts/lib/pnpm-safe.sh gate:dependency:boundaries
else
  echo "[doctor:repo] skip redundant governance gates (already enforced by gate:repo:fast)"
fi
bash scripts/lib/pnpm-safe.sh gate:english:deep-water
bash scripts/lib/pnpm-safe.sh gate:external:source-purity
bash scripts/lib/pnpm-safe.sh gate:upstream:private-coupling
bash scripts/lib/pnpm-safe.sh gate:workflow:runner-governance
bash scripts/lib/pnpm-safe.sh gate:live:realism
bash scripts/tests/check-branch-protection-reasons.sh
bash scripts/tests/git-sync-audit-mode.sh
bash scripts/tests/node-modules-contract-probe.sh
bash scripts/tests/node-governance-entry-concurrency.sh
bash scripts/tests/no-parent-workspace-node-modules.sh
bash scripts/lib/pnpm-safe.sh audit:space:report

unset UIQ_SKIP_SHARED_MODULE_LINK_REPAIR

# These checks explicitly validate the repair lock/stamp behavior, so they must
# run with the real repair path enabled.
bash scripts/tests/shared-link-repair-lock.sh
bash scripts/tests/shared-link-repair-stamp.sh
