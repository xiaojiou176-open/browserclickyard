#!/usr/bin/env bash
set -euo pipefail

print_help() {
  cat <<'EOF'
Usage:
  scripts/thirdparty/sync-upstream.sh --name <name> --upstream <remote-or-url> --from <ref> --to <ref> [options]

Description:
  Safe scaffold for synchronizing a third-party fork with upstream changes.
  This script intentionally does NOT auto-run destructive history rewrites.
  It only prepares branches, prints checks, and gives guided next commands.

Required arguments:
  --name        Third-party id. Used in branch names:
                thirdparty/<name>/upstream
                thirdparty/<name>/local
                thirdparty/<name>/sync-<timestamp>
  --upstream    Upstream git remote name or fetchable URL.
  --from        Start ref for upstream delta (tag/branch/commit).
  --to          End ref for upstream delta (tag/branch/commit).

Optional arguments:
  --dry-run
                Validate refs and print planned branch operations without
                creating/updating thirdparty branches.
  --allow-dirty  Allow execution when the worktree has local changes.
  --no-fetch     Skip git fetch. Useful for offline rehearsal.
  --force-upstream-branch
                Allow non-fast-forward reset of thirdparty/<name>/upstream.
                Default behavior only allows fast-forward updates.

Examples:
  scripts/thirdparty/sync-upstream.sh \
    --name playwright \
    --upstream upstream \
    --from v1.49.0 \
    --to v1.50.0

  scripts/thirdparty/sync-upstream.sh \
    --name acme-sdk \
    --upstream https://github.com/acme/acme-sdk.git \
    --from release-2025-12 \
    --to release-2026-01

  scripts/thirdparty/sync-upstream.sh \
    --dry-run \
    --allow-dirty \
    --name playwright \
    --upstream upstream \
    --from v1.49.0 \
    --to v1.50.0
EOF
}

log() {
  printf '[sync-upstream] %s\n' "$*"
}

die() {
  printf '[sync-upstream] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
}

NAME=""
UPSTREAM=""
FROM_REF=""
TO_REF=""
FORCE_UPSTREAM_BRANCH=0
DRY_RUN=0
ALLOW_DIRTY=0
NO_FETCH=0

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --upstream)
      UPSTREAM="${2:-}"
      shift 2
      ;;
    --from)
      FROM_REF="${2:-}"
      shift 2
      ;;
    --to)
      TO_REF="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    --force-upstream-branch)
      FORCE_UPSTREAM_BRANCH=1
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

[[ -n "$NAME" ]] || die "--name is required"
[[ -n "$UPSTREAM" ]] || die "--upstream is required"
[[ -n "$FROM_REF" ]] || die "--from is required"
[[ -n "$TO_REF" ]] || die "--to is required"
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "--name must match [A-Za-z0-9._-]+"

require_cmd git

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || die "not inside a git worktree"
cd "$repo_root"

status_output="$(git status --porcelain=v1)"
if [[ -n "$status_output" && "$ALLOW_DIRTY" -eq 0 ]]; then
  die "worktree is dirty; commit/stash first or rerun with --allow-dirty"
fi
if [[ -n "$status_output" && "$ALLOW_DIRTY" -eq 1 ]]; then
  log "warning: running with dirty worktree because --allow-dirty is set"
fi

current_branch="$(git branch --show-current || true)"
sync_branch=""
rollback_tag="rollback/thirdparty-${NAME}-$(date -u +%Y%m%d-%H%M%S)"

rollback_hint() {
  local code="$1"
  printf '\n[sync-upstream] failed (exit=%s)\n' "$code" >&2
  printf '[sync-upstream] rollback guidance:\n' >&2
  if [[ -n "$current_branch" ]]; then
    printf '  1) git switch %q\n' "$current_branch" >&2
  fi
  if [[ -n "$sync_branch" ]]; then
    printf '  2) git branch -D %q    # only if you do not need this sync branch\n' "$sync_branch" >&2
  fi
  printf '  3) git tag -a %q HEAD -m %q\n' "$rollback_tag" "rollback point before retry" >&2
  printf '  4) git status -sb\n' >&2
}

on_err() {
  local code="$?"
  rollback_hint "$code"
  exit "$code"
}

trap on_err ERR

upstream_is_remote=0
if git remote get-url "$UPSTREAM" >/dev/null 2>&1; then
  upstream_is_remote=1
fi

resolve_commit() {
  local ref="$1"
  local resolved=""

  if resolved="$(git rev-parse --verify "${ref}^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$resolved"
    return 0
  fi

  if [[ "$upstream_is_remote" -eq 1 ]]; then
    if resolved="$(git rev-parse --verify "refs/remotes/${UPSTREAM}/${ref}^{commit}" 2>/dev/null)"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  fi

  return 1
}

local_branch="thirdparty/${NAME}/local"
upstream_branch="thirdparty/${NAME}/upstream"
sync_branch="thirdparty/${NAME}/sync-$(date -u +%Y%m%d-%H%M%S)"

log "repo: $repo_root"
if [[ "$NO_FETCH" -eq 1 ]]; then
  log "skip fetch: --no-fetch set"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] fetch upstream for ref validation: $UPSTREAM (prune + tags)"
  else
    log "fetch upstream: $UPSTREAM (prune + tags)"
  fi
  git fetch --prune --tags "$UPSTREAM"
fi

from_commit="$(resolve_commit "$FROM_REF" || true)"
to_commit="$(resolve_commit "$TO_REF" || true)"

[[ -n "$from_commit" ]] || die "cannot resolve --from '$FROM_REF' to a commit after fetch"
[[ -n "$to_commit" ]] || die "cannot resolve --to '$TO_REF' to a commit after fetch"
if ! git merge-base --is-ancestor "$from_commit" "$to_commit"; then
  log "warning: --from ($FROM_REF) is not an ancestor of --to ($TO_REF); commit range may be non-linear"
fi

git show-ref --verify --quiet "refs/heads/${local_branch}" || die "required branch missing: ${local_branch}"

upstream_compare_ref="$upstream_branch"
if git show-ref --verify --quiet "refs/heads/${upstream_branch}"; then
  current_upstream_commit="$(git rev-parse --verify "refs/heads/${upstream_branch}^{commit}")"
  if git merge-base --is-ancestor "$current_upstream_commit" "$to_commit"; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[dry-run] fast-forward branch: ${upstream_branch} ${current_upstream_commit} -> ${to_commit}"
      upstream_compare_ref="$to_commit"
    else
      log "fast-forward branch: ${upstream_branch} ${current_upstream_commit} -> ${to_commit}"
      git update-ref "refs/heads/${upstream_branch}" "$to_commit" "$current_upstream_commit"
    fi
  elif [[ "$FORCE_UPSTREAM_BRANCH" -eq 1 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[dry-run] force update branch: ${upstream_branch} ${current_upstream_commit} -> ${to_commit} (--force-upstream-branch)"
      upstream_compare_ref="$to_commit"
    else
      log "force update branch: ${upstream_branch} ${current_upstream_commit} -> ${to_commit} (--force-upstream-branch)"
      git branch --force "$upstream_branch" "$to_commit" >/dev/null
    fi
  else
    die "non-fast-forward update detected for ${upstream_branch}; rerun with --force-upstream-branch to override"
  fi
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] create branch: ${upstream_branch} -> ${to_commit}"
    upstream_compare_ref="$to_commit"
  else
    log "create branch: ${upstream_branch} -> ${to_commit}"
    git branch "$upstream_branch" "$to_commit" >/dev/null
  fi
fi

if git show-ref --verify --quiet "refs/heads/${sync_branch}"; then
  sync_branch="${sync_branch}-$$"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "[dry-run] create sync branch from ${local_branch}: ${sync_branch}"
else
  log "create sync branch from ${local_branch}: ${sync_branch}"
  git switch --create "$sync_branch" "$local_branch" >/dev/null
fi

upstream_delta_count="$(git rev-list --count "${from_commit}..${to_commit}")"
read -r upstream_only_count local_only_count < <(git rev-list --left-right --count "${upstream_compare_ref}...${local_branch}")

candidate_commits="$(git rev-list --reverse "${from_commit}..${to_commit}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

printf '\n'
log "prepared branches:"
printf '  - %s (tracks upstream target)\n' "$upstream_branch"
printf '  - %s (integration workspace)\n' "$sync_branch"
printf '\n'
log "checks:"
printf '  - upstream delta commits (%s..%s): %s\n' "$FROM_REF" "$TO_REF" "$upstream_delta_count"
printf '  - divergence (%s...%s): upstream-only=%s local-only=%s\n' "$upstream_compare_ref" "$local_branch" "$upstream_only_count" "$local_only_count"
printf '  - rollback checkpoint (recommended): git tag -a %s %s -m %q\n' "$rollback_tag" "$local_branch" "rollback point before applying upstream sync"
printf '\n'

cat <<EOF
Next step A (preferred): rebase local patch queue on upstream branch
  git switch ${sync_branch}
  git rebase --rebase-merges ${upstream_branch}

Next step B (alternative): cherry-pick selected upstream commits
  git switch ${sync_branch}
  git log --oneline --reverse ${from_commit}..${to_commit}
  git cherry-pick -x <commit_sha> [more_commit_sha...]

Conflict loop (manual)
  git status
  # resolve files
  git add <resolved_files>
  git rebase --continue   # when using rebase
  # or
  git cherry-pick --continue

Abort strategy (safe rollback)
  git rebase --abort
  # or
  git cherry-pick --abort
  git switch ${current_branch:-<previous-branch>}       # return branch pointer
  git reset --hard ${rollback_tag}                      # reset to rollback point if created
  git branch -D ${sync_branch}                          # only if no work needs to be kept

Gate prompts (run after conflict resolution)
  ./scripts/git-sync-audit.sh --thirdparty ${NAME}
  git log --oneline --decorate --graph -20
  git diff --stat ${upstream_branch}...${sync_branch}
EOF

if [[ -f package.json ]] && command -v pnpm >/dev/null 2>&1; then
  printf '  pnpm lint\n'
fi

if command -v uv >/dev/null 2>&1; then
  printf '  bash scripts/lib/python-exec.sh pytest -q\n'
fi

printf '\n'
log "candidate upstream commits (${from_commit}..${to_commit}):"
if [[ -n "$candidate_commits" ]]; then
  git log --oneline --reverse "${from_commit}..${to_commit}"
else
  printf '  (no commits in range)\n'
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '\n'
  log "dry-run complete: no thirdparty/* branch was created or modified"
fi

printf '\n'
log "done. no rebase/cherry-pick command was executed automatically."
