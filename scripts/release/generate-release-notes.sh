#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

out_dir=".runtime-cache/artifacts/release"
out_file="${out_dir}/release-notes-vnext.md"
mkdir -p "$out_dir"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
last_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"

if [[ -n "$last_tag" ]]; then
  range="${last_tag}..HEAD"
  range_label="$last_tag -> HEAD"
else
  range="HEAD"
  range_label="full history on current branch"
fi

feature_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei '^- [0-9a-f]+ (feat|feature)(\(|:)' || true)"
fix_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei '^- [0-9a-f]+ (fix|bugfix|hotfix)(\(|:)' || true)"
perf_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei '^- [0-9a-f]+ perf(\(|:)' || true)"
docs_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei '^- [0-9a-f]+ docs(\(|:)' || true)"
dep_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei '^- [0-9a-f]+ (chore|build|ci|deps|refactor)(\(|:)' || true)"
break_lines="$(git log --no-merges --pretty='- %h %s (%an)' "$range" | grep -Ei 'breaking(\s+change|:|\b)|!:' || true)"

print_section() {
  local body="$1"
  if [[ -n "$body" ]]; then
    printf '%s\n' "$body"
  else
    echo "- None"
  fi
}

{
  echo "# Release Notes (vNext)"
  echo
  echo "## Metadata"
  echo "- Generated At (UTC): $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo "- Branch: ${branch}"
  echo "- Range: ${range_label}"
  echo
  echo "## Highlights"
  if [[ -n "$feature_lines" ]]; then
    printf '%s\n' "$feature_lines" | sed -n '1,5p'
  elif [[ -n "$fix_lines" ]]; then
    printf '%s\n' "$fix_lines" | sed -n '1,5p'
  else
    echo "- No major highlights detected from commit prefixes."
  fi
  echo
  echo "## Breaking Changes"
  if [[ -n "$break_lines" ]]; then
    printf '%s\n' "$break_lines"
  else
    echo "- None detected."
  fi
  echo
  echo "## Features"
  print_section "$feature_lines"
  echo
  echo "## Fixes"
  print_section "$fix_lines"
  echo
  echo "## Performance"
  print_section "$perf_lines"
  echo
  echo "## Documentation"
  print_section "$docs_lines"
  echo
  echo "## Dependency & Build"
  print_section "$dep_lines"
  echo
  echo "## Commits"
  git log --no-merges --pretty='- %h %s (%an)' "$range"
} > "$out_file"

echo "release notes generated: ${out_file}"
