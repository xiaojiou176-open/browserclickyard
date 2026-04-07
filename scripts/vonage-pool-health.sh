#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_KEY="${VONAGE_API_KEY:-}"
API_SECRET="${VONAGE_API_SECRET:-}"
MIN_BALANCE="${VONAGE_MIN_BALANCE:-1}"
POOL_NUMBERS_RAW="${VONAGE_POOL_NUMBERS:-}"

if [[ -z "$API_KEY" || -z "$API_SECRET" ]]; then
  echo "error: set VONAGE_API_KEY and VONAGE_API_SECRET"
  exit 1
fi

RUNTIME_DIR=".runtime-cache/logs/vonage"
mkdir -p "$RUNTIME_DIR"
REPORT_PATH="$RUNTIME_DIR/pool-health-$(date +%Y%m%d-%H%M%S).json"

AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$API_KEY" "$API_SECRET" | base64 | tr -d '\n')"
BALANCE_JSON="$(
  curl -fsS \
    -H "$AUTH_HEADER" \
    -H "Accept: application/json" \
    "https://rest.nexmo.com/account/get-balance"
)"
NUMBERS_JSON="$(
  curl -fsS \
    -H "$AUTH_HEADER" \
    -H "Accept: application/json" \
    --get \
    --data-urlencode "size=1000" \
    "https://rest.nexmo.com/account/numbers"
)"

python3 - "$BALANCE_JSON" "$NUMBERS_JSON" "$MIN_BALANCE" "$POOL_NUMBERS_RAW" "$REPORT_PATH" <<'PY'
import json
import sys
from datetime import datetime, timezone

balance_raw, numbers_raw, min_balance_raw, pool_raw, report_path = sys.argv[1:6]
balance_payload = json.loads(balance_raw)
numbers_payload = json.loads(numbers_raw)
min_balance = float(min_balance_raw)
expected_numbers = [x.strip().lstrip("+") for x in pool_raw.split(",") if x.strip()]

actual_balance = float(balance_payload.get("value") or 0.0)
owned_entries = numbers_payload.get("numbers", [])
owned_numbers = []
for item in owned_entries:
    if not isinstance(item, dict):
        continue
    msisdn = str(item.get("msisdn") or "").strip().lstrip("+")
    if msisdn:
        owned_numbers.append(msisdn)

missing_numbers = [n for n in expected_numbers if n not in owned_numbers]
status = "ok"
reasons = []
if actual_balance < min_balance:
    status = "degraded"
    reasons.append(f"low_balance<{min_balance}")
if missing_numbers:
    status = "degraded"
    reasons.append("missing_pool_numbers")

report = {
    "status": status,
    "checked_at": datetime.now(timezone.utc).isoformat(),
    "balance": actual_balance,
    "min_balance": min_balance,
    "owned_count": len(owned_numbers),
    "expected_pool_count": len(expected_numbers),
    "missing_pool_numbers": missing_numbers,
    "reasons": reasons,
}
with open(report_path, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False))
if status != "ok":
    sys.exit(2)
PY

echo "report: $REPORT_PATH"
