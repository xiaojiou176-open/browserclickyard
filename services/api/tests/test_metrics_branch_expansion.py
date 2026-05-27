from __future__ import annotations

import json
from typing import Literal
from datetime import datetime
from pathlib import Path

import pytest

from app.core.metrics import RuntimeMetrics


def test_record_rum_metric_rejects_long_names(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._rum_summary_path = tmp_path / "rum" / "summary.json"
    rejected = metrics.record_rum_metric("x" * 33, 1.0)
    assert rejected is None
    assert not metrics._rum_summary_path.exists()


def test_persist_rum_summary_cleans_up_tempfile_on_replace_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metrics = RuntimeMetrics()
    metrics._rum_summary_path = tmp_path / "rum" / "summary.json"
    temp_path = tmp_path / "rum" / "summary.json.tmp-forced"

    class FakeTempFile:
        name = str(temp_path)

        def __enter__(self) -> "FakeTempFile":
            temp_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path.write_text("", encoding="utf-8")
            return self

        def __exit__(self, exc_type, exc, tb) -> Literal[False]:
            return False

        def write(self, payload: str) -> None:
            temp_path.write_text(payload, encoding="utf-8")

    monkeypatch.setattr(
        "backend.app.core.metrics.tempfile.NamedTemporaryFile",
        lambda **_: FakeTempFile(),
    )
    monkeypatch.setattr(
        Path, "replace", lambda self, target: (_ for _ in ()).throw(OSError("replace failed"))
    )

    with pytest.raises(OSError):
        metrics._persist_rum_summary_unlocked()
    assert not temp_path.exists()


def test_render_prometheus_text_handles_missing_optional_sections(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._runtime_logs_dir = tmp_path / "logs"
    metrics._runtime_cache_dir = tmp_path / "cache"
    metrics._runtime_gc_state_path = tmp_path / "metrics" / "runtime-gc-state.json"
    metrics._runtime_gc_state_path.parent.mkdir(parents=True, exist_ok=True)
    metrics._runtime_gc_state_path.write_text(json.dumps({"metrics": "not-used"}), encoding="utf-8")

    metrics.record_request(204, 0.001)
    text = metrics.render_prometheus_text()

    assert "uiq_automation_tasks" not in text
    assert "uiq_rum_samples_total 0" in text
    assert 'uiq_http_requests_total{code_class="2xx"} 1' in text


def test_render_prometheus_text_skips_non_dict_rum_metrics(tmp_path: Path) -> None:
    metrics = RuntimeMetrics()
    metrics._runtime_logs_dir = tmp_path / "logs"
    metrics._runtime_cache_dir = tmp_path / "cache"
    metrics._runtime_gc_state_path = tmp_path / "metrics" / "runtime-gc-state.json"
    metrics._runtime_gc_state_path.parent.mkdir(parents=True, exist_ok=True)
    metrics._runtime_gc_state_path.write_text("{}", encoding="utf-8")
    metrics.record_rum_metric("LCP", 12.3)
    metrics._rum_metric_samples = {"LCP": 1}
    metrics._rum_metric_sum = {"LCP": 12.3}
    metrics._rum_metric_latest = {"LCP": 12.3}
    monkeypatch_payload = {"samples_total": 1, "metrics": ["broken"]}
    metrics._rum_summary_unlocked = lambda: monkeypatch_payload  # type: ignore[method-assign]

    text = metrics.render_prometheus_text()
    assert "uiq_rum_metric_samples_total" in text
    assert '{metric="LCP"}' not in text


def test_directory_size_bytes_ignores_oserror_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metrics = RuntimeMetrics()
    target = tmp_path / "logs"
    target.mkdir(parents=True, exist_ok=True)
    okay = target / "ok.log"
    okay.write_text("abc", encoding="utf-8")
    broken = target / "broken.log"
    broken.write_text("boom", encoding="utf-8")

    original_stat = Path.stat

    def flaky_stat(self: Path, *, follow_symlinks: bool = True):
        if self == broken:
            raise OSError("cannot stat")
        return original_stat(self, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(Path, "stat", flaky_stat)
    assert metrics._directory_size_bytes(target) == 3


def test_numeric_coercion_and_timestamp_cover_remaining_edges() -> None:
    metrics = RuntimeMetrics()
    assert metrics._coerce_non_negative_int(float("inf")) == 0
    assert metrics._coerce_non_negative_int(3.9) == 3
    assert metrics._coerce_non_negative_float(object()) == 0.0
    assert metrics._coerce_non_negative_float(float("nan")) == 0.0
    assert metrics._coerce_non_negative_float(float("-inf")) == 0.0

    naive = datetime(2026, 1, 1, 0, 0, 0).isoformat()
    assert metrics._to_unix_timestamp(naive) > 0
