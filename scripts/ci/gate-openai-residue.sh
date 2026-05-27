#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PATTERN='(openai|chatgpt|provider[[:space:]]*[:=][[:space:]]*openai)'

# Minimal whitelist: governance docs only. No code whitelist.
WHITELIST_PATHS=(
  'Gemini 3 生态代码库深度治理与重构计划.md'
  '我和ChatGPT的对话.md'
  'configs/governance/ci-governance.yaml'
  'docs/reference/ci-governance.md'
)

EXCLUDE_GLOBS=(
  '.codex/**'
  '.claude/**'
  '.opencode/**'
  '.cursorrules'
  '.github/**'
  'scripts/ci/**'
  'scripts/ci/gate-openai-residue.sh'
  'scripts/ci/assert-no-openai-root.sh'
  'scripts/ci/gemini-only-policy.sh'
  'package.json'
  'Gemini 3 生态代码库深度治理与重构计划.md'
  'configs/governance/ci-governance.yaml'
  'docs/reference/ci-governance.md'
)

EXCLUDE_DIRS=(
  '.git'
  '.codex'
  '.claude'
  '.opencode'
  '.github'
  'scripts/ci'
  'node_modules'
  '.pnpm'
  '.venv'
  '__pycache__'
)

TMP_ALL="$(mktemp)"
TMP_ALLOWED="$(mktemp)"
trap 'rm -f "$TMP_ALL" "$TMP_ALLOWED"' EXIT

search_repo() {
  local target="$1"
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ "$target" == "." ]]; then
      local git_args=(-n -I -E "$PATTERN" -- .)
      for glob in "${EXCLUDE_GLOBS[@]}"; do
        git_args+=(":(exclude)$glob")
      done
      git grep "${git_args[@]}" || true
      return 0
    fi
    git grep -n -I -E "$PATTERN" -- "$target" || true
    return 0
  fi

  if command -v rg >/dev/null 2>&1; then
    local args=(-n --no-heading --with-filename -s -e "$PATTERN")
    for glob in "${EXCLUDE_GLOBS[@]}"; do
      args+=(--glob "!${glob}")
    done
    rg "${args[@]}" "$target" || true
    return 0
  fi

  if ! command -v grep >/dev/null 2>&1; then
    echo "[gate-openai-residue] neither rg nor grep is available." >&2
    exit 2
  fi

  local grep_args=(-R -n -I -E --binary-files=without-match --exclude-dir=.git)
  local exclude_dir=""
  for exclude_dir in "${EXCLUDE_DIRS[@]}"; do
    grep_args+=(--exclude-dir="$exclude_dir")
  done
  for glob in "${EXCLUDE_GLOBS[@]}"; do
    grep_args+=(--exclude="$glob")
  done
  grep "${grep_args[@]}" "$PATTERN" "$target" || true
}

# Collect hits as: path:line:content
search_repo . > "$TMP_ALL"

if [[ ! -s "$TMP_ALL" ]]; then
  echo "[gate-openai-residue] PASS: no residue detected"
  exit 0
fi

for allow in "${WHITELIST_PATHS[@]}"; do
  if [[ -f "$allow" ]]; then
    search_repo "$allow" >> "$TMP_ALLOWED"
  fi
done

python3 - "$TMP_ALL" "$TMP_ALLOWED" <<'PY'
import sys
from pathlib import Path

all_file = Path(sys.argv[1])
allow_file = Path(sys.argv[2])
def normalize(line: str) -> str:
    if line.startswith("./"):
        return line[2:]
    return line

all_hits = [normalize(line.rstrip("\n")) for line in all_file.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
allowed = set(normalize(line.rstrip("\n")) for line in allow_file.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip())
blocked = [line for line in all_hits if line not in allowed]

if blocked:
    print("[gate-openai-residue] BLOCKED: forbidden OpenAI/ChatGPT residue found")
    for line in blocked:
        print(line)
    print(f"Total blocked hits: {len(blocked)}")
    raise SystemExit(1)

print(f"[gate-openai-residue] PASS: only whitelisted governance-doc hits found ({len(all_hits)} total hits)")
PY
