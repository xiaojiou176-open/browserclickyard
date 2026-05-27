#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WEBHOOK_URL="${VONAGE_WEBHOOK_URL:-http://127.0.0.1:17380/api/integrations/vonage/inbound-sms}"
TOTAL="${VONAGE_LOAD_TOTAL:-200}"
CONCURRENCY="${VONAGE_LOAD_CONCURRENCY:-20}"
TOKEN="${VONAGE_INBOUND_TOKEN:-}"
SIG_SECRET="${VONAGE_SIGNATURE_SECRET:-}"
SIG_ALGO="${VONAGE_SIGNATURE_ALGO:-md5hash}"
TO_NUMBER="${VONAGE_OTP_TO_NUMBER:-14155550000}"

RUNTIME_DIR=".runtime-cache/logs/vonage"
mkdir -p "$RUNTIME_DIR"
REPORT_PATH="$RUNTIME_DIR/webhook-load-baseline-$(date +%Y%m%d-%H%M%S).json"

python3 - "$WEBHOOK_URL" "$TOTAL" "$CONCURRENCY" "$TOKEN" "$SIG_SECRET" "$SIG_ALGO" "$TO_NUMBER" "$REPORT_PATH" <<'PY'
from __future__ import annotations

import hashlib
import hmac
import json
import random
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

url, total_raw, concurrency_raw, token, sig_secret, sig_algo, to_number, report_path = sys.argv[1:9]
total = int(total_raw)
concurrency = int(concurrency_raw)

def build_sig(payload: dict[str, str], secret: str, algo: str) -> str:
    data = "&".join(f"{k}={payload[k].replace('&', '_').replace('=', '_')}" for k in sorted(payload))
    algo = algo.lower()
    if algo == "md5hash":
        message = (data + secret).encode("utf-8")
        try:
            return hashlib.md5(message, usedforsecurity=False).hexdigest()
        except TypeError:
            return hashlib.md5(message).hexdigest()
    if algo in {"md5", "sha1", "sha256", "sha512"}:
        digestmod = getattr(hashlib, algo)
        return hmac.new(secret.encode("utf-8"), data.encode("utf-8"), digestmod).hexdigest()
    raise ValueError(f"unsupported algo: {algo}")

def send_one(i: int) -> tuple[bool, int, float]:
    started = time.perf_counter()
    payload = {
        "msisdn": f"1415999{1000+i:04d}",
        "to": to_number,
        "text": f"Your code is {100000 + (i % 900000)}",
        "messageId": f"load-{i}-{random.randint(1000, 9999)}",
        "timestamp": str(int(time.time())),
        "api_key": "load-test",
    }
    if sig_secret:
        payload["sig"] = build_sig(payload, sig_secret, sig_algo)
    params = {}
    if token:
        params["token"] = token
    endpoint = url
    if params:
        endpoint = f"{endpoint}?{urllib.parse.urlencode(params)}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(endpoint, method="POST", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
            elapsed_ms = (time.perf_counter() - started) * 1000
            return ok, resp.status, elapsed_ms
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return False, int(exc.code), elapsed_ms
    except Exception:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return False, 0, elapsed_ms

latencies = []
status_counts: dict[str, int] = {}
success = 0
failed = 0
start = time.perf_counter()
with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
    futures = [pool.submit(send_one, i) for i in range(total)]
    for fut in as_completed(futures):
        ok, status_code, latency = fut.result()
        latencies.append(latency)
        key = str(status_code)
        status_counts[key] = status_counts.get(key, 0) + 1
        if ok:
            success += 1
        else:
            failed += 1
duration = time.perf_counter() - start

lat_sorted = sorted(latencies)
def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = max(0, min(len(sorted_values) - 1, int(round(p * (len(sorted_values) - 1)))))
    return sorted_values[idx]

report = {
    "checked_at": datetime.now(timezone.utc).isoformat(),
    "url": url,
    "total": total,
    "concurrency": concurrency,
    "duration_seconds": duration,
    "throughput_rps": (total / duration) if duration > 0 else 0.0,
    "success": success,
    "failed": failed,
    "status_counts": status_counts,
    "latency_ms": {
        "min": min(lat_sorted) if lat_sorted else 0.0,
        "p50": percentile(lat_sorted, 0.50),
        "p95": percentile(lat_sorted, 0.95),
        "p99": percentile(lat_sorted, 0.99),
        "max": max(lat_sorted) if lat_sorted else 0.0,
        "avg": statistics.fmean(lat_sorted) if lat_sorted else 0.0,
    },
}
with open(report_path, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False))
PY

echo "report: $REPORT_PATH"
