#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-run}"

if [[ "$cmd" == "sleep-forever" ]]; then
  sleep 5
  exit 0
fi

if [[ "$cmd" == "ignore-term" ]]; then
  trap '' TERM
  sleep 30
  exit 0
fi

if [[ "$cmd" == "fail-now" ]]; then
  echo "simulated failure" >&2
  exit 2
fi

if [[ "$cmd" == "spam-lines" ]]; then
  for i in $(seq 1 2200); do
    echo "out-$i"
    echo "err-$i" >&2
  done
  echo "runId=run-stream"
  echo "manifest=.runtime-cache/artifacts/runs/run-stream/manifest.json"
  exit 0
fi

echo "runId=run-a"
echo "manifest=.runtime-cache/artifacts/runs/run-a/manifest.json"
exit 0
