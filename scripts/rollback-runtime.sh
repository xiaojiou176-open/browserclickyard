#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: ./scripts/rollback-runtime.sh <backup-file.tgz>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_FILE="$1"
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "backup file not found: $BACKUP_FILE"
  exit 1
fi

mkdir -p .runtime-cache
while IFS= read -r entry; do
  if [[ "$entry" = /* ]] || [[ "$entry" == *".."* ]] || [[ "$entry" != .runtime-cache/* ]]; then
    echo "unsafe archive entry detected: $entry"
    exit 1
  fi
done < <(tar -tzf "$BACKUP_FILE")
tar -xzf "$BACKUP_FILE" -C . --no-same-owner --no-same-permissions
echo "rollback completed from: $BACKUP_FILE"
