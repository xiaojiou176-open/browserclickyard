#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/git-sync-audit.sh [options]

Options:
  --fetch                     Fetch origin/configured-upstream before auditing.
  --json                      Print machine-readable JSON output.
  --thirdparty <name>         Audit thirdparty/<name> branch model details.
  --strict                    Exit non-zero when required thirdparty branches are missing.
  --upstream-branch <branch>  Upstream branch override (default from config).
  --config <path>             Upstream source config path (default: configs/upstream/source.yaml).
  -h, --help                  Show help.
EOF
}

read_yaml_key() {
  local key="$1"
  local file="$2"
  awk -F':' -v target="$key" '
    $1 ~ "^[[:space:]]*" target "[[:space:]]*$" {
      value = substr($0, index($0, ":") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$file"
}

FETCH="0"
JSON_OUTPUT="0"
THIRDPARTY_NAME="${THIRDPARTY_NAME:-}"
STRICT="${STRICT:-0}"
CONFIG_FILE="${UIQ_UPSTREAM_SOURCE_CONFIG:-configs/upstream/source.yaml}"
UPSTREAM_REMOTE=""
UPSTREAM_BRANCH=""
UPSTREAM_BRANCH_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fetch)
      FETCH="1"
      shift
      ;;
    --json)
      JSON_OUTPUT="1"
      shift
      ;;
    --thirdparty)
      if [[ $# -lt 2 ]]; then
        echo "error: --thirdparty requires a name" >&2
        exit 1
      fi
      THIRDPARTY_NAME="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --upstream-branch)
      if [[ $# -lt 2 ]]; then
        echo "error: --upstream-branch requires a branch name" >&2
        exit 1
      fi
      UPSTREAM_BRANCH="$2"
      UPSTREAM_BRANCH_OVERRIDE="$2"
      shift 2
      ;;
    --config)
      if [[ $# -lt 2 ]]; then
        echo "error: --config requires a file path" >&2
        exit 1
      fi
      CONFIG_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      echo "error: unexpected positional argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$STRICT" != "0" && "$STRICT" != "1" ]]; then
  echo "error: STRICT must be 0 or 1" >&2
  exit 1
fi

if [[ "$STRICT" -eq 1 && -z "$THIRDPARTY_NAME" ]]; then
  echo "error: --strict requires --thirdparty <name>" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git worktree" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "error: upstream source config not found: $CONFIG_FILE" >&2
  exit 1
fi

UPSTREAM_REMOTE="$(read_yaml_key "remoteName" "$CONFIG_FILE")"
CONFIG_BRANCH="$(read_yaml_key "branch" "$CONFIG_FILE")"

if [[ -z "$UPSTREAM_REMOTE" ]]; then
  echo "error: missing required key 'remoteName' in $CONFIG_FILE" >&2
  exit 1
fi

if [[ -z "$CONFIG_BRANCH" ]]; then
  echo "error: missing required key 'branch' in $CONFIG_FILE" >&2
  exit 1
fi

UPSTREAM_BRANCH="${UPSTREAM_BRANCH_OVERRIDE:-$CONFIG_BRANCH}"

if [[ "$FETCH" == "1" ]]; then
  git fetch origin --prune
  if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git fetch "$UPSTREAM_REMOTE" --prune
  fi
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
worktree_count="$(git worktree list --porcelain | awk '/^worktree /{n++} END{print n+0}')"
local_branch_count="$(git for-each-ref --format='%(refname:short)' refs/heads | wc -l | tr -d ' ')"
remote_branch_count="$(git for-each-ref --format='%(refname:short)' refs/remotes/origin | wc -l | tr -d ' ')"

status_output="$(git status --porcelain=v1)"
staged_count="$(printf '%s\n' "$status_output" | awk 'substr($0,1,1)!=" " && substr($0,1,1)!="?" && length($0)>0 {n++} END{print n+0}')"
unstaged_count="$(printf '%s\n' "$status_output" | awk 'substr($0,2,1)!=" " && substr($0,1,1)!="?" && length($0)>0 {n++} END{print n+0}')"
untracked_count="$(printf '%s\n' "$status_output" | awk '/^\?\?/ {n++} END{print n+0}')"

main_ahead="N/A"
main_behind="N/A"
if git show-ref --verify --quiet refs/heads/main && git show-ref --verify --quiet refs/remotes/origin/main; then
  read -r main_behind main_ahead < <(git rev-list --left-right --count origin/main...main)
fi

upstream_label="N/A"
upstream_ahead="N/A"
upstream_behind="N/A"
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  upstream_label="$(git rev-parse --abbrev-ref '@{upstream}')"
  read -r upstream_behind upstream_ahead < <(git rev-list --left-right --count "@{upstream}...HEAD")
fi

upstream_configured="false"
upstream_url="N/A"
upstream_ref="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
upstream_ref_present="false"
head_vs_upstream_branch_ahead="N/A"
head_vs_upstream_branch_behind="N/A"
if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  upstream_configured="true"
  upstream_url="$(git remote get-url "$UPSTREAM_REMOTE")"
  if git show-ref --verify --quiet "refs/remotes/${upstream_ref}"; then
    upstream_ref_present="true"
    read -r head_vs_upstream_branch_behind head_vs_upstream_branch_ahead < <(git rev-list --left-right --count "${upstream_ref}...HEAD")
  fi
fi

rerere_enabled="$(git config --default false --bool rerere.enabled)"
rerere_autoupdate="$(git config --default false --bool rerere.autoupdate)"

upstream_mode="dependency-governance-first"
if [[ "$upstream_configured" == "true" && "$upstream_ref_present" == "true" ]]; then
  upstream_mode="materialized-upstream"
fi

if [[ "$JSON_OUTPUT" == "1" ]]; then
  export ROOT_DIR current_branch worktree_count local_branch_count remote_branch_count
  export main_ahead main_behind upstream_label upstream_ahead upstream_behind
  export upstream_configured upstream_url upstream_ref upstream_ref_present
  export head_vs_upstream_branch_ahead head_vs_upstream_branch_behind
  export rerere_enabled rerere_autoupdate staged_count unstaged_count untracked_count upstream_mode
  python3 - <<'PY'
import json
import os


def parse_int(value: str):
    if value in ("N/A", "", None):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def parse_optional(value: str):
    return None if value in ("N/A", "", None) else value


data = {
    "repo": os.environ["ROOT_DIR"],
    "mode": os.environ["upstream_mode"],
    "current_branch": os.environ["current_branch"],
    "worktrees": parse_int(os.environ["worktree_count"]),
    "branches": {
        "local": parse_int(os.environ["local_branch_count"]),
        "origin": parse_int(os.environ["remote_branch_count"]),
    },
    "dirty_summary": {
        "staged": parse_int(os.environ["staged_count"]),
        "unstaged": parse_int(os.environ["unstaged_count"]),
        "untracked": parse_int(os.environ["untracked_count"]),
    },
    "main_vs_origin_main": {
        "ahead": parse_int(os.environ["main_ahead"]),
        "behind": parse_int(os.environ["main_behind"]),
    },
    "head_vs_tracking": {
        "tracking_ref": parse_optional(os.environ["upstream_label"]),
        "ahead": parse_int(os.environ["upstream_ahead"]),
        "behind": parse_int(os.environ["upstream_behind"]),
    },
    "upstream": {
        "configured": parse_bool(os.environ["upstream_configured"]),
        "url": parse_optional(os.environ["upstream_url"]),
        "branch": parse_optional(os.environ["upstream_ref"]),
        "ref_present": parse_bool(os.environ["upstream_ref_present"]),
        "head_vs_branch": {
            "ahead": parse_int(os.environ["head_vs_upstream_branch_ahead"]),
            "behind": parse_int(os.environ["head_vs_upstream_branch_behind"]),
        },
    },
    "rerere": {
        "enabled": parse_bool(os.environ["rerere_enabled"]),
        "autoupdate": parse_bool(os.environ["rerere_autoupdate"]),
    },
}

print(json.dumps(data, ensure_ascii=False, indent=2))
PY
  exit 0
fi

printf 'repo: %s\n' "$ROOT_DIR"
printf 'mode: %s\n' "$upstream_mode"
printf 'current_branch: %s\n' "$current_branch"
printf 'worktrees: %s\n' "$worktree_count"
printf 'local_branches: %s\n' "$local_branch_count"
printf 'origin_branches: %s\n' "$remote_branch_count"
printf 'main_vs_origin_main: ahead=%s behind=%s\n' "$main_ahead" "$main_behind"
printf 'head_vs_upstream(%s): ahead=%s behind=%s\n' "$upstream_label" "$upstream_ahead" "$upstream_behind"
printf 'upstream_remote: configured=%s url=%s branch=%s ref_present=%s\n' "$upstream_configured" "$upstream_url" "$upstream_ref" "$upstream_ref_present"
printf 'head_vs_upstream_branch: ahead=%s behind=%s\n' "$head_vs_upstream_branch_ahead" "$head_vs_upstream_branch_behind"
printf 'rerere: enabled=%s autoupdate=%s\n' "$rerere_enabled" "$rerere_autoupdate"
printf 'dirty_summary: staged=%s unstaged=%s untracked=%s\n' "$staged_count" "$unstaged_count" "$untracked_count"

if [[ -n "$THIRDPARTY_NAME" ]]; then
  local_branch="thirdparty/${THIRDPARTY_NAME}/local"
  upstream_branch="thirdparty/${THIRDPARTY_NAME}/upstream"
  sync_glob="refs/heads/thirdparty/${THIRDPARTY_NAME}/sync-*"
  missing_required=0

  if git show-ref --verify --quiet "refs/heads/${local_branch}"; then
    printf 'thirdparty_local_branch: present (%s)\n' "$local_branch"
  else
    printf 'thirdparty_local_branch: missing (%s)\n' "$local_branch"
    missing_required=1
  fi

  if git show-ref --verify --quiet "refs/heads/${upstream_branch}"; then
    printf 'thirdparty_upstream_branch: present (%s)\n' "$upstream_branch"
  else
    printf 'thirdparty_upstream_branch: missing (%s)\n' "$upstream_branch"
    missing_required=1
  fi

  sync_count="$(git for-each-ref --format='%(refname:short)' "$sync_glob" | wc -l | tr -d ' ')"
  printf 'thirdparty_sync_branches: %s\n' "$sync_count"

  latest_sync_branch="$(git for-each-ref --format='%(refname:short)' --sort=-creatordate "$sync_glob" | head -n 1)"
  if [[ -n "$latest_sync_branch" ]]; then
    printf 'thirdparty_latest_sync_branch: %s\n' "$latest_sync_branch"
  fi

  if git show-ref --verify --quiet "refs/heads/${local_branch}" && git show-ref --verify --quiet "refs/heads/${upstream_branch}"; then
    read -r upstream_only local_only < <(git rev-list --left-right --count "${upstream_branch}...${local_branch}")
    printf 'thirdparty_divergence(%s...%s): upstream_only=%s local_only=%s\n' "$upstream_branch" "$local_branch" "$upstream_only" "$local_only"
  fi

  if [[ -n "$latest_sync_branch" ]] && git show-ref --verify --quiet "refs/heads/${upstream_branch}"; then
    read -r sync_behind sync_ahead < <(git rev-list --left-right --count "${upstream_branch}...${latest_sync_branch}")
    printf 'thirdparty_sync_vs_upstream(%s): ahead=%s behind=%s\n' "$latest_sync_branch" "$sync_ahead" "$sync_behind"
  fi

  if [[ "$STRICT" -eq 1 && "$missing_required" -ne 0 ]]; then
    echo "error: thirdparty branch model incomplete for --thirdparty $THIRDPARTY_NAME" >&2
    exit 2
  fi
fi
