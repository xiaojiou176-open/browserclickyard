#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

has_failure=0
report_file="$(mktemp)"
report_mode=0

usage() {
  cat <<'EOF'
Usage: bash scripts/ci/gemini-only-policy.sh [--report]

Options:
  --report   Print detailed residual OpenAI literal audit output.
  -h, --help Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report)
      report_mode=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[gemini-only-policy] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cleanup() {
  rm -f "$report_file"
}
trap cleanup EXIT

scan_scope() {
  local scope="$1"
  local pattern="$2"
  shift 2
  local -a targets=("$@")

  if [[ ${#targets[@]} -eq 0 ]]; then
    return 0
  fi

  local matches
  matches="$(rg --line-number --with-filename --color=never -e "$pattern" "${targets[@]}" || true)"
  if [[ -n "$matches" ]]; then
    has_failure=1
    {
      printf '[%s] forbidden pattern: %s\n' "$scope" "$pattern"
      printf '%s\n\n' "$matches"
    } >>"$report_file"
  fi
}

declare -a OPENAI_LITERAL_WHITELIST=(
  "scripts/ci/gemini-only-policy.sh"
)

declare -a NON_EXEC_AUDIT_TARGETS=(
  "scripts/ci/gemini-only-policy.sh"
  "scripts/computer-use/stealth-browser.py"
  "scripts/computer-use/requirements.txt"
  "docs/reference/configuration.md"
)

audit_openai_non_exec_residue() {
  local literal_pattern='openai|OPENAI'
  local matches
  local -a allowed_hits=()
  local -a forbidden_hits=()

  matches="$(rg --line-number --with-filename --color=never -e "$literal_pattern" "${NON_EXEC_AUDIT_TARGETS[@]}" || true)"
  if [[ -z "$matches" ]]; then
    echo '[residual-audit] no openai literals found in non-execution targets.'
    return 0
  fi

  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    local hit_file="${hit%%:*}"
    local is_allowed=0
    for allowed in "${OPENAI_LITERAL_WHITELIST[@]}"; do
      if [[ "$hit_file" == "$allowed" ]]; then
        is_allowed=1
        break
      fi
    done
    if [[ "$is_allowed" -eq 1 ]]; then
      allowed_hits+=("$hit")
    else
      forbidden_hits+=("$hit")
    fi
  done <<<"$matches"

  if [[ "$report_mode" -eq 1 ]]; then
    echo '[residual-audit] whitelist:'
    printf '  - %s\n' "${OPENAI_LITERAL_WHITELIST[@]}"
    echo
    echo "[residual-audit] allowed hits: ${#allowed_hits[@]}"
    if [[ ${#allowed_hits[@]} -gt 0 ]]; then
      printf '%s\n' "${allowed_hits[@]}"
      echo
    fi
    echo "[residual-audit] forbidden hits: ${#forbidden_hits[@]}"
    if [[ ${#forbidden_hits[@]} -gt 0 ]]; then
      printf '%s\n' "${forbidden_hits[@]}"
      echo
    fi
  else
    echo "[residual-audit] allowed=${#allowed_hits[@]} forbidden=${#forbidden_hits[@]} (use --report for details)"
  fi

  if [[ ${#forbidden_hits[@]} -gt 0 ]]; then
    has_failure=1
    {
      echo '[residual-audit] forbidden openai literals found in non-execution targets:'
      printf '%s\n' "${forbidden_hits[@]}"
      echo
    } >>"$report_file"
  fi
}

workflow_files=()
while IFS= read -r file; do
  workflow_files+=("$file")
done < <(git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml')

code_files_raw=()
while IFS= read -r file; do
  code_files_raw+=("$file")
done < <(git ls-files 'scripts/ai/*.mjs' 'scripts/ci/*.sh' 'scripts/ci/*.mjs')

config_files=()
while IFS= read -r file; do
  config_files+=("$file")
done < <(git ls-files 'package.json')

docs_files=()
while IFS= read -r file; do
  docs_files+=("$file")
done < <(git ls-files 'docs/quality-gates.md' 'docs/ci/*.md')

dependency_files=()
while IFS= read -r file; do
  dependency_files+=("$file")
done < <(git ls-files | rg --line-regexp '(.*/)?package\.json|(.*/)?pyproject\.toml|(.*/)?requirements[^/]*\.txt')

code_files=()
for file in "${code_files_raw[@]}"; do
  if [[ "$file" == 'scripts/ci/gemini-only-policy.sh' ]]; then
    continue
  fi
  code_files+=("$file")
done

# Workflow gate: reject OpenAI env injection or openai/auto provider routing.
scan_scope "workflow" 'OPENAI_[A-Z0-9_]+' "${workflow_files[@]}"
scan_scope "workflow" 'ANTHROPIC_[A-Z0-9_]+' "${workflow_files[@]}"
scan_scope "workflow" "VIDEO_ANALYZER_PROVIDER\\s*:\\s*['\"]?(openai|auto)\\b" "${workflow_files[@]}"
scan_scope "workflow" "VIDEO_ANALYZER_PROVIDER\\s*=\\s*['\"]?(openai|auto)\\b" "${workflow_files[@]}"
scan_scope "workflow" "VIDEO_ANALYZER_PROVIDER\\s*:\\s*['\"]?(anthropic)\\b" "${workflow_files[@]}"
scan_scope "workflow" "VIDEO_ANALYZER_PROVIDER\\s*=\\s*['\"]?(anthropic)\\b" "${workflow_files[@]}"

# Code gate: reject executable OpenAI runtime access in CI and provider-readiness scripts.
scan_scope "code" 'process\.env\.OPENAI_[A-Z0-9_]+' "${code_files[@]}"
scan_scope "code" 'process\.env\.ANTHROPIC_[A-Z0-9_]+' "${code_files[@]}"
scan_scope "code" "VIDEO_ANALYZER_PROVIDER\\s*=\\s*['\"]?(openai|auto)\\b" "${code_files[@]}"
scan_scope "code" "VIDEO_ANALYZER_PROVIDER\\s*=\\s*['\"]?(anthropic)\\b" "${code_files[@]}"

# Config gate: reject OpenAI config wiring in npm scripts.
scan_scope "config" 'OPENAI_[A-Z0-9_]+' "${config_files[@]}"
scan_scope "config" 'ANTHROPIC_[A-Z0-9_]+' "${config_files[@]}"
scan_scope "config" 'VIDEO_ANALYZER_PROVIDER\s*=\s*(openai|auto)\b' "${config_files[@]}"
scan_scope "config" 'VIDEO_ANALYZER_PROVIDER\s*=\s*(anthropic)\b' "${config_files[@]}"

# Docs gate: reject executable OpenAI command snippets in CI docs.
scan_scope "docs" '(^|\s)(export\s+)?OPENAI_[A-Z0-9_]+=' "${docs_files[@]}"
scan_scope "docs" '(^|\s)(export\s+)?ANTHROPIC_[A-Z0-9_]+=' "${docs_files[@]}"
scan_scope "docs" 'VIDEO_ANALYZER_PROVIDER=(openai|auto)\b' "${docs_files[@]}"
scan_scope "docs" 'VIDEO_ANALYZER_PROVIDER=(anthropic)\b' "${docs_files[@]}"

# Dependency gate: reject direct OpenAI and legacy Gemini SDK entries in manifests.
scan_scope "dependency" '"openai"\s*:' "${dependency_files[@]}"
scan_scope "dependency" '(^|\s|["'\''])openai([<>=!~].*)?(["'\'']|\s|$)' "${dependency_files[@]}"
scan_scope "dependency" '"anthropic"\s*:' "${dependency_files[@]}"
scan_scope "dependency" '(^|\s|["'\''])anthropic([<>=!~].*)?(["'\'']|\s|$)' "${dependency_files[@]}"
scan_scope "dependency" '@google/generative-ai' "${dependency_files[@]}"
scan_scope "dependency" 'google-generativeai' "${dependency_files[@]}"

# Non-execution residue audit: only whitelist literal OpenAI mentions that are policy/test necessities.
audit_openai_non_exec_residue

if [[ "$has_failure" -ne 0 ]]; then
  echo '[gemini-only-policy] FAIL: detected forbidden OpenAI traces.'
  cat "$report_file"
  exit 1
fi

echo '[gemini-only-policy] PASS: CI execution surfaces are Gemini-only and residual whitelist audit is clean.'
