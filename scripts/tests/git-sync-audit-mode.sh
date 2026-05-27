#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/git-sync-audit.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

repo_dir="$tmp_dir/repo"
mkdir -p "$repo_dir/scripts" "$repo_dir/configs/upstream"

cp scripts/git-sync-audit.sh "$repo_dir/scripts/git-sync-audit.sh"
cp configs/upstream/source.yaml "$repo_dir/configs/upstream/source.yaml"

git -C "$repo_dir" init -q
git -C "$repo_dir" checkout -q -b main
git -C "$repo_dir" config user.name "UIQ Test"
git -C "$repo_dir" config user.email "uiq-test@example.com"
git -C "$repo_dir" remote add origin "https://github.com/example-org/example-repo.git"
git -C "$repo_dir" config rerere.enabled true
git -C "$repo_dir" config rerere.autoupdate true
touch "$repo_dir/.gitkeep"
git -C "$repo_dir" add .gitkeep
git -C "$repo_dir" commit -q -m "test: seed fixture repo"

json_output="$(
  cd "$repo_dir"
  bash scripts/git-sync-audit.sh --json
)"

python3 - <<'PY' "$json_output"
import json
import sys

payload = json.loads(sys.argv[1])
if payload.get("mode") != "dependency-governance-first":
    raise SystemExit(f"expected dependency-governance-first, got {payload.get('mode')!r}")
if payload.get("upstream", {}).get("configured") is not False:
    raise SystemExit("expected upstream.configured=false in fixture repo")
PY

text_output="$(
  cd "$repo_dir"
  bash scripts/git-sync-audit.sh
)"

if ! grep -Fq "mode: dependency-governance-first" <<<"$text_output"; then
  echo "expected text output to include dependency-governance-first mode" >&2
  echo "$text_output" >&2
  exit 1
fi

echo "git-sync-audit mode checks passed"
