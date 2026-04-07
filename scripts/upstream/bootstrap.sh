#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/upstream/bootstrap.sh [options]

Options:
  --strict                  Require UIQ_UPSTREAM_REPO_URL (hard-fail if missing).
  --config <path>           Upstream source config file (default: configs/upstream/source.yaml).
  -h, --help                Show help.

Environment:
  UIQ_UPSTREAM_REPO_URL     Required in strict mode. Upstream remote URL.
  UIQ_UPSTREAM_BRANCH       Optional branch override (default from config, then main).
  UIQ_UPSTREAM_SOURCE_CONFIG Optional config path override.
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

to_bool() {
  local raw="${1:-false}"
  case "${raw,,}" in
    1|true|yes|on) echo "true" ;;
    *) echo "false" ;;
  esac
}

STRICT_MODE="${UIQ_UPSTREAM_BOOTSTRAP_STRICT:-0}"
CONFIG_FILE="${UIQ_UPSTREAM_SOURCE_CONFIG:-configs/upstream/source.yaml}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT_MODE="1"
      shift
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
    *)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "error: upstream source config not found: $CONFIG_FILE" >&2
  exit 1
fi

remote_name="$(read_yaml_key "remoteName" "$CONFIG_FILE")"
CONFIG_BRANCH="$(read_yaml_key "branch" "$CONFIG_FILE")"
config_required="$(read_yaml_key "required" "$CONFIG_FILE")"

UPSTREAM_REMOTE="${remote_name:-upstream}"
UPSTREAM_BRANCH="${UIQ_UPSTREAM_BRANCH:-${CONFIG_BRANCH:-main}}"
UPSTREAM_URL="${UIQ_UPSTREAM_REPO_URL:-}"
REQUIRED_FLAG="$(to_bool "${config_required:-true}")"
strict_flag="$(to_bool "$STRICT_MODE")"

if [[ "$strict_flag" == "true" && -z "$UPSTREAM_URL" ]]; then
  echo "error: strict mode requires UIQ_UPSTREAM_REPO_URL to be set" >&2
  echo "hint: export UIQ_UPSTREAM_REPO_URL=<git-url> and retry" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git worktree" >&2
  exit 1
fi

if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  CURRENT_URL="$(git remote get-url "$UPSTREAM_REMOTE")"
  if [[ -n "$UPSTREAM_URL" && "$CURRENT_URL" != "$UPSTREAM_URL" ]]; then
    echo "error: remote '$UPSTREAM_REMOTE' already points to a different URL" >&2
    echo "current: $CURRENT_URL" >&2
    echo "expected: $UPSTREAM_URL" >&2
    echo "remediation: update manually with 'git remote set-url $UPSTREAM_REMOTE <url>' after confirmation" >&2
    exit 1
  fi
else
  if [[ -z "$UPSTREAM_URL" ]]; then
    if [[ "$REQUIRED_FLAG" == "true" || "$strict_flag" == "true" ]]; then
      echo "error: remote '$UPSTREAM_REMOTE' is missing and UIQ_UPSTREAM_REPO_URL is empty" >&2
      echo "remediation: export UIQ_UPSTREAM_REPO_URL=<git-url> and rerun bootstrap" >&2
      exit 1
    fi
    echo "warning: remote '$UPSTREAM_REMOTE' missing, config.required=false -> skip binding" >&2
    exit 0
  fi
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

git fetch "$UPSTREAM_REMOTE" --prune
UPSTREAM_REF="refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
if ! git show-ref --verify --quiet "$UPSTREAM_REF"; then
  echo "error: upstream ref not found after fetch: ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >&2
  echo "remediation: verify UIQ_UPSTREAM_BRANCH or upstream branch existence" >&2
  exit 1
fi

echo "[upstream-bootstrap] remote=${UPSTREAM_REMOTE}"
echo "[upstream-bootstrap] branch=${UPSTREAM_BRANCH}"
echo "[upstream-bootstrap] ref_present=true"
echo "[upstream-bootstrap] strict=${strict_flag}"
