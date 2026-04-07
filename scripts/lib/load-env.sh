#!/usr/bin/env bash
set -euo pipefail

load_env_files() {
  local root_dir="$1"
  local file

  for file in "$root_dir/.env" "$root_dir/.env.local"; do
    [[ -f "$file" ]] || continue

    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" == *"="* ]] || continue

      local key="${line%%=*}"
      local value="${line#*=}"

      key="$(printf '%s' "$key" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue

      # Preserve existing shell/CI env values.
      if [[ -n "${!key-}" ]]; then
        continue
      fi

      # Trim leading/trailing spaces from unquoted values.
      if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
        value="${value:1:${#value}-2}"
      else
        value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      fi

      export "$key=$value"
    done <"$file"
  done
}
