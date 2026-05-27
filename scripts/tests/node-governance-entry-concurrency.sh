#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"

uiq_export_node_env "$ROOT_DIR"
uiq_repair_shared_module_links "$ROOT_DIR"
export UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1

tmp_dir="$(mktemp -d ".runtime-cache/node-governance-entry-concurrency.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

long_script="$tmp_dir/long-check.cjs"
short_script="$tmp_dir/short-check.cjs"

cat > "$long_script" <<'EOF'
const fs = require("node:fs");

const target = "node_modules/yaml/dist/compose/compose-doc.js";
const sleepView = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(sleepView, 0, 0, ms);
}
function waitForTarget(label, timeoutMs = 2000, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (fs.existsSync(target)) {
      return true;
    }
    sleep(intervalMs);
  }
  console.error(`[node-governance-entry-concurrency] missing ${label}: ${target}`);
  process.exit(1);
}

waitForTarget("before wait");

setTimeout(() => {
  waitForTarget("after concurrent cleanup");
  console.log("[node-governance-entry-concurrency] PASS");
  process.exit(0);
}, 1500);
EOF

cat > "$short_script" <<'EOF'
const fs = require("node:fs");

const target = "node_modules/yaml/dist/compose/compose-doc.js";
const sleepView = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) {
  Atomics.wait(sleepView, 0, 0, ms);
}
function waitForTarget(label, timeoutMs = 2000, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (fs.existsSync(target)) {
      return true;
    }
    sleep(intervalMs);
  }
  console.error(`[node-governance-entry-concurrency] missing ${label}: ${target}`);
  process.exit(1);
}

waitForTarget("during short check");
console.log("[node-governance-entry-concurrency] short path PASS");
EOF

bash scripts/lib/node-governance-entry.sh "$long_script" >"$tmp_dir/long.log" 2>&1 &
long_pid="$!"

sleep 0.5

if ! bash scripts/lib/node-governance-entry.sh "$short_script" >"$tmp_dir/short.log" 2>&1; then
  cat "$tmp_dir/short.log" >&2
  wait "$long_pid" || true
  cat "$tmp_dir/long.log" >&2
  exit 1
fi

if ! wait "$long_pid"; then
  cat "$tmp_dir/short.log" >&2
  cat "$tmp_dir/long.log" >&2
  exit 1
fi

cat "$tmp_dir/short.log"
cat "$tmp_dir/long.log"

usage_dir="$ROOT_DIR/node_modules/.governance-entry-users"
if [[ -d "$usage_dir" ]] && find "$usage_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "[node-governance-entry-concurrency] expected no stale governance-entry usage tokens" >&2
  find "$usage_dir" -mindepth 1 -maxdepth 1 -print >&2 || true
  exit 1
fi
