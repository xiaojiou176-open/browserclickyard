#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/upstream/sync.sh [options]
  bash scripts/upstream/sync.sh [legacy_upstream_branch]

Options:
  --dry-run                    Validate prerequisites and print planned sync commands.
  --strategy merge|rebase      Sync strategy (default: merge).
  --upstream-branch <branch>   Upstream branch to sync from (default: main).
  -h, --help                   Show help.
EOF
}

print_cmd() {
  local cmd=("$@")
  printf '  '
  printf '%q ' "${cmd[@]}"
  printf '\n'
}

run_or_print() {
  local cmd=("$@")
  if [[ "$DRY_RUN" == "1" ]]; then
    print_cmd "${cmd[@]}"
    return 0
  fi
  "${cmd[@]}"
}

UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="main"
STRATEGY="merge"
DRY_RUN="0"
LEGACY_UPSTREAM_BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --strategy)
      if [[ $# -lt 2 ]]; then
        echo "error: --strategy requires a value: merge|rebase" >&2
        exit 1
      fi
      STRATEGY="$2"
      shift 2
      ;;
    --upstream-branch)
      if [[ $# -lt 2 ]]; then
        echo "error: --upstream-branch requires a branch name" >&2
        exit 1
      fi
      UPSTREAM_BRANCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$LEGACY_UPSTREAM_BRANCH" ]]; then
        echo "error: unexpected positional argument '$1'" >&2
        usage >&2
        exit 1
      fi
      LEGACY_UPSTREAM_BRANCH="$1"
      shift
      ;;
  esac
done

if [[ -n "$LEGACY_UPSTREAM_BRANCH" ]]; then
  if [[ "$UPSTREAM_BRANCH" != "main" ]]; then
    echo "error: do not mix positional upstream branch with --upstream-branch." >&2
    exit 1
  fi
  UPSTREAM_BRANCH="$LEGACY_UPSTREAM_BRANCH"
fi

if [[ "$STRATEGY" != "merge" && "$STRATEGY" != "rebase" ]]; then
  echo "error: invalid --strategy '$STRATEGY' (expected merge|rebase)" >&2
  exit 1
fi

if [[ -z "$UPSTREAM_BRANCH" ]]; then
  echo "error: upstream branch must not be empty" >&2
  exit 1
fi

UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
SYNC_BRANCH_DATE="$(date +%Y%m%d)"
SYNC_BRANCH="sync/upstream-${SYNC_BRANCH_DATE}"
if [[ "$UPSTREAM_BRANCH" != "main" ]]; then
  SYNC_BRANCH="sync/upstream-${UPSTREAM_BRANCH//\//-}-${SYNC_BRANCH_DATE}"
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git worktree" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain=v1)" ]]; then
  cat <<'EOF'
error: working tree is not clean.
hint:
  - commit changes: git add -A && git commit -m "..."
  - or stash changes: git stash -u
EOF
  exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  cat <<'EOF'
error: remote 'upstream' is not configured.
hint:
  - add upstream: git remote add upstream <repo-url>
  - verify remote: git remote -v
EOF
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${SYNC_BRANCH}"; then
  echo "error: branch '${SYNC_BRANCH}' already exists." >&2
  echo "hint: delete it or run again with a different date suffix." >&2
  exit 1
fi

BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_URL="$(git remote get-url "$UPSTREAM_REMOTE")"

cat <<EOF
[upstream-sync] config:
- strategy: ${STRATEGY}
- upstream remote: ${UPSTREAM_REMOTE} (${UPSTREAM_URL})
- source ref: ${UPSTREAM_REF}
- base branch: ${BASE_BRANCH}
- sync branch: ${SYNC_BRANCH}
- dry-run: $(if [[ "$DRY_RUN" == "1" ]]; then echo "yes"; else echo "no"; fi)
EOF

echo "[upstream-sync] fetch ${UPSTREAM_REMOTE} ..."
git fetch "$UPSTREAM_REMOTE" --prune

if ! git show-ref --verify --quiet "refs/remotes/${UPSTREAM_REF}"; then
  echo "error: ref '${UPSTREAM_REF}' not found after fetch." >&2
  echo "hint: list upstream refs with: git branch -r | rg '^  ${UPSTREAM_REMOTE}/'" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  cat <<EOF
[upstream-sync] dry-run plan:
EOF
  print_cmd git switch -c "$SYNC_BRANCH"
  if [[ "$STRATEGY" == "merge" ]]; then
    print_cmd git merge --no-ff --no-edit "$UPSTREAM_REF"
  else
    print_cmd git rebase "$UPSTREAM_REF"
  fi
  cat <<EOF

[upstream-sync] dry-run complete.
next steps for real execution:
1) run without --dry-run
   bash scripts/upstream/sync.sh --strategy ${STRATEGY} --upstream-branch ${UPSTREAM_BRANCH}
2) audit and regression
   bash scripts/git-sync-audit.sh --fetch
   pnpm lint
   pnpm test
EOF
  exit 0
fi

echo "[upstream-sync] create branch ${SYNC_BRANCH} from ${BASE_BRANCH}"
run_or_print git switch -c "$SYNC_BRANCH"

echo "[upstream-sync] ${STRATEGY} ${UPSTREAM_REF}"
set +e
if [[ "$STRATEGY" == "merge" ]]; then
  run_or_print git merge --no-ff --no-edit "$UPSTREAM_REF"
else
  run_or_print git rebase "$UPSTREAM_REF"
fi
MERGE_STATUS=$?
set -e

if [[ "$MERGE_STATUS" -ne 0 ]]; then
  if [[ "$STRATEGY" == "merge" ]]; then
    ABORT_COMMAND="git merge --abort"
  else
    ABORT_COMMAND="git rebase --abort"
  fi
  cat <<EOF
[upstream-sync] ${STRATEGY} failed, most likely due to conflicts.

conflict handling:
1) check conflicts
   git status
2) resolve files, then finish ${STRATEGY}
   git add <resolved-files>
   $(if [[ "$STRATEGY" == "merge" ]]; then echo "git commit"; else echo "git rebase --continue"; fi)
3) abort ${STRATEGY} if needed
   ${ABORT_COMMAND}

regression commands (after conflicts resolved):
- bash scripts/git-sync-audit.sh --fetch
- pnpm lint
- pnpm test
EOF
  exit "$MERGE_STATUS"
fi

cat <<EOF
[upstream-sync] ${STRATEGY} complete.
- upstream remote: ${UPSTREAM_URL}
- source ref: ${UPSTREAM_REF}
- base branch: ${BASE_BRANCH}
- sync branch: ${SYNC_BRANCH}
- strategy: ${STRATEGY}

next steps:
1) audit sync status
   bash scripts/git-sync-audit.sh --fetch
2) run regression gates
   pnpm lint
   pnpm test
3) push sync branch
   git push -u origin ${SYNC_BRANCH}
EOF
