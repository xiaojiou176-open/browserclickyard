#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[verify-repo-quality] 1/3 lint all"
pnpm lint:all

echo "[verify-repo-quality] 2/3 truth gate (strict)"
pnpm gate:test:truth

echo "[verify-repo-quality] 3/3 test matrix full"
pnpm test:matrix:full

echo "[verify-repo-quality] PASS"
