#!/usr/bin/env bash
set -euo pipefail

uiq_allow_remote_targets_enabled() {
  case "${ALLOW_REMOTE_TARGETS:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

uiq_extract_urls_from_text() {
  local content="${1:-}"
  node -e '
const input = process.argv[1] ?? "";
const regex = /https?:\/\/[^\s"'"'"'<>`]+/g;
const matches = input.match(regex) ?? [];
const unique = [...new Set(matches)];
for (const item of unique) {
  process.stdout.write(item + "\n");
}
' "$content"
}

uiq_assert_target_allowed() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "error: target URL is empty" >&2
    return 2
  fi

  if uiq_allow_remote_targets_enabled; then
    return 0
  fi

  local hostname
  hostname="$(node -e '
const raw = process.argv[1];
try {
  const normalized = raw.includes("://") ? raw : "http://" + raw;
  const url = new URL(normalized);
  process.stdout.write(url.hostname);
} catch {
  process.exit(2);
}
' "$target")" || {
    echo "error: invalid URL for target validation: $target" >&2
    return 2
  }

  case "$hostname" in
    localhost|127.0.0.1|::1|\[::1\]) return 0 ;;
    *)
      cat >&2 <<EOF
error: blocked non-local target '$target' (host: $hostname)
Only localhost/127.0.0.1/::1 are allowed by default.
Set ALLOW_REMOTE_TARGETS=true (or pass --allow-remote on wrapper scripts) to override.
EOF
      return 3
      ;;
  esac
}
