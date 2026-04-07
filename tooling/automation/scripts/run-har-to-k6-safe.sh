#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/lib/target-allowlist.sh"

run_har_to_k6_cli() {
  pnpm --dir "$REPO_ROOT/tooling/automation" exec har-to-k6 "$@"
}

usage() {
  cat <<'EOF'
Usage:
  bash tooling/automation/scripts/run-har-to-k6-safe.sh [--input <har-file>] [options]

Options:
  --input <har-file>   Explicit HAR input file.
  --target-url <url>   Additional explicit target URL for allowlist validation.
  --allow-remote       Equivalent to ALLOW_REMOTE_TARGETS=true for this invocation.
  --help               Show this help.

All remaining args are forwarded to har-to-k6 CLI.
Example:
  bash tooling/automation/scripts/run-har-to-k6-safe.sh \
    --input .runtime-cache/automation/session.har \
    -- -o tooling/automation/load/generated-k6.js
EOF
}

input_file=""
target_url=""
tool_args=()
help_requested=0

if [[ "${1:-}" == "--" ]]; then
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      input_file="${2:-}"
      shift 2
      ;;
    --target|--target-url)
      target_url="${2:-}"
      shift 2
      ;;
    --allow-remote)
      export ALLOW_REMOTE_TARGETS=true
      shift
      ;;
    --help|-h)
      usage
      run_har_to_k6_cli --help
      exit $?
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        if [[ "$1" == "--help" || "$1" == "-h" ]]; then
          help_requested=1
        fi
        tool_args+=("$1")
        shift
      done
      ;;
    *)
      if [[ "$1" == "--help" || "$1" == "-h" ]]; then
        help_requested=1
      fi
      tool_args+=("$1")
      shift
      ;;
  esac
done

if [[ "$help_requested" -eq 1 && -z "$input_file" ]]; then
  run_har_to_k6_cli --help
  exit $?
fi

if [[ -z "$input_file" ]]; then
  for arg in "${tool_args[@]-}"; do
    [[ -z "$arg" ]] && continue
    if [[ "$arg" != -* ]]; then
      input_file="$arg"
      break
    fi
  done
fi

targets=()
if [[ -n "$target_url" ]]; then
  targets+=("$target_url")
fi

if [[ -n "$input_file" ]]; then
  if [[ ! -f "$input_file" ]]; then
    echo "error: HAR file not found: $input_file" >&2
    exit 2
  fi
  while IFS= read -r detected; do
    [[ -n "$detected" ]] && targets+=("$detected")
  done < <(node -e '
const fs = require("node:fs");
const path = process.argv[1];
const raw = fs.readFileSync(path, "utf8");
const data = JSON.parse(raw);
const entries = data?.log?.entries ?? [];
const urls = new Set();
for (const entry of entries) {
  const url = entry?.request?.url;
  if (typeof url === "string" && url.length > 0) {
    urls.add(url);
  }
}
for (const url of urls) {
  console.log(url);
}
' "$input_file")
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  cat >&2 <<'EOF'
error: no target URL detected.
Pass --input with a HAR file that contains request URLs,
or provide --target-url explicitly for safety validation.
EOF
  exit 2
fi

for target in "${targets[@]}"; do
  uiq_assert_target_allowed "$target"
done

if [[ -n "$input_file" ]]; then
  has_positional=0
  for arg in "${tool_args[@]-}"; do
    [[ -z "$arg" ]] && continue
    if [[ "$arg" == "$input_file" ]]; then
      has_positional=1
      break
    fi
  done
  if [[ "$has_positional" -eq 0 ]]; then
    tool_args=("$input_file" "${tool_args[@]-}")
  fi
fi

run_har_to_k6_cli "${tool_args[@]}"
