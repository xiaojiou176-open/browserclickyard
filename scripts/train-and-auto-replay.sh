#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/load-env.sh"
load_env_files "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found"
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "error: missing uv; run './scripts/setup.sh' first"
  exit 1
fi

read -r -p "Initial URL (example: https://target.site/register): " START_URL
if [[ -z "${START_URL:-}" ]]; then
  echo "error: START_URL required"
  exit 1
fi

read -r -p "Success page selector (optional): " SUCCESS_SELECTOR

echo
echo "[Phase 1] Manual teaching run started."
echo "Complete the full journey in the opened browser: fill email/password -> email verification -> final redirect."
(
  cd tooling/automation
  BASE_URL="${BASE_URL:-http://127.0.0.1:17380}" \
  START_URL="$START_URL" \
  SUCCESS_SELECTOR="$SUCCESS_SELECTOR" \
  HEADLESS=false \
  pnpm record:manual
)

echo
echo "[Phase 2] Enter the account details for the next automated registration run."
read -r -p "New email: " FLOW_INPUT
if [[ -z "${FLOW_INPUT:-}" ]]; then
  echo "error: email required"
  exit 1
fi
read -r -s -p "New password: " FLOW_SECRET_INPUT
echo
if [[ -z "${FLOW_SECRET_INPUT:-}" ]]; then
  echo "error: password required"
  exit 1
fi

echo
echo "OTP will be read automatically from Gmail over IMAP. Make sure these are configured:"
echo "  GMAIL_IMAP_USER / GMAIL_IMAP_PASSWORD"
echo
echo "[Phase 3] AI auto-replay started."
(
  cd tooling/automation
  START_URL="$START_URL" \
  FLOW_INPUT="$FLOW_INPUT" \
  FLOW_SECRET_INPUT="$FLOW_SECRET_INPUT" \
  FLOW_OTP_PROVIDER="${FLOW_OTP_PROVIDER:-gmail}" \
  HEADLESS="${HEADLESS:-false}" \
  pnpm replay-flow
)

echo
echo "done"
echo "artifacts: .runtime-cache/automation/<latest-session>/"
