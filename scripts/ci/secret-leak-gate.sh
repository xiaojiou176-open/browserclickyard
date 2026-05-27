#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

echo "[secret-leak-gate] start"

migrate_legacy_gitleaks_history

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[secret-leak-gate] FAIL: .env is tracked by git; secrets must stay local only." >&2
  exit 1
fi

if [[ ! -f .env.example ]]; then
  echo "[secret-leak-gate] FAIL: .env.example is missing." >&2
  exit 1
fi

SCAN_GLOBS=(
  '*.env'
  '*.env.*'
  '.env'
  '**/*.env'
  '**/*.env.*'
  '*.md'
  '*.yml'
  '*.yaml'
  '*.json'
  '*.ts'
  '*.tsx'
  '*.js'
  '*.mjs'
  '*.py'
  '*.sh'
)

ALLOW_FILES=(
  ".env"
  ".env.example"
  "tooling/automation/.env.example"
)

while IFS= read -r tracked_env; do
  case "$tracked_env" in
    .env.example|*/.env.example)
      ;;
    *)
      echo "[secret-leak-gate] FAIL: tracked env-like file detected: $tracked_env (only .env.example templates may be tracked)." >&2
      exit 1
      ;;
  esac
done < <(git ls-files '.env*' '**/.env*')

declare -a RG_ARGS=()
for glob in "${SCAN_GLOBS[@]}"; do
  RG_ARGS+=(--glob "$glob")
done
for file in "${ALLOW_FILES[@]}"; do
  RG_ARGS+=(--glob "!$file")
done
RG_ARGS+=(--glob '!.git/**' --glob '!node_modules/**' --glob '!.runtime-cache/**')

PATTERN='(AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})'
LEAK_REPORT="$(mktemp -t uiq-secret-leaks.XXXXXX)"
if command -v rg >/dev/null 2>&1; then
  if rg -n --no-heading --with-filename -S "${RG_ARGS[@]}" -e "$PATTERN" . >"$LEAK_REPORT"; then
    echo "[secret-leak-gate] FAIL: high-confidence secret pattern detected." >&2
    cat "$LEAK_REPORT" >&2
    rm -f "$LEAK_REPORT"
    exit 1
  fi
else
  declare -a GREP_INCLUDE_ARGS=()
  for glob in "${SCAN_GLOBS[@]}"; do
    GREP_INCLUDE_ARGS+=(--include "$glob")
  done
  grep -R -n -I -E "$PATTERN" \
    "${GREP_INCLUDE_ARGS[@]}" \
    --exclude=.env \
    --exclude=.env.example \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=.runtime-cache \
    . >"$LEAK_REPORT" || true
  if [[ -s "$LEAK_REPORT" ]]; then
    FILTERED_REPORT="$(mktemp -t uiq-secret-leaks-filtered.XXXXXX)"
    grep -Ev '^(\./)?\.env\.example:|^(\./)?tooling/automation/\.env\.example:' "$LEAK_REPORT" >"$FILTERED_REPORT" || true
    if [[ -s "$FILTERED_REPORT" ]]; then
      echo "[secret-leak-gate] FAIL: high-confidence secret pattern detected." >&2
      cat "$FILTERED_REPORT" >&2
      rm -f "$LEAK_REPORT" "$FILTERED_REPORT"
      exit 1
    fi
    rm -f "$FILTERED_REPORT"
  fi
fi
rm -f "$LEAK_REPORT"

echo "[secret-leak-gate] PASS"
