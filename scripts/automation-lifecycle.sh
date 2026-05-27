#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/automation-lifecycle.sh [options]

Options:
  --cycle-id <id>        Explicit cycle id (default: UTC timestamp)
  --ttl-hours <hours>    Recycle directories older than this TTL (default: 24)
  --seed-password <pwd>  Seed password written into FLOW_INPUT (default: generate random)
  --run-cmd "<command>"  Optional command executed inside isolated run dir
  --dry-run              Print planned actions without deleting old dirs
  -h, --help             Show this help
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="$REPO_ROOT/.runtime-cache/automation/lifecycle"

CYCLE_ID=""
TTL_HOURS=24
RUN_CMD=""
DRY_RUN=0
SEED_PASSWORD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cycle-id)
      CYCLE_ID="${2:-}"
      shift 2
      ;;
    --ttl-hours)
      TTL_HOURS="${2:-}"
      shift 2
      ;;
    --run-cmd)
      RUN_CMD="${2:-}"
      shift 2
      ;;
    --seed-password)
      SEED_PASSWORD="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[automation-lifecycle] unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -d '\n' | tr '/+' 'AZ' | cut -c1-24
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(18))
PY
    return
  fi
  printf 'seed-%s-%s' "$CYCLE_ID" "$$"
}

if ! [[ "$TTL_HOURS" =~ ^[0-9]+$ ]] || [[ "$TTL_HOURS" -lt 1 ]]; then
  echo "[automation-lifecycle] --ttl-hours must be a positive integer" >&2
  exit 2
fi

if [[ -z "$CYCLE_ID" ]]; then
  CYCLE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
fi

mkdir -p "$RUNTIME_ROOT"
RUN_DIR="$RUNTIME_ROOT/$CYCLE_ID"
mkdir -p "$RUN_DIR"

if command -v shasum >/dev/null 2>&1; then
  IDEM_SHORT="$(printf '%s' "$CYCLE_ID" | shasum -a 256 | awk '{print substr($1,1,16)}')"
else
  IDEM_SHORT="$(printf '%s' "$CYCLE_ID" | openssl dgst -sha256 | awk '{print substr($2,1,16)}')"
fi

SEED_FILE="$RUN_DIR/seed.json"
META_FILE="$RUN_DIR/meta.json"
EMAIL="replay+${IDEM_SHORT}@example.com"
IDEMPOTENCY_KEY="wave-c3-${IDEM_SHORT}"
PASSWORD="${SEED_PASSWORD:-${AUTOMATION_SEED_PASSWORD:-}}"
if [[ -z "$PASSWORD" ]]; then
  PASSWORD="$(generate_password)"
fi

cat >"$SEED_FILE" <<EOF
{
  "cycleId": "$CYCLE_ID",
  "email": "$EMAIL",
  "password": "$PASSWORD",
  "idempotencyKey": "$IDEMPOTENCY_KEY"
}
EOF

cat >"$META_FILE" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "seedFile": "$SEED_FILE",
  "runDir": "$RUN_DIR"
}
EOF

echo "[automation-lifecycle] seeded: $SEED_FILE"
echo "[automation-lifecycle] isolated run dir: $RUN_DIR"
echo "[automation-lifecycle] idempotency key: $IDEMPOTENCY_KEY"

if [[ -n "$RUN_CMD" ]]; then
  echo "[automation-lifecycle] executing in isolated dir: $RUN_CMD"
  (
    cd "$RUN_DIR"
    FLOW_INPUT="$SEED_FILE" AUTOMATION_IDEMPOTENCY_KEY="$IDEMPOTENCY_KEY" bash -lc "$RUN_CMD"
  )
fi

EXPIRED_MINUTES=$((TTL_HOURS * 60))
EXPIRED_DIRS=()
while IFS= read -r dir; do
  EXPIRED_DIRS+=("$dir")
done < <(find "$RUNTIME_ROOT" -mindepth 1 -maxdepth 1 -type d -mmin "+$EXPIRED_MINUTES" | sort)

if [[ ${#EXPIRED_DIRS[@]} -eq 0 ]]; then
  echo "[automation-lifecycle] recycle: no expired run dirs"
  exit 0
fi

for dir in "${EXPIRED_DIRS[@]}"; do
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[automation-lifecycle] [dry-run] recycle $dir"
  else
    rm -rf "$dir"
    echo "[automation-lifecycle] recycled $dir"
  fi
done
