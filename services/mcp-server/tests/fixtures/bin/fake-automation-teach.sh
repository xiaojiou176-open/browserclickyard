#!/usr/bin/env bash
set -euo pipefail

echo "mode=$1"
echo "token=plain-secret-token"
echo "PASSWORD=super-secret-password" >&2
echo "runId=run-teach"
echo "manifest=.runtime-cache/artifacts/runs/run-teach/manifest.json"
