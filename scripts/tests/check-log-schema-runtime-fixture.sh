#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

bash scripts/lib/node-governance-entry.sh scripts/ci/check-log-schema-sync.mjs >/dev/null

python3 - <<'PY'
from pathlib import Path
import json

root = Path("scripts/tests/fixtures/runtime-log-sample")
backend = json.loads((root / "service-api.app.jsonl").read_text(encoding="utf-8").splitlines()[0])
mcp = json.loads((root / "mcp-audit.jsonl").read_text(encoding="utf-8").splitlines()[0])

for field in ("request_id", "trace_id", "component", "evidenceClass", "event", "severity"):
    if field not in backend:
        raise SystemExit(f"missing backend runtime log field: {field}")

for field in ("runId", "component", "evidenceClass", "event", "status"):
    if field not in mcp:
        raise SystemExit(f"missing mcp audit log field: {field}")

universal = json.loads((root / "universal.audit.jsonl").read_text(encoding="utf-8").splitlines()[0])
for field in ("request_id", "trace_id", "component", "evidenceClass", "event", "status"):
    if field not in universal:
        raise SystemExit(f"missing universal audit log field: {field}")

vonage = json.loads((root / "vonage.callback-audit.jsonl").read_text(encoding="utf-8").splitlines()[0])
for field in ("request_id", "trace_id", "component", "evidenceClass", "event", "status"):
    if field not in vonage:
        raise SystemExit(f"missing vonage audit log field: {field}")
PY

echo "check-log-schema runtime fixture checks passed"
