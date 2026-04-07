#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/dev/ast-search.sh '<AST_PATTERN>' [path...]

Examples:
  bash scripts/dev/ast-search.sh 'identifier'
  bash scripts/dev/ast-search.sh 'call_expression(function: (identifier) @fn)' backend frontend
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

pattern="$1"
shift

if [[ $# -gt 0 ]]; then
  search_paths=("$@")
else
  search_paths=(backend frontend packages)
fi

if command -v sg >/dev/null 2>&1; then
  provider="sg"
  cmd=(sg -p "$pattern" "${search_paths[@]}")
elif pnpm exec ast-grep --version >/dev/null 2>&1; then
  provider="pnpm-exec-ast-grep"
  cmd=(pnpm exec ast-grep run --pattern "$pattern" "${search_paths[@]}")
elif command -v npx >/dev/null 2>&1; then
  provider="npx--package-@ast-grep/cli"
  cmd=(npx --yes -p @ast-grep/cli ast-grep run --pattern "$pattern" "${search_paths[@]}")
else
  echo "[ast-search] no AST CLI available (need sg, pnpm exec ast-grep, or npx)." >&2
  exit 127
fi

echo "[ast-search] provider=${provider}"
echo "[ast-search] command=${cmd[*]}"
"${cmd[@]}"
