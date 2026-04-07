#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/runtime-gc-smoke.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

runtime_root="$tmp_dir/runtime"
state_path="$runtime_root/metrics/runtime-gc-state.json"

python3 - "$runtime_root" <<'PY'
import os
import sys
import time
from pathlib import Path

runtime_root = Path(sys.argv[1])
logs_dir = runtime_root / "logs"
cache_dir = runtime_root / "cache"
runs_dir = runtime_root / "artifacts" / "runs"

for directory in (logs_dir, cache_dir, runs_dir):
    directory.mkdir(parents=True, exist_ok=True)

fixtures = {
    logs_dir / "old.log": ("old-log", 10),
    logs_dir / "fresh.log": ("fresh-log", 1),
    cache_dir / "old.cache": ("old-cache", 10),
    cache_dir / "fresh.cache": ("fresh-cache", 1),
    runs_dir / "run-old" / "result.txt": ("run-old", 10),
    runs_dir / "run-mid" / "result.txt": ("run-mid", 5),
    runs_dir / "run-new" / "result.txt": ("run-new", 1),
}

now = time.time()
for path, (content, days_old) in fixtures.items():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    ts = now - (days_old * 24 * 3600)
    os.utime(path, (ts, ts))
    os.utime(path.parent, (ts, ts))

# Ensure run folder mtimes are ordered by run age.
os.utime(runs_dir / "run-old", (now - 10 * 24 * 3600, now - 10 * 24 * 3600))
os.utime(runs_dir / "run-mid", (now - 5 * 24 * 3600, now - 5 * 24 * 3600))
os.utime(runs_dir / "run-new", (now - 1 * 24 * 3600, now - 1 * 24 * 3600))
PY

dry_output="$(./scripts/runtime-gc.sh \
  --runtime-root "$runtime_root" \
  --scope all \
  --retention-days 3 \
  --keep-runs 1 \
  --max-delete-per-run 20 \
  --dry-run)"

python3 - "$dry_output" "$state_path" "$runtime_root" <<'PY'
import json
import sys
from pathlib import Path

output_payload = json.loads(sys.argv[1])
state_path = Path(sys.argv[2])
runtime_root = Path(sys.argv[3])
state_payload = json.loads(state_path.read_text(encoding="utf-8"))

required_keys = {
    "version",
    "started_at",
    "last_run_at",
    "duration_seconds",
    "runtime_root",
    "state_path",
    "scope",
    "dry_run",
    "fail_on_error",
    "retention_days",
    "keep_runs",
    "max_delete_per_run",
    "max_delete_reached",
    "deleted",
    "bytes_freed",
    "bytes_freed_total",
    "errors",
    "error_total",
    "status",
}

missing = sorted(required_keys - set(output_payload))
if missing:
    raise SystemExit(f"dry-run output missing keys: {missing}")

if output_payload != state_payload:
    raise SystemExit("dry-run output json and state json diverged")

if output_payload["dry_run"] is not True:
    raise SystemExit("dry-run payload flag mismatch")
if output_payload["scope"] != "all":
    raise SystemExit("dry-run scope mismatch")
if output_payload["deleted"]["total"] < 4:
    raise SystemExit("dry-run expected at least 4 delete candidates")

# Dry-run must not physically remove targets.
checks = [
    runtime_root / "logs" / "old.log",
    runtime_root / "cache" / "old.cache",
    runtime_root / "artifacts" / "runs" / "run-old",
    runtime_root / "artifacts" / "runs" / "run-mid",
]
for candidate in checks:
    if not candidate.exists():
        raise SystemExit(f"dry-run unexpectedly removed: {candidate}")
PY

real_output="$(./scripts/runtime-gc.sh \
  --runtime-root "$runtime_root" \
  --scope all \
  --retention-days 3 \
  --keep-runs 1 \
  --max-delete-per-run 20)"

python3 - "$real_output" "$state_path" "$runtime_root" <<'PY'
import json
import sys
from pathlib import Path

output_payload = json.loads(sys.argv[1])
state_path = Path(sys.argv[2])
runtime_root = Path(sys.argv[3])
state_payload = json.loads(state_path.read_text(encoding="utf-8"))

if output_payload != state_payload:
    raise SystemExit("real-run output json and state json diverged")

if output_payload["dry_run"] is not False:
    raise SystemExit("real-run payload flag mismatch")
if output_payload["errors"] != 0:
    raise SystemExit("real-run expected zero errors")
if output_payload["status"] != "ok":
    raise SystemExit("real-run expected status=ok")
if output_payload["deleted"]["runs"] != 2:
    raise SystemExit("real-run expected 2 run directories deleted")
if output_payload["deleted"]["logs"] != 1:
    raise SystemExit("real-run expected 1 old log deleted")
if output_payload["deleted"]["cache"] != 1:
    raise SystemExit("real-run expected 1 old cache file deleted")
if output_payload["bytes_freed"] <= 0:
    raise SystemExit("real-run expected bytes_freed > 0")
if output_payload["bytes_freed_total"] < output_payload["bytes_freed"]:
    raise SystemExit("bytes_freed_total should be >= bytes_freed")

if (runtime_root / "logs" / "old.log").exists():
    raise SystemExit("old log should be deleted")
if not (runtime_root / "logs" / "fresh.log").exists():
    raise SystemExit("fresh log should be kept")
if (runtime_root / "cache" / "old.cache").exists():
    raise SystemExit("old cache should be deleted")
if not (runtime_root / "cache" / "fresh.cache").exists():
    raise SystemExit("fresh cache should be kept")

runs_dir = runtime_root / "artifacts" / "runs"
runs_remaining = sorted(path.name for path in runs_dir.iterdir() if path.is_dir())
if runs_remaining != ["run-new"]:
    raise SystemExit(f"expected only run-new to remain, got: {runs_remaining}")
PY

echo "runtime-gc smoke passed"
