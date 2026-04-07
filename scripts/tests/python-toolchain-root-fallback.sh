#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

FAKE_BIN_DIR="$TMP_DIR/bin"
FAKE_UV_LOG="$TMP_DIR/uv.log"
mkdir -p "$FAKE_BIN_DIR"

cat >"$FAKE_BIN_DIR/uv" <<'EOF_UV'
#!/usr/bin/env bash
set -euo pipefail
printf 'PWD=%s\nARGS=%s\n' "$PWD" "$*" >"${FAKE_UV_LOG:?}"
exit 0
EOF_UV
chmod +x "$FAKE_BIN_DIR/uv"

export PATH="$FAKE_BIN_DIR:$PATH"
export FAKE_UV_LOG
export UIQ_PYTHON_ENV_ROOT="$TMP_DIR/python-env"

# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"

uiq_sync_python_env "$ROOT_DIR" "$ROOT_DIR/services/api"

if [[ ! -f "$FAKE_UV_LOG" ]]; then
  echo "expected fake uv log to be created" >&2
  exit 1
fi

if ! grep -Fq "PWD=$ROOT_DIR" "$FAKE_UV_LOG"; then
  echo "expected uv sync fallback to execute from repo root" >&2
  cat "$FAKE_UV_LOG" >&2
  exit 1
fi

if ! grep -Fq -- "--no-install-project" "$FAKE_UV_LOG"; then
  echo "expected root fallback sync to skip installing the repo root project" >&2
  cat "$FAKE_UV_LOG" >&2
  exit 1
fi

echo "python-toolchain root fallback checks passed"
