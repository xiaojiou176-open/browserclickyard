#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TARGETS=(packages/orchestrator scripts services apps)

dangerous_kill_hits="$(
  rg -n \
    --glob '!**/node_modules/**' \
    --glob '!**/dist/**' \
    --glob '!**/build/**' \
    --glob '!scripts/ci/host-safety-gate.sh' \
    '\bkillall\b|\bpkill\s+-f\b|\bkillpg\s*\(|(?:process|os)\.kill\(\s*-\s*' \
    "${TARGETS[@]}" || true
)"
if [[ -n "${dangerous_kill_hits}" ]]; then
  echo "[host-safety] FAIL: forbidden broad host-kill primitive detected"
  echo "${dangerous_kill_hits}"
  exit 1
fi

automation_hits="$(rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' 'System Events|osascript' "${TARGETS[@]}" || true)"
if [[ -n "${automation_hits}" ]]; then
  disallowed_hits="$(printf '%s\n' "${automation_hits}" | grep -vE '^scripts/ci/host-safety-gate\.sh:' | grep -vE '^packages/orchestrator/src/commands/desktop(-|\.|/|utils|ts)' || true)"
  if [[ -n "${disallowed_hits}" ]]; then
    echo "[host-safety] FAIL: osascript/System Events surfaced outside desktop operator-manual commands"
    echo "${disallowed_hits}"
    exit 1
  fi
fi

echo "[host-safety] PASS"
