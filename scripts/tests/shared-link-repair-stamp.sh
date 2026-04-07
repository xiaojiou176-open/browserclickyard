#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d)"
container_shortcut_tmp_dir="$(mktemp -d)"
root_node_modules="$ROOT_DIR/node_modules"
mkdir -p "$ROOT_DIR/.runtime-cache"
backup_dir="$(mktemp -d ".runtime-cache/shared-link-repair-stamp-backup.XXXXXX")"
backup_root_node_modules="$backup_dir/node_modules"
had_authoritative_root=0

if [[ -d "$root_node_modules" && ! -L "$root_node_modules" ]]; then
  mv "$root_node_modules" "$backup_root_node_modules"
  had_authoritative_root=1
fi

cleanup() {
  uiq_cleanup_root_node_artifacts "$ROOT_DIR"
  if [[ "$had_authoritative_root" == "1" && -d "$backup_root_node_modules" ]]; then
    rm -rf "$root_node_modules"
    mv "$backup_root_node_modules" "$root_node_modules"
    (
      unset UIQ_NODE_MODULES_DIR
      uiq_link_workspace_node_modules "$ROOT_DIR"
    )
  fi
  rm -rf "$tmp_dir"
  rm -rf "$container_shortcut_tmp_dir"
  rm -rf "$backup_dir"
}
trap cleanup EXIT

source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
export UIQ_NODE_MODULES_DIR="$tmp_dir"

fingerprint="$(uiq_shared_link_repair_fingerprint "$ROOT_DIR")"
printf '%s\n' "$fingerprint" > "$tmp_dir/.repair-stamp"

output_without_cache="$(
  set +e
  uiq_repair_shared_module_links "$ROOT_DIR" 2>&1
  rc=$?
  set -e
  printf 'RC=%s\n%s\n' "$rc" "$(
    printf '%s' ''
  )"
)"

if grep -Fq "[shared-link-repair] stamp match, skipping full repair" <<<"$output_without_cache"; then
  echo "did not expect stamp shortcut when shared cache is incomplete" >&2
  echo "$output_without_cache" >&2
  exit 1
fi

uiq_cleanup_root_node_artifacts "$ROOT_DIR"
rm -f "$tmp_dir/.repair-stamp"
mkdir -p "$tmp_dir/.pnpm/fake@1.0.0/node_modules/fake" "$tmp_dir/.bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp_dir/.bin/fake"
chmod +x "$tmp_dir/.bin/fake"
node - "$ROOT_DIR" "$tmp_dir" <<'NODE'
const fs = require('fs');
const path = require('path');

const rootDir = process.argv[2];
const sharedDir = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const deps = new Map([
  ...Object.entries(packageJson.dependencies || {}),
  ...Object.entries(packageJson.devDependencies || {}),
]);

function versionFromSpec(spec) {
  const match = String(spec || '').match(/(\d+(?:\.\d+){0,3})/);
  return match ? match[1] : '1.0.0';
}

for (const [dep, spec] of deps) {
  const depDir = path.join(sharedDir, ...dep.split('/'));
  fs.mkdirSync(depDir, { recursive: true });
  fs.writeFileSync(
    path.join(depDir, 'package.json'),
    JSON.stringify({ name: dep, version: versionFromSpec(spec) }),
    'utf8',
  );
}
NODE

node - "$tmp_dir" <<'NODE'
const fs = require('fs');
const path = require('path');

const sharedDir = process.argv[2];
const scopedPackage = path.join(sharedDir, '@playwright', 'test', 'package.json');
if (fs.existsSync(scopedPackage)) {
  const payload = JSON.parse(fs.readFileSync(scopedPackage, 'utf8'));
  payload.dependencies = { ...(payload.dependencies || {}), yaml: '^2.8.3' };
  fs.writeFileSync(scopedPackage, JSON.stringify(payload), 'utf8');
}
NODE

output_without_stamp="$(
  set +e
  uiq_repair_shared_module_links "$ROOT_DIR" 2>&1
  rc=$?
  set -e
  printf 'RC=%s\n%s\n' "$rc" "$(
    printf '%s' ''
  )"
)"

if ! grep -Fq "[shared-link-repair] cache ready without stamp, but full topology repair is still required" <<<"$output_without_stamp"; then
  echo "expected missing-stamp full-repair message" >&2
  echo "$output_without_stamp" >&2
  exit 1
fi

if [[ ! -d "$tmp_dir/.pnpm" ]]; then
  echo "expected shared UIQ_NODE_MODULES_DIR to keep .pnpm runtime store directory" >&2
  exit 1
fi

if [[ ! -f "$tmp_dir/.repair-stamp" ]]; then
  echo "expected shared-link repair to record stamp when cache was ready without one" >&2
  exit 1
fi

if [[ "$(cat "$tmp_dir/.repair-stamp")" != "$fingerprint" ]]; then
  echo "expected recorded repair stamp to match current fingerprint" >&2
  exit 1
fi

output_with_cache="$(
  set +e
  uiq_repair_shared_module_links "$ROOT_DIR" 2>&1
  rc=$?
  set -e
  printf 'RC=%s\n%s\n' "$rc" "$(
    printf '%s' ''
  )"
)"

if ! grep -Fq "[shared-link-repair] stamp match detected, but running full topology repair for deterministic shared links" <<<"$output_with_cache"; then
  echo "expected stamp-match full-repair message" >&2
  echo "$output_with_cache" >&2
  exit 1
fi

container_shortcut_root="$container_shortcut_tmp_dir/repo"
container_shortcut_shared="$container_shortcut_tmp_dir/shared"
mkdir -p "$container_shortcut_root" "$container_shortcut_shared/.pnpm"

cat > "$container_shortcut_root/package.json" <<'JSON'
{
  "name": "container-shortcut-fixture",
  "version": "1.0.0",
  "dependencies": {
    "@playwright/test": "^1.58.2",
    "@playwright/experimental-ct-react": "^1.58.2"
  }
}
JSON

python3 - "$container_shortcut_shared" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

shared = Path(sys.argv[1])
fixtures = {
    "@playwright/test": {
        "version": "1.58.2",
        "store": "@playwright+test@1.58.2",
        "manifest": {"name": "@playwright/test", "version": "1.58.2"},
    },
    "@playwright/experimental-ct-react": {
        "version": "1.58.2",
        "store": "@playwright+experimental-ct-react@1.58.2",
        "manifest": {
            "name": "@playwright/experimental-ct-react",
            "version": "1.58.2",
            "dependencies": {
                "@playwright/experimental-ct-core": "1.58.2"
            },
        },
    },
    "@playwright/experimental-ct-core": {
        "version": "1.58.2",
        "store": "@playwright+experimental-ct-core@1.58.2",
        "manifest": {
            "name": "@playwright/experimental-ct-core",
            "version": "1.58.2",
        },
    },
}

for package_name, payload in fixtures.items():
    package_dir = shared / ".pnpm" / payload["store"] / "node_modules"
    for part in package_name.split("/"):
        package_dir /= part
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "package.json").write_text(
        json.dumps(payload["manifest"]),
        encoding="utf-8",
    )
PY

if uiq_container_gate_root_resolution_targets_ready "$container_shortcut_shared"; then
  echo "expected container shortcut fixture to start without CT root-resolution targets" >&2
  exit 1
fi

uiq_refresh_direct_shared_links "$container_shortcut_root" "$container_shortcut_shared"

if ! uiq_container_gate_root_resolution_targets_ready "$container_shortcut_shared"; then
  echo "expected direct shared-link refresh to materialize CT root-resolution targets" >&2
  exit 1
fi

if [[ ! -L "$container_shortcut_shared/@playwright/experimental-ct-core" ]]; then
  echo "expected CT core to be linked into the shared root after direct refresh" >&2
  exit 1
fi

echo "shared-link-repair stamp shortcut checks passed with repo-local node_modules bridges"
