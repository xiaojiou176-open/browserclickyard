#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAFE_BASE="${TMPDIR:-/tmp}/uiq-safe-workdirs"
SAFE_DIR="${SAFE_BASE}/storybook-build-mirror"
# shellcheck source=/dev/null
source "${ROOT_DIR}/scripts/lib/node-toolchain.sh"
uiq_export_node_env "${ROOT_DIR}"

cleanup() {
  rm -rf "${SAFE_DIR}"
}

trap cleanup EXIT

mkdir -p "${SAFE_BASE}"
rm -rf "${SAFE_DIR}"
mkdir -p "${SAFE_DIR}"

rsync -a --delete \
  --exclude ".git" \
  --exclude ".runtime-cache" \
  --exclude "node_modules" \
  --exclude "tests/web-harness/storybook-static" \
  "${ROOT_DIR}/" "${SAFE_DIR}/"

ln -s "${UIQ_NODE_MODULES_DIR}" "${SAFE_DIR}/node_modules"
mkdir -p "${SAFE_DIR}/tests/web-harness"
ln -s "../../node_modules" "${SAFE_DIR}/tests/web-harness/node_modules"

(
  cd "${SAFE_DIR}"
  pnpm exec storybook build -c tests/web-harness/storybook -o tests/web-harness/storybook-static
)

rm -rf "${ROOT_DIR}/tests/web-harness/storybook-static"
cp -R "${SAFE_DIR}/tests/web-harness/storybook-static" "${ROOT_DIR}/tests/web-harness/storybook-static"
