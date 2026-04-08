#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

violations=0

package_manager_workflows=(
  ".github/workflows/ci.yml"
  ".github/workflows/pr.yml"
  ".github/workflows/nightly.yml"
  ".github/workflows/desktop-smoke.yml"
  ".github/workflows/live-realism.yml"
  ".github/workflows/release-candidate.yml"
)

for wf in "${package_manager_workflows[@]}"; do
  if [[ ! -f "$wf" ]]; then
    echo "missing workflow file: $wf"
    violations=$((violations + 1))
    continue
  fi
  if grep -nE 'uses:[[:space:]]*pnpm/action-setup@' "$wf" >/dev/null; then
    grep -nE 'uses:[[:space:]]*pnpm/action-setup@' "$wf" | while IFS= read -r line; do
      echo "${wf}:${line%%:*}: pnpm/action-setup is forbidden; use corepack + packageManager"
    done
    violations=$((violations + 1))
  fi
  if ! grep -Eq 'corepack prepare .+packageManager' "$wf"; then
    echo "${wf}: missing corepack prepare command that reads packageManager"
    violations=$((violations + 1))
  fi
done

for wf in .github/workflows/*.yml .github/workflows/*.yaml; do
  [[ -f "$wf" ]] || continue
  while IFS= read -r line; do
    line_no="${line%%:*}"
    body="${line#*:}"
    action_ref="$(printf "%s\n" "$body" | sed -E 's/^[[:space:]]*-[[:space:]]*uses:[[:space:]]*([^[:space:]#]+).*/\1/')"

    if [[ "$action_ref" == ./* ]] || [[ "$action_ref" == docker://* ]]; then
      continue
    fi
    if [[ "$action_ref" == *'${{'* ]]; then
      echo "${wf}:${line_no}: dynamic action refs are forbidden (${action_ref})"
      violations=$((violations + 1))
      continue
    fi
    if [[ "$action_ref" != *@* ]]; then
      echo "${wf}:${line_no}: action ref must include @<commit-sha> (${action_ref})"
      violations=$((violations + 1))
      continue
    fi

    action_name="${action_ref%@*}"
    action_ref_version="${action_ref##*@}"

    if [[ ! "$action_name" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      echo "${wf}:${line_no}: unsupported action format (${action_ref})"
      violations=$((violations + 1))
      continue
    fi
    if [[ ! "$action_ref_version" =~ ^[0-9a-fA-F]{40}$ ]]; then
      echo "${wf}:${line_no}: external actions must pin full commit SHA (${action_ref})"
      violations=$((violations + 1))
    fi
  done < <(grep -nE '^[[:space:]]*-[[:space:]]*uses:[[:space:]]*[^[:space:]#]+' "$wf" || true)
done

if [[ "$violations" -gt 0 ]]; then
  echo "workflow guard failed: ${violations} violation(s)"
  exit 1
fi

bash scripts/lib/node-governance-entry.sh scripts/ci/check-workflow-runner-governance.mjs

echo "workflow guard passed (packageManager policy + action SHA pinning)"
