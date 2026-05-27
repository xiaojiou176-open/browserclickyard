#!/usr/bin/env bash
set -euo pipefail

./scripts/release/check-workflow-pnpm-version-guard.sh
pnpm gate:github:security-alerts
pnpm gate:sensitive-surfaces
pnpm gate:secret-leak
pnpm gate:iac:consistency
pnpm env:governance:check:strict
pnpm env:check
bash -n scripts/release/check-workflow-pnpm-version-guard.sh scripts/release/generate-release-notes.sh
node --check scripts/ci/uiq-test-truth-gate.mjs
node --check scripts/ci/check-button-inventory.mjs
node --check scripts/ci/check-engine-runtime.mjs
node --check scripts/perf/perf-regression-guard.mjs
node --check scripts/api/check-breaking-contract.mjs
bash scripts/lib/node-bin.sh tsx --test services/mcp-server/tests/mcp-command-parity.test.ts services/mcp-server/tests/mcp-perfect-mode.test.ts
node scripts/ci/uiq-test-truth-gate.mjs --profile nightly --strict true
node scripts/ci/check-button-inventory.mjs
pnpm uiq engines:check --profile nightly
pnpm test:e2e:frontend:smoke
node scripts/perf/perf-regression-guard.mjs --mode strict --window 5
node scripts/api/check-breaking-contract.mjs
