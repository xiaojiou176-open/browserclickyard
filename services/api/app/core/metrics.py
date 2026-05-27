from __future__ import annotations

import json
import math
import os
from threading import Lock
from datetime import datetime, timezone
from pathlib import Path
import tempfile

from app.core.runtime_paths import repo_root, runtime_cache_root, runtime_logs_root, runtime_path


class RuntimeMetrics:
    _LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
    _RUM_ALLOWED_METRICS = frozenset(
        {
            "LCP",
            "INP",
            "CLS",
            "FCP",
            "TTFB",
            "TBT",
            # Backward-compat aliases still emitted by load scenarios.
            "WEB_VITALS_LCP",
            "WEB_VITALS_INP",
            "WEB_VITALS_CLS",
            "WEB_VITALS_FCP",
            "WEB_VITALS_TTFB",
            "WEB_VITALS_TBT",
        }
    )
    _RUM_MAX_METRIC_NAME_LENGTH = 32

    def __init__(self) -> None:
        self._lock = Lock()
        self._total_requests = 0
        self._status_counts: dict[str, int] = {}
        self._status_code_counts: dict[int, int] = {}
        self._request_errors = 0
        self._active_requests = 0
        self._request_latency_count = 0
        self._request_latency_sum_seconds = 0.0
        self._request_latency_max_seconds = 0.0
        self._request_latency_bucket_counts = {bucket: 0 for bucket in self._LATENCY_BUCKETS}
        self._request_latency_overflow = 0
        self._automation_runs = 0
        self._automation_failures = 0
        self._automation_cancellations = 0
        self._rate_limited = 0
        self._rate_limit_redis_errors = 0
        self._task_store_decode_errors = 0
        base_root = repo_root()
        self._rum_summary_path = runtime_path("metrics", "rum-summary.json", root=base_root)
        self._rum_samples_total = 0
        self._rum_metric_samples: dict[str, int] = {}
        self._rum_metric_sum: dict[str, float] = {}
        self._rum_metric_latest: dict[str, float] = {}
        self._rum_last_updated_at = ""
        runtime_root = runtime_cache_root(base_root)
        self._runtime_logs_dir = runtime_logs_root(base_root)
        self._runtime_cache_dir = Path(
            os.getenv("RUNTIME_CACHE_DIR", str(runtime_root / "cache")).strip()
            or (runtime_root / "cache")
        )
        self._runtime_gc_state_path = Path(
            os.getenv(
                "RUNTIME_GC_STATE_PATH", str(runtime_root / "metrics" / "runtime-gc-state.json")
            ).strip()
            or (runtime_root / "metrics" / "runtime-gc-state.json")
        )

    def record_request(self, status_code: int, duration_seconds: float | None = None) -> None:
        with self._lock:
            self._total_requests += 1
            bucket = f"{status_code // 100}xx"
            self._status_counts[bucket] = self._status_counts.get(bucket, 0) + 1
            self._status_code_counts[status_code] = self._status_code_counts.get(status_code, 0) + 1
            if status_code >= 400:
                self._request_errors += 1
            if (
                duration_seconds is not None
                and math.isfinite(duration_seconds)
                and duration_seconds >= 0
            ):
                self._request_latency_count += 1
                self._request_latency_sum_seconds += duration_seconds
                if duration_seconds > self._request_latency_max_seconds:
                    self._request_latency_max_seconds = duration_seconds
                for latency_bucket in self._LATENCY_BUCKETS:
                    if duration_seconds <= latency_bucket:
                        self._request_latency_bucket_counts[latency_bucket] += 1
                        break
                else:
                    self._request_latency_overflow += 1

    def increment_active_requests(self) -> None:
        with self._lock:
            self._active_requests += 1

    def decrement_active_requests(self) -> None:
        with self._lock:
            self._active_requests = max(0, self._active_requests - 1)

    def record_automation_run(self) -> None:
        with self._lock:
            self._automation_runs += 1

    def record_automation_failure(self) -> None:
        with self._lock:
            self._automation_failures += 1

    def record_automation_cancellation(self) -> None:
        with self._lock:
            self._automation_cancellations += 1

    def record_rate_limited(self) -> None:
        with self._lock:
            self._rate_limited += 1

    def record_rate_limit_redis_error(self) -> None:
        with self._lock:
            self._rate_limit_redis_errors += 1

    def record_task_store_decode_error(self) -> None:
        with self._lock:
            self._task_store_decode_errors += 1

    def record_rum_metric(self, metric_name: str, value: float) -> str | None:
        normalized = metric_name.strip().upper()
        if not normalized:
            return None
        if len(normalized) > self._RUM_MAX_METRIC_NAME_LENGTH:
            return None
        if normalized not in self._RUM_ALLOWED_METRICS:
            return None
        if not math.isfinite(value) or value < 0:
            return None
        with self._lock:
            self._rum_samples_total += 1
            self._rum_metric_samples[normalized] = self._rum_metric_samples.get(normalized, 0) + 1
            self._rum_metric_sum[normalized] = self._rum_metric_sum.get(normalized, 0.0) + float(
                value
            )
            self._rum_metric_latest[normalized] = float(value)
            self._rum_last_updated_at = datetime.now(timezone.utc).isoformat()
            self._persist_rum_summary_unlocked()
        return normalized

    def _rum_summary_unlocked(self) -> dict[str, object]:
        metric_keys = sorted(
            set(self._rum_metric_samples) | set(self._rum_metric_sum) | set(self._rum_metric_latest)
        )
        metrics: dict[str, dict[str, float | int]] = {}
        for key in metric_keys:
            sample_count = int(self._rum_metric_samples.get(key, 0))
            sample_sum = float(self._rum_metric_sum.get(key, 0.0))
            average = (sample_sum / sample_count) if sample_count else 0.0
            metrics[key] = {
                "samples": sample_count,
                "avg": round(average, 6),
                "latest": round(float(self._rum_metric_latest.get(key, 0.0)), 6),
            }
        return {
            "samples_total": self._rum_samples_total,
            "last_updated_at": self._rum_last_updated_at,
            "metrics": metrics,
        }

    def _persist_rum_summary_unlocked(self) -> None:
        summary_dir = self._rum_summary_path.parent
        summary_dir.mkdir(parents=True, exist_ok=True)
        payload = self._rum_summary_unlocked()
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=summary_dir,
                prefix=f"{self._rum_summary_path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(json.dumps(payload, ensure_ascii=False, indent=2))
            temp_path.replace(self._rum_summary_path)
        finally:
            if temp_path and temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            snapshot: dict[str, object] = {
                "requests_total": self._total_requests,
                "request_status": dict(self._status_counts),
                "request_status_codes": {
                    str(key): value for key, value in self._status_code_counts.items()
                },
                "request_errors_total": self._request_errors,
                "active_requests": self._active_requests,
                "request_latency": {
                    "count": self._request_latency_count,
                    "sum_seconds": round(self._request_latency_sum_seconds, 6),
                    "max_seconds": round(self._request_latency_max_seconds, 6),
                    "buckets": {
                        str(key): value
                        for key, value in self._request_latency_bucket_counts.items()
                    },
                },
                "automation_runs": self._automation_runs,
                "automation_failures": self._automation_failures,
                "automation_cancellations": self._automation_cancellations,
                "rate_limited": self._rate_limited,
                "rate_limit_redis_errors": self._rate_limit_redis_errors,
                "task_store_decode_errors": self._task_store_decode_errors,
                "rum": self._rum_summary_unlocked(),
            }
        snapshot["runtime_storage"] = self._runtime_storage_snapshot()
        return snapshot

    def render_prometheus_text(self, automation_summary: dict[str, int] | None = None) -> str:
        with self._lock:
            status_counts = dict(self._status_counts)
            status_code_counts = dict(self._status_code_counts)
            request_errors = self._request_errors
            active_requests = self._active_requests
            latency_count = self._request_latency_count
            latency_sum = self._request_latency_sum_seconds
            latency_bucket_counts = dict(self._request_latency_bucket_counts)
            latency_overflow = self._request_latency_overflow
            automation_runs = self._automation_runs
            automation_failures = self._automation_failures
            automation_cancellations = self._automation_cancellations
            rate_limited = self._rate_limited
            rate_limit_redis_errors = self._rate_limit_redis_errors
            task_store_decode_errors = self._task_store_decode_errors
            rum_snapshot = self._rum_summary_unlocked()
        runtime_storage_snapshot = self._runtime_storage_snapshot()
        runtime_gc_snapshot_raw = runtime_storage_snapshot.get("gc")
        runtime_gc_snapshot: dict[str, object] = (
            runtime_gc_snapshot_raw if isinstance(runtime_gc_snapshot_raw, dict) else {}
        )

        lines = [
            "# HELP uiq_http_requests_total Total HTTP requests by response code class.",
            "# TYPE uiq_http_requests_total counter",
        ]
        for code_class in sorted(status_counts):
            lines.append(
                f'uiq_http_requests_total{{code_class="{_escape_label_value(code_class)}"}} {status_counts[code_class]}'
            )

        lines.extend(
            [
                "# HELP uiq_http_requests_by_code_total Total HTTP requests by exact status code.",
                "# TYPE uiq_http_requests_by_code_total counter",
            ]
        )
        for status_code in sorted(status_code_counts):
            lines.append(
                f'uiq_http_requests_by_code_total{{code="{status_code}"}} {status_code_counts[status_code]}'
            )

        lines.extend(
            [
                "# HELP uiq_http_request_errors_total Total HTTP requests with status >= 400.",
                "# TYPE uiq_http_request_errors_total counter",
                f"uiq_http_request_errors_total {request_errors}",
                "# HELP uiq_http_active_requests Active in-flight HTTP requests.",
                "# TYPE uiq_http_active_requests gauge",
                f"uiq_http_active_requests {active_requests}",
                "# HELP uiq_http_request_duration_seconds HTTP request latency histogram.",
                "# TYPE uiq_http_request_duration_seconds histogram",
            ]
        )
        cumulative = 0
        for latency_bucket in self._LATENCY_BUCKETS:
            cumulative += int(latency_bucket_counts.get(latency_bucket, 0))
            lines.append(
                f'uiq_http_request_duration_seconds_bucket{{le="{latency_bucket}"}} {cumulative}'
            )
        lines.append(
            f'uiq_http_request_duration_seconds_bucket{{le="+Inf"}} {cumulative + latency_overflow}'
        )
        lines.append(f"uiq_http_request_duration_seconds_sum {round(latency_sum, 6)}")
        lines.append(f"uiq_http_request_duration_seconds_count {latency_count}")

        lines.extend(
            [
                "# HELP uiq_automation_runs_total Total automation runs started.",
                "# TYPE uiq_automation_runs_total counter",
                f"uiq_automation_runs_total {automation_runs}",
                "# HELP uiq_automation_failures_total Total automation runs failed.",
                "# TYPE uiq_automation_failures_total counter",
                f"uiq_automation_failures_total {automation_failures}",
                "# HELP uiq_automation_cancellations_total Total automation runs cancelled.",
                "# TYPE uiq_automation_cancellations_total counter",
                f"uiq_automation_cancellations_total {automation_cancellations}",
                "# HELP uiq_rate_limited_total Total rate-limited requests.",
                "# TYPE uiq_rate_limited_total counter",
                f"uiq_rate_limited_total {rate_limited}",
                "# HELP uiq_rate_limit_redis_errors_total Total rate limit redis errors.",
                "# TYPE uiq_rate_limit_redis_errors_total counter",
                f"uiq_rate_limit_redis_errors_total {rate_limit_redis_errors}",
                "# HELP uiq_task_store_decode_errors_total Total task-store decode errors.",
                "# TYPE uiq_task_store_decode_errors_total counter",
                f"uiq_task_store_decode_errors_total {task_store_decode_errors}",
            ]
        )

        if automation_summary:
            lines.extend(
                [
                    "# HELP uiq_automation_tasks Current automation task counts by status.",
                    "# TYPE uiq_automation_tasks gauge",
                ]
            )
            for status in ("queued", "running", "success", "failed", "cancelled"):
                lines.append(
                    f'uiq_automation_tasks{{status="{status}"}} {int(automation_summary.get(status, 0))}'
                )
            lines.append(
                f'uiq_automation_tasks{{status="total"}} {int(automation_summary.get("total", 0))}'
            )

        rum_samples_total = self._coerce_non_negative_int(rum_snapshot.get("samples_total"))
        rum_metrics_raw = rum_snapshot.get("metrics")
        rum_metrics: dict[str, object] = (
            rum_metrics_raw if isinstance(rum_metrics_raw, dict) else {}
        )
        lines.extend(
            [
                "# HELP uiq_rum_samples_total Total accepted RUM metric samples.",
                "# TYPE uiq_rum_samples_total counter",
                f"uiq_rum_samples_total {rum_samples_total}",
                "# HELP uiq_rum_metric_samples_total RUM samples per metric.",
                "# TYPE uiq_rum_metric_samples_total counter",
                "# HELP uiq_rum_metric_average RUM average metric values.",
                "# TYPE uiq_rum_metric_average gauge",
                "# HELP uiq_rum_metric_latest Latest observed RUM metric values.",
                "# TYPE uiq_rum_metric_latest gauge",
            ]
        )
        if isinstance(rum_metrics, dict):
            for metric_name in sorted(rum_metrics):
                metric_payload_raw = rum_metrics[metric_name]
                metric_payload: dict[str, object] = (
                    metric_payload_raw if isinstance(metric_payload_raw, dict) else {}
                )
                samples = self._coerce_non_negative_int(metric_payload.get("samples"))
                average = self._coerce_non_negative_float(metric_payload.get("avg"))
                latest = self._coerce_non_negative_float(metric_payload.get("latest"))
                escaped_metric = _escape_label_value(metric_name)
                lines.append(f'uiq_rum_metric_samples_total{{metric="{escaped_metric}"}} {samples}')
                lines.append(
                    f'uiq_rum_metric_average{{metric="{escaped_metric}"}} {round(average, 6)}'
                )
                lines.append(
                    f'uiq_rum_metric_latest{{metric="{escaped_metric}"}} {round(latest, 6)}'
                )

        lines.extend(
            [
                "# HELP uiq_runtime_logs_size_bytes Runtime logs directory size in bytes.",
                "# TYPE uiq_runtime_logs_size_bytes gauge",
                f"uiq_runtime_logs_size_bytes {self._coerce_non_negative_int(runtime_storage_snapshot.get('logs_size_bytes'))}",
                "# HELP uiq_runtime_cache_size_bytes Runtime cache directory size in bytes.",
                "# TYPE uiq_runtime_cache_size_bytes gauge",
                f"uiq_runtime_cache_size_bytes {self._coerce_non_negative_int(runtime_storage_snapshot.get('cache_size_bytes'))}",
                "# HELP uiq_runtime_gc_last_run_timestamp_seconds Last runtime GC execution time as unix timestamp.",
                "# TYPE uiq_runtime_gc_last_run_timestamp_seconds gauge",
                f"uiq_runtime_gc_last_run_timestamp_seconds {self._to_unix_timestamp(runtime_gc_snapshot.get('last_run_at'))}",
                "# HELP uiq_runtime_gc_last_duration_seconds Last runtime GC run duration in seconds.",
                "# TYPE uiq_runtime_gc_last_duration_seconds gauge",
                f"uiq_runtime_gc_last_duration_seconds {round(self._coerce_non_negative_float(runtime_gc_snapshot.get('duration_seconds')), 6)}",
                "# HELP uiq_runtime_gc_error_total Total runtime GC errors across runs.",
                "# TYPE uiq_runtime_gc_error_total counter",
                f"uiq_runtime_gc_error_total {self._coerce_non_negative_int(runtime_gc_snapshot.get('error_total'))}",
                "# HELP uiq_runtime_gc_bytes_freed_total Total bytes freed by runtime GC across runs.",
                "# TYPE uiq_runtime_gc_bytes_freed_total counter",
                f"uiq_runtime_gc_bytes_freed_total {self._coerce_non_negative_int(runtime_gc_snapshot.get('bytes_freed_total'))}",
                "# HELP uiq_runtime_gc_deleted_items Last runtime GC deleted item counts by scope.",
                "# TYPE uiq_runtime_gc_deleted_items gauge",
                f'uiq_runtime_gc_deleted_items{{scope="logs"}} {self._coerce_non_negative_int(runtime_gc_snapshot.get("logs_deleted"))}',
                f'uiq_runtime_gc_deleted_items{{scope="runs"}} {self._coerce_non_negative_int(runtime_gc_snapshot.get("runs_deleted"))}',
                f'uiq_runtime_gc_deleted_items{{scope="cache"}} {self._coerce_non_negative_int(runtime_gc_snapshot.get("cache_deleted"))}',
                f'uiq_runtime_gc_deleted_items{{scope="total"}} {self._coerce_non_negative_int(runtime_gc_snapshot.get("total_deleted"))}',
            ]
        )
        return "\n".join(lines) + "\n"

    def _runtime_storage_snapshot(self) -> dict[str, object]:
        return {
            "logs_size_bytes": self._directory_size_bytes(self._runtime_logs_dir),
            "cache_size_bytes": self._directory_size_bytes(self._runtime_cache_dir),
            "gc": self._load_runtime_gc_state(),
        }

    def _directory_size_bytes(self, directory: Path) -> int:
        if not directory.exists():
            return 0
        total = 0
        for root, _, files in os.walk(directory):
            for name in files:
                candidate = Path(root) / name
                try:
                    if candidate.is_symlink():
                        continue
                    total += candidate.stat().st_size
                except OSError:
                    continue
        return total

    def _load_runtime_gc_state(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "last_run_at": "",
            "duration_seconds": 0.0,
            "logs_deleted": 0,
            "runs_deleted": 0,
            "cache_deleted": 0,
            "total_deleted": 0,
            "errors": 0,
            "error_total": 0,
            "bytes_freed": 0,
            "bytes_freed_total": 0,
        }
        if not self._runtime_gc_state_path.exists():
            return payload
        try:
            raw = json.loads(self._runtime_gc_state_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return payload
        if not isinstance(raw, dict):
            return payload
        deleted_payload_raw = raw.get("deleted")
        deleted_payload = deleted_payload_raw if isinstance(deleted_payload_raw, dict) else {}
        logs_deleted = self._coerce_non_negative_int(
            deleted_payload.get("logs", raw.get("logs_deleted"))
        )
        runs_deleted = self._coerce_non_negative_int(
            deleted_payload.get("runs", raw.get("runs_deleted"))
        )
        cache_deleted = self._coerce_non_negative_int(
            deleted_payload.get("cache", raw.get("cache_deleted"))
        )
        total_deleted = self._coerce_non_negative_int(
            deleted_payload.get("total", raw.get("total_deleted"))
        )
        errors = self._coerce_non_negative_int(raw.get("errors"))
        error_total = self._coerce_non_negative_int(raw.get("error_total"))
        bytes_freed = self._coerce_non_negative_int(raw.get("bytes_freed"))
        bytes_freed_total = self._coerce_non_negative_int(raw.get("bytes_freed_total"))
        payload["last_run_at"] = str(raw.get("last_run_at") or "")
        payload["duration_seconds"] = self._coerce_non_negative_float(raw.get("duration_seconds"))
        payload["logs_deleted"] = logs_deleted
        payload["runs_deleted"] = runs_deleted
        payload["cache_deleted"] = cache_deleted
        payload["total_deleted"] = total_deleted or (logs_deleted + runs_deleted + cache_deleted)
        payload["errors"] = errors
        payload["error_total"] = error_total or errors
        payload["bytes_freed"] = bytes_freed
        payload["bytes_freed_total"] = bytes_freed_total or bytes_freed
        return payload

    def _coerce_non_negative_int(self, value: object) -> int:
        if isinstance(value, bool):
            converted = int(value)
        elif isinstance(value, int):
            converted = value
        elif isinstance(value, float):
            if not math.isfinite(value):
                return 0
            converted = int(value)
        elif isinstance(value, (str, bytes, bytearray)):
            try:
                converted = int(value)
            except ValueError:
                return 0
        else:
            return 0
        return max(0, converted)

    def _coerce_non_negative_float(self, value: object) -> float:
        if isinstance(value, bool):
            converted = float(value)
        elif isinstance(value, (int, float)):
            converted = float(value)
        elif isinstance(value, (str, bytes, bytearray)):
            try:
                converted = float(value)
            except ValueError:
                return 0.0
        else:
            return 0.0
        if not math.isfinite(converted):
            return 0.0
        return max(0.0, converted)

    def _to_unix_timestamp(self, value: object) -> float:
        if not isinstance(value, str):
            return 0.0
        normalized = value.strip()
        if not normalized:
            return 0.0
        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return round(parsed.timestamp(), 3)


def _escape_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


runtime_metrics = RuntimeMetrics()
