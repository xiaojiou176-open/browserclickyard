#!/usr/bin/env bash
set -euo pipefail

echo "[deps-guard] verifying root install path excludes openai"

scan_cmd=(grep -nE '\bopenai@')
if command -v rg >/dev/null 2>&1; then
  scan_cmd=(rg -n '\bopenai@')
fi

if "${scan_cmd[@]}" pnpm-lock.yaml >/tmp/uiq-openai-lock-scan.txt; then
  echo "[deps-guard] root pnpm-lock.yaml unexpectedly references openai:"
  cat /tmp/uiq-openai-lock-scan.txt
  exit 1
fi

tmp_tree_output="$(mktemp)"
trap 'rm -f "$tmp_tree_output"' EXIT

pnpm ls openai --depth 99 >"$tmp_tree_output" 2>&1 || true
if grep -q 'openai@' "$tmp_tree_output"; then
  echo "[deps-guard] root dependency tree unexpectedly contains openai:"
  cat "$tmp_tree_output"
  exit 1
fi

echo "[deps-guard] PASS: root install path has zero openai"
