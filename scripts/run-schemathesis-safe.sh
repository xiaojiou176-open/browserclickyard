#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/lib/target-allowlist.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/run-schemathesis-safe.sh run <schema-location> --url <api-base-url> [options]

Safety:
  By default only localhost/127.0.0.1/::1 targets are allowed.
  Set ALLOW_REMOTE_TARGETS=true or pass --allow-remote to override.

Examples:
  bash scripts/run-schemathesis-safe.sh run contracts/openapi/api.yaml --url http://127.0.0.1:8000
  bash scripts/run-schemathesis-safe.sh --allow-remote run https://example.com/openapi.json
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

tool_args=()
allow_remote_once=0
if_help=0
url_targets=()
location_candidate=""
expect_url_value=0
seen_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-remote)
      allow_remote_once=1
      shift
      ;;
    --help|-h)
      if_help=1
      tool_args+=("$1")
      shift
      ;;
    --url|-u)
      expect_url_value=1
      tool_args+=("$1")
      shift
      ;;
    *)
      if [[ "$expect_url_value" -eq 1 ]]; then
        url_targets+=("$1")
        expect_url_value=0
      elif [[ "$seen_run" -eq 1 && -z "$location_candidate" && "$1" != -* ]]; then
        location_candidate="$1"
      elif [[ "$1" == "run" ]]; then
        seen_run=1
      fi
      tool_args+=("$1")
      shift
      ;;
  esac
done

if [[ "$allow_remote_once" -eq 1 ]]; then
  export ALLOW_REMOTE_TARGETS=true
fi

if [[ "$if_help" -eq 1 ]]; then
  exec uv run --extra dev schemathesis "${tool_args[@]}"
fi

if [[ -n "$location_candidate" ]] && [[ "$location_candidate" =~ ^https?:// ]]; then
  url_targets+=("$location_candidate")
fi

if [[ ${#url_targets[@]} -eq 0 ]]; then
  cat >&2 <<'EOF'
error: no API target URL found for safety validation.
Provide --url/-u, or use URL schema location with 'run <https://...>'.
EOF
  exit 2
fi

for target in "${url_targets[@]}"; do
  uiq_assert_target_allowed "$target"
done

exec uv run --extra dev schemathesis "${tool_args[@]}"
