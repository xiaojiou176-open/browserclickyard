#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ci/commit-batch-check.sh pre
  bash scripts/ci/commit-batch-check.sh post
  bash scripts/ci/commit-batch-check.sh range [<git-range>]
  bash scripts/ci/commit-batch-check.sh commitlint-range [<git-range>]

Range mode (when <git-range> is omitted):
  COMMIT_BATCH_RANGE_MODE=local (default): check staged changes only; if no staged changes, warn and pass.
  COMMIT_BATCH_RANGE_MODE=full: check COMMIT_BATCH_BASE_REF..HEAD (default base: origin/main).
EOF
}

print_pre_suggestions() {
  cat <<'EOF'
Suggestion:
- Keep this batch focused on one topic.
- Stage only files that belong to this topic.
- If scope grows, split into another commit batch.
EOF
}

run_pre() {
  echo "[pre] git status --short --branch"
  git status --short --branch
  echo

  local has_issue=0

  if git diff --name-only --diff-filter=U | grep -q '.'; then
    echo "[pre] ERROR: unresolved merge conflicts detected."
    git diff --name-only --diff-filter=U
    has_issue=1
  fi

  local unstaged_files=()
  while IFS= read -r file; do
    if [[ -n "$file" ]]; then
      unstaged_files+=("$file")
    fi
  done < <(git diff --name-only)
  local scan_files=()
  local file
  for file in "${unstaged_files[@]}"; do
    if [[ -f "$file" ]]; then
      scan_files+=("$file")
    fi
  done

  if ((${#scan_files[@]} > 0)); then
    local marker_output
    marker_output="$(mktemp)"
    if rg -n -H '^(<<<<<<<|=======|>>>>>>>)' -- "${scan_files[@]}" >"${marker_output}" 2>/dev/null; then
      echo "[pre] ERROR: unstaged conflict markers found in working tree files:"
      cat "${marker_output}"
      has_issue=1
    fi
    rm -f "${marker_output}"
  fi

  echo
  print_pre_suggestions

  if ((has_issue > 0)); then
    exit 1
  fi

  echo "[pre] OK: no unresolved/unstaged conflict markers detected."
}

run_post() {
  if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "[post] ERROR: no commit found in current repository."
    exit 1
  fi

  echo "[post] latest commit summary"
  git log -1 --date=iso --pretty='format:%h %s%nAuthor: %an <%ae>%nDate: %ad'
  echo
  echo
  echo "[post] changed files in HEAD"
  git show --name-only --pretty='format:' HEAD | sed '/^$/d'
}

resolve_range() {
  local explicit_range="${1:-}"
  if [[ -n "${explicit_range}" ]]; then
    echo "${explicit_range}"
    return 0
  fi

  local mode="${COMMIT_BATCH_RANGE_MODE:-local}"
  if [[ "${mode}" == "full" ]]; then
    local base_ref="${COMMIT_BATCH_BASE_REF:-origin/main}"
    if git rev-parse --verify "${base_ref}" >/dev/null 2>&1; then
      echo "${base_ref}..HEAD"
      return 0
    fi

    if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
      local upstream
      upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
      echo "${upstream}..HEAD"
      return 0
    fi
  else
    if ! git diff --cached --quiet --exit-code; then
      echo "__INDEX__"
      return 0
    fi

    echo "__SKIP__"
    return 0
  fi

  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    echo "HEAD~1..HEAD"
    return 0
  fi

  echo "HEAD"
}

run_commitlint_range() {
  local range
  range="$(resolve_range "${1:-}")"

  if [[ "${range}" == "__SKIP__" ]]; then
    echo "[commitlint-range] WARN: no staged changes in local mode; skip commitlint range check."
    return 0
  fi

  if [[ "${range}" == "__INDEX__" ]]; then
    echo "[commitlint-range] skip: staged changes are not committed yet."
    return 0
  fi

  echo "[commitlint-range] checking range: ${range}"

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[commitlint-range] ERROR: pnpm not found."
    exit 1
  fi

  local from_ref
  local to_ref
  if [[ "${range}" == "HEAD" ]]; then
    if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
      from_ref="HEAD~1"
    else
      from_ref="HEAD"
    fi
    to_ref="HEAD"
  else
    from_ref="${range%%..*}"
    to_ref="${range##*..}"
  fi

  bash scripts/lib/node-bin.sh commitlint --config commitlint.config.cjs --from "${from_ref}" --to "${to_ref}"
}

run_range() {
  local range
  range="$(resolve_range "${1:-}")"
  local max_files="${COMMIT_BATCH_MAX_FILES:-25}"
  local max_roots="${COMMIT_BATCH_MAX_TOPLEVEL:-3}"

  run_commitlint_range "${range}"

  if [[ "${range}" == "__SKIP__" ]]; then
    echo "[range] WARN: no staged changes in local mode; atomic gate skipped and passed."
    return 0
  fi

  if [[ "${range}" == "__INDEX__" ]]; then
    echo "[range] staged-only mode: index snapshot"
  elif [[ "${range}" == "HEAD" ]]; then
    echo "[range] single-commit mode: HEAD"
  else
    echo "[range] checking atomicity for: ${range}"
  fi

  local commits=()
  if [[ "${range}" == "__INDEX__" ]]; then
    commits=("__INDEX__")
  elif [[ "${range}" == "HEAD" ]]; then
    commits=("HEAD")
  else
    while IFS= read -r sha; do
      if [[ -n "${sha}" ]]; then
        commits+=("${sha}")
      fi
    done < <(git rev-list --reverse "${range}")
  fi

  if ((${#commits[@]} == 0)); then
    echo "[range] OK: no new commits detected in range."
    return 0
  fi

  local has_issue=0
  local sha
  for sha in "${commits[@]}"; do
    local files=()
    local subject=""
    if [[ "${sha}" == "__INDEX__" ]]; then
      while IFS= read -r path; do
        if [[ -n "${path}" ]]; then
          files+=("${path}")
        fi
      done < <(git diff --cached --name-only | sed '/^$/d')
      subject="staged changes (uncommitted)"
    else
      while IFS= read -r path; do
        if [[ -n "${path}" ]]; then
          files+=("${path}")
        fi
      done < <(git show --name-only --pretty='format:' "${sha}" | sed '/^$/d')
      subject="$(git log -1 --pretty='format:%s' "${sha}")"
    fi

    local file_count="${#files[@]}"
    if ((file_count == 0)); then
      continue
    fi

    local roots
    roots="$(
      printf '%s\n' "${files[@]}" \
        | awk -F/ '{ root=$1; if (root ~ /^\./) { print "__repo_meta__" } else { print root } }' \
        | sort -u
    )"
    local root_count
    root_count="$(printf '%s\n' "${roots}" | sed '/^$/d' | wc -l | tr -d ' ')"
    echo "[range] commit ${sha}: files=${file_count}, top-level-dirs=${root_count}, subject=${subject}"

    if ((file_count > max_files)); then
      echo "[range] ERROR: ${sha} changed ${file_count} files (max ${max_files})."
      has_issue=1
    fi

    if ((root_count > max_roots)); then
      echo "[range] ERROR: ${sha} spans ${root_count} top-level dirs (max ${max_roots})."
      echo "[range] dirs: ${roots}"
      has_issue=1
    fi
  done

  if ((has_issue > 0)); then
    echo "[range] FAIL: atomic commit check failed."
    exit 1
  fi

  echo "[range] OK: atomic commit check passed."
}

main() {
  local mode="${1:-}"
  local explicit_range="${2:-}"
  case "${mode}" in
    pre) run_pre ;;
    post) run_post ;;
    range) run_range "${explicit_range}" ;;
    commitlint-range) run_commitlint_range "${explicit_range}" ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "${1:-}" "${2:-}"
