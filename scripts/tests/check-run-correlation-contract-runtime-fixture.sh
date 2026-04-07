#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

bash scripts/lib/node-governance-entry.sh scripts/ci/check-run-correlation-contract.mjs

echo "check-run-correlation-contract runtime fixture checks passed"
