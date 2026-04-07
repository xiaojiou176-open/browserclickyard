from app.core.settings import env_str

import time
from datetime import UTC, datetime

from fastapi import APIRouter
from fastapi import Header, Request
from fastapi import HTTPException
from fastapi import status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, StrictFloat

from app.core.access_control import require_access, require_rate_limit
from app.api.common import COMMON_ERROR_RESPONSES
from app.core.metrics import runtime_metrics
from app.core.observability import STARTED_AT
from app.services.automation_service import automation_service

router = APIRouter(prefix="/health", tags=["health"], responses=COMMON_ERROR_RESPONSES)

_RUM_SCHEMA_ENUM = [
    "LCP",
    "INP",
    "CLS",
    "FCP",
    "TTFB",
    "TBT",
    "WEB_VITALS_LCP",
    "WEB_VITALS_INP",
    "WEB_VITALS_CLS",
    "WEB_VITALS_FCP",
    "WEB_VITALS_TTFB",
    "WEB_VITALS_TBT",
]


class RumMetricIngestRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    metric_name: str = Field(
        alias="metric",
        pattern=r"^[A-Za-z_-]+$",
    )
    value: StrictFloat = Field(ge=0)
    rating: str | None = None
    path: str | None = None
    navigation_type: str | None = Field(default=None, alias="navigationType")
    timestamp_ms: StrictFloat | None = Field(default=None, alias="timestampMs", ge=0)


@router.get("/")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/diagnostics")
def diagnostics(
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> dict[str, object]:
    require_access(request, x_automation_token)
    return build_diagnostics_payload()


def build_diagnostics_payload() -> dict[str, object]:
    summary = automation_service.task_summary()
    alerts_payload = _build_alerts_payload_from_summary(summary)
    return {
        "status": "ok",
        "uptime_seconds": int(time.time() - STARTED_AT),
        "storage_backend": automation_service.storage_backend(),
        "task_counts": {
            "queued": summary["queued"],
            "running": summary["running"],
            "success": summary["success"],
            "failed": summary["failed"],
            "cancelled": summary["cancelled"],
        },
        "task_total": summary["total"],
        "metrics": runtime_metrics.snapshot(),
        # Backward-compatible fields for legacy clients still bound to old diagnostics shape.
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "diagnostics_index": {
            "capture": {},
            "explore": {},
            "chaos": {},
            "report": {"run_id": "health-diagnostics", "status": "success", "checks": []},
        },
        "alerts": alerts_payload["alerts"],
    }


@router.get("/alerts")
def alerts(
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> dict[str, object]:
    require_access(request, x_automation_token)
    return build_alerts_payload()


def build_alerts_payload() -> dict[str, object]:
    summary = automation_service.task_summary()
    return _build_alerts_payload_from_summary(summary)


def _build_alerts_payload_from_summary(summary: dict[str, int]) -> dict[str, object]:
    completed = summary["completed"]
    failed = summary["failed_completed"]
    failure_rate = (failed / completed) if completed else 0.0
    threshold = _parse_failure_threshold()
    state = "ok" if failure_rate <= threshold else "degraded"
    legacy_alerts = _build_legacy_alerts(
        state=state,
        failure_rate=failure_rate,
        threshold=threshold,
        failed=failed,
        completed=completed,
    )
    return {
        "state": state,
        "failure_rate": round(failure_rate, 4),
        "threshold": threshold,
        "completed": completed,
        "failed": failed,
        # Backward-compatible fields for clients using the previous alerts contract.
        "alerts": legacy_alerts,
        "total": len(legacy_alerts),
    }


def _build_legacy_alerts(
    *, state: str, failure_rate: float, threshold: float, failed: int, completed: int
) -> list[dict[str, str]]:
    if state == "ok":
        return []
    severity = "critical" if failure_rate > (threshold * 1.5) else "warning"
    return [
        {
            "code": "automation_failure_rate_high",
            "severity": severity,
            "message": (
                f"automation failure rate {failure_rate:.4f} exceeded threshold {threshold:.4f} "
                f"(failed={failed}, completed={completed})"
            ),
        }
    ]


def _parse_failure_threshold() -> float:
    raw = env_str("AUTOMATION_FAILURE_ALERT_THRESHOLD", "0.2").strip()
    try:
        value = float(raw)
    except ValueError:
        return 0.2
    return min(1.0, max(0.0, value))


@router.get("/metrics", response_class=PlainTextResponse)
def metrics() -> str:
    return build_prometheus_payload()


def build_prometheus_payload() -> str:
    summary = automation_service.task_summary()
    return runtime_metrics.render_prometheus_text(summary)


@router.post("/rum", status_code=status.HTTP_202_ACCEPTED)
def ingest_rum(
    payload: RumMetricIngestRequest,
    request: Request,
    x_automation_token: str | None = Header(default=None),
) -> dict[str, object]:
    # Keep browser RUM ingestion backward-compatible: anonymous ingestion is allowed but rate-limited.
    # When a token is explicitly provided, enforce full automation access checks.
    provided_token = (x_automation_token or "").strip()
    if provided_token:
        require_access(request, provided_token)
    else:
        require_rate_limit(request)
    normalized_metric = runtime_metrics.record_rum_metric(payload.metric_name, payload.value)
    if normalized_metric is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="unsupported rum metric",
        )
    rum_snapshot = runtime_metrics.snapshot().get("rum", {})
    return {
        "status": "accepted",
        "metric": normalized_metric,
        "samples_total": int(rum_snapshot.get("samples_total", 0))
        if isinstance(rum_snapshot, dict)
        else 0,
    }
