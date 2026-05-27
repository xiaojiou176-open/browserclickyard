#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

migrate_legacy_gitleaks_history() {
  local legacy_path=".runtime-cache/gitleaks-history.json"
  local managed_dir=".runtime-cache/cache/gitleaks"
  local managed_path="${managed_dir}/history.json"
  if [[ ! -f "$legacy_path" ]]; then
    return 0
  fi
  mkdir -p "$managed_dir"
  mv -f "$legacy_path" "$managed_path"
}

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv not found, run ./scripts/setup.sh first"
  exit 1
fi

migrate_legacy_gitleaks_history

echo "[security 1/5] python dependency audit"
mkdir -p .runtime-cache/reports/security
REQ_FILE=".runtime-cache/reports/security/pip-freeze.txt"
REQ_FILE_ABS="$ROOT_DIR/$REQ_FILE"
bash scripts/lib/python-exec.sh python -m pip freeze | grep -Ev '^(#|-e )|^browserclickyard==' > "$REQ_FILE"
# Audit the fully pinned freeze list directly to avoid pip-audit temp venv bootstrap
# failures in some local Python builds while keeping strict vulnerability gating.
bash scripts/lib/python-exec.sh pip-audit --strict --no-deps --disable-pip -r "$REQ_FILE_ABS"

echo "[security 2/5] backend sast (bandit)"
bash scripts/lib/python-exec.sh bandit -ll -r services/api/app

echo "[security 3/5] frontend dependency audit"
(cd apps/command-center && pnpm audit --prod --audit-level=moderate)

echo "[security 4/5] automation dependency audit"
(cd tooling/automation && pnpm audit --prod --audit-level=moderate)

echo "[security 5/5] workspace dependency audit"
pnpm audit --prod --audit-level=moderate

migrate_legacy_gitleaks_history

echo "security scan passed"
