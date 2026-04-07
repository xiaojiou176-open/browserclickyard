#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE_DEFAULT="${UIQ_PROFILE:-pr}"
TARGET_DEFAULT="${UIQ_TARGET:-web.local}"

resolve_base_url() {
  if [[ -n "${UIQ_BASE_URL:-}" ]]; then
    echo "$UIQ_BASE_URL"
    return 0
  fi
  if [[ -n "${BASE_URL:-}" ]]; then
    echo "$BASE_URL"
    return 0
  fi

  local frontend_port_file=".runtime-cache/dev/frontend.port"
  if [[ -f "$frontend_port_file" ]]; then
    local port
    port="$(cat "$frontend_port_file")"
    if [[ "$port" =~ ^[0-9]+$ ]]; then
      echo "http://127.0.0.1:${port}"
      return 0
    fi
  fi

  echo "error: unable to resolve shared web runtime URL" >&2
  echo "hint: run ./scripts/dev-up.sh first, or set UIQ_BASE_URL/BASE_URL" >&2
  return 1
}

BASE_URL_RESOLVED="$(resolve_base_url)"
echo "info: run against shared runtime: $BASE_URL_RESOLVED"

pnpm uiq run \
  --profile "$PROFILE_DEFAULT" \
  --target "$TARGET_DEFAULT" \
  --base-url "$BASE_URL_RESOLVED" \
  --autostart-target false \
  "$@"
