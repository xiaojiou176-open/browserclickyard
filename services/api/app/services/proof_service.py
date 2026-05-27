from __future__ import annotations

import json
from math import sqrt
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.runtime_paths import automation_runtime_root, repo_root, runtime_path
from app.models.proof import ProofCampaignRecord
from app.services.embedding_service import EmbeddingServiceError, embedding_service
from app.services.target_feasibility_service import target_feasibility_service
from app.services.universal_platform_service import universal_platform_service


class ProofService:
    def __init__(self) -> None:
        self._root = repo_root()
        self._runtime_root = automation_runtime_root(self._root)
        self._campaign_ledger_path = self._runtime_root / "universal" / "proof-campaigns.json"
        self._campaign_artifacts_root = runtime_path("artifacts", "proof-campaigns", root=self._root)
        self._lock = Lock()

    def list_campaigns(
        self, *, limit: int = 100, requester: str | None = None
    ) -> list[ProofCampaignRecord]:
        records = [ProofCampaignRecord.model_validate(item) for item in self._read_json(self._campaign_ledger_path)]
        if requester:
            records = [item for item in records if item.created_by == requester]
        records.sort(key=lambda item: item.updated_at, reverse=True)
        return records[: max(1, min(limit, 200))]

    def get_campaign(self, campaign_id: str, *, requester: str | None = None) -> dict[str, Any]:
        record = self._get_campaign_record(campaign_id, requester=requester)
        report_path = self._root / record.report_path
        if not report_path.exists():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"proof campaign report missing: {record.report_path}",
            )
        report = json.loads(report_path.read_text(encoding="utf-8"))
        return {"campaign": record, "report": report}

    def create_campaign(
        self,
        *,
        run_ids: list[str],
        model: str,
        name: str | None,
        description: str | None,
        actor: str | None,
    ) -> dict[str, Any]:
        clean_run_ids = [run_id.strip() for run_id in run_ids if run_id and run_id.strip()]
        if not clean_run_ids:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="run_ids must contain at least one run",
            )
        campaign_id = f"pc_{uuid4().hex}"
        report = self._build_campaign_report(
            campaign_id=campaign_id,
            model=model,
            name=name,
            description=description,
            run_ids=clean_run_ids,
        )
        artifact_dir = self._campaign_artifacts_root / campaign_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        report_path = artifact_dir / "campaign.report.json"
        index_path = artifact_dir / "campaign.index.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        index_path.write_text(
            json.dumps(
                {
                    "campaignId": campaign_id,
                    "generatedAt": report["generatedAt"],
                    "ok": report["ok"],
                    "policyMode": report["policyMode"],
                    "reasonCodes": report["reasonCodes"],
                    "runIds": report["runIds"],
                    "stats": report["stats"],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        now = datetime.now(UTC)
        record = ProofCampaignRecord(
            campaign_id=campaign_id,
            model=model,
            name=name,
            description=description,
            created_by=actor,
            created_at=now,
            updated_at=now,
            status="passed" if report["ok"] else "failed",
            policy_mode=str(report["policyMode"]),
            run_ids=clean_run_ids,
            reason_codes=[str(item) for item in report["reasonCodes"]],
            report_path=str(report_path.relative_to(self._root)),
            index_path=str(index_path.relative_to(self._root)),
        )
        with self._lock:
            payload = self._read_json(self._campaign_ledger_path)
            payload.append(record.model_dump(mode="json"))
            self._write_json(self._campaign_ledger_path, payload)
        return {"campaign": record, "report": report}

    def diff_campaigns(
        self,
        *,
        left_campaign_id: str,
        right_campaign_id: str,
        requester: str | None = None,
    ) -> dict[str, Any]:
        left = self.get_campaign(left_campaign_id, requester=requester)
        right = self.get_campaign(right_campaign_id, requester=requester)
        left_report = left["report"]
        right_report = right["report"]
        diff = self._build_campaign_diff(left_report, right_report)
        diff_dir = self._campaign_artifacts_root / right_campaign_id
        diff_dir.mkdir(parents=True, exist_ok=True)
        diff_path = diff_dir / f"campaign.diff.{left_campaign_id}.json"
        diff_path.write_text(json.dumps(diff, ensure_ascii=False, indent=2), encoding="utf-8")
        return {
            "left_campaign_id": left_campaign_id,
            "right_campaign_id": right_campaign_id,
            "diff": diff,
        }

    def compare_runs(
        self, *, left_run_id: str, right_run_id: str, requester: str | None = None
    ) -> dict[str, Any]:
        universal_platform_service.get_run(left_run_id, requester=requester)
        universal_platform_service.get_run(right_run_id, requester=requester)
        left = self._read_run_bundle(left_run_id)
        right = self._read_run_bundle(right_run_id)
        left_failures = {item["id"] for item in self._extract_failed_checks(left)}
        right_failures = {item["id"] for item in self._extract_failed_checks(right)}
        metric_keys = [
            "consoleError",
            "pageError",
            "http5xx",
            "a11ySerious",
            "perfLcpMs",
            "perfFcpMs",
            "visualDiffPixels",
            "loadFailedRequests",
            "loadP95Ms",
            "loadRps",
            "aiReviewFindings",
            "aiReviewHighOrAbove",
        ]
        values: dict[str, int | float | None] = {}
        left_summary = left.get("summary", {})
        right_summary = right.get("summary", {})
        for key in metric_keys:
            left_value = left_summary.get(key)
            right_value = right_summary.get(key)
            if isinstance(left_value, (int, float)) and isinstance(right_value, (int, float)):
                values[key] = right_value - left_value
            else:
                values[key] = None
        return {
            "left_run_id": left_run_id,
            "right_run_id": right_run_id,
            "left_gate_status": self._gate_status(left),
            "right_gate_status": self._gate_status(right),
            "metrics_delta": {"values": values},
            "checks": {
                "added_failed_or_blocked": sorted(right_failures - left_failures),
                "removed_failed_or_blocked": sorted(left_failures - right_failures),
                "persisted_failed_or_blocked": sorted(left_failures & right_failures),
            },
            "summary": {
                "left_reason_codes": sorted(
                    {item.get("reasonCode", "") for item in self._extract_failed_checks(left)}
                ),
                "right_reason_codes": sorted(
                    {item.get("reasonCode", "") for item in self._extract_failed_checks(right)}
                ),
            },
        }

    def read_run_ai_review(self, *, run_id: str, requester: str | None = None) -> dict[str, Any]:
        universal_platform_service.get_run(run_id, requester=requester)
        bundle = self._read_run_bundle(run_id)
        report_ref = (
            bundle.get("reports", {}).get("aiReview")
            or bundle.get("diagnostics", {}).get("aiReview", {}).get("reportPath")
        )
        if not report_ref:
            return {
                "run_id": run_id,
                "enabled": False,
                "report_path": None,
                "markdown_path": None,
                "findings": [],
                "summary": {},
                "generation": {},
            }
        report_path = self._safe_run_path(run_id, str(report_ref))
        if not report_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"ai review report not found: {report_ref}",
            )
        report = json.loads(report_path.read_text(encoding="utf-8"))
        return {
            "run_id": run_id,
            "enabled": True,
            "report_path": str(report_ref),
            "markdown_path": bundle.get("reports", {}).get("aiReviewMarkdown"),
            "findings": report.get("findings", []) if isinstance(report, dict) else [],
            "summary": report.get("summary", {}) if isinstance(report, dict) else {},
            "generation": report.get("generation", {}) if isinstance(report, dict) else {},
        }

    def build_release_brief(
        self,
        *,
        run_id: str,
        baseline_run_id: str | None = None,
        requester: str | None = None,
    ) -> dict[str, Any]:
        universal_platform_service.get_run(run_id, requester=requester)
        bundle = self._read_run_bundle(run_id)
        failed_checks = self._extract_failed_checks(bundle)
        ai_review = self.read_run_ai_review(run_id=run_id, requester=requester)
        compare_payload = None
        if baseline_run_id and baseline_run_id != run_id:
            compare_payload = self.compare_runs(
                left_run_id=baseline_run_id,
                right_run_id=run_id,
                requester=requester,
            )
        gate_status = self._gate_status(bundle)
        reports = bundle.get("reports", {}) if isinstance(bundle.get("reports"), dict) else {}
        ai_summary = ai_review.get("summary", {}) if isinstance(ai_review.get("summary"), dict) else {}
        severity_groups = self._group_findings(ai_review.get("findings", []))
        high_or_above = self._read_number(ai_summary.get("highOrAbove"))
        if high_or_above is None:
            high_or_above = severity_groups["critical"] + severity_groups["high"]
        total_findings = self._read_number(ai_summary.get("totalFindings"))
        if total_findings is None:
            total_findings = len(ai_review.get("findings", []))
        compare_added = (
            compare_payload.get("checks", {}).get("added_failed_or_blocked", [])
            if isinstance(compare_payload, dict)
            else []
        )
        compare_persisted = (
            compare_payload.get("checks", {}).get("persisted_failed_or_blocked", [])
            if isinstance(compare_payload, dict)
            else []
        )
        recommendation, next_step = self._recommend_release_action(
            gate_status=gate_status,
            failed_checks=failed_checks,
            added_failures=compare_added,
            persisted_failures=compare_persisted,
            high_or_above=high_or_above,
            ai_enabled=bool(ai_review.get("enabled")),
        )
        report_paths = {
            "summary": reports.get("report") or "reports/summary.json",
            "ai_review": ai_review.get("report_path"),
            "ai_markdown": ai_review.get("markdown_path"),
        }
        open_questions: list[str] = []
        if not ai_review.get("enabled"):
            open_questions.append("AI review report is not available for this run yet.")
        if not baseline_run_id:
            open_questions.append(
                "Compare against a baseline run if you need stronger regression context."
            )
        if gate_status not in {"passed", "failed", "blocked"}:
            open_questions.append("Gate status is incomplete or unavailable in the current bundle.")
        return {
            "run_id": run_id,
            "baseline_run_id": baseline_run_id,
            "recommendation": recommendation,
            "gate_status": gate_status,
            "observed": {
                "failed_check_count": len(failed_checks),
                "failed_checks": failed_checks[:5],
                "compare": compare_payload,
            },
            "ai_interpretation": {
                "enabled": bool(ai_review.get("enabled")),
                "findings_total": total_findings,
                "high_or_above": high_or_above,
                "severity_groups": severity_groups,
            },
            "evidence_snapshot": {
                "report_paths": report_paths,
                "failed_check_paths": [
                    {
                        "id": item.get("id"),
                        "reasonCode": item.get("reasonCode"),
                        "evidencePath": item.get("evidencePath"),
                    }
                    for item in failed_checks[:5]
                ],
            },
            "open_questions": open_questions,
            "next_step": next_step,
        }

    def find_similar_failures(
        self,
        *,
        run_id: str,
        limit: int = 5,
        requester: str | None = None,
    ) -> dict[str, Any]:
        current_run = universal_platform_service.get_run(run_id, requester=requester)
        current_bundle = self._read_run_bundle(run_id)
        current_text = self._build_similarity_text(current_run, current_bundle)
        candidates: list[dict[str, Any]] = []
        for candidate_run in universal_platform_service.list_runs(limit=100, requester=requester):
            if candidate_run.run_id == run_id:
                continue
            try:
                candidate_bundle = self._read_run_bundle(candidate_run.run_id)
            except HTTPException:
                continue
            if self._gate_status(candidate_bundle) not in {"failed", "blocked"} and candidate_run.status not in {
                "failed",
                "waiting_user",
                "waiting_otp",
            }:
                continue
            candidates.append(
                {
                    "run": candidate_run,
                    "bundle": candidate_bundle,
                    "text": self._build_similarity_text(candidate_run, candidate_bundle),
                    "reason_codes": sorted(
                        {
                            str(item.get("reasonCode") or "")
                            for item in self._extract_failed_checks(candidate_bundle)
                            if item.get("reasonCode")
                        }
                    ),
                    "report_path": (
                        candidate_bundle.get("reports", {}).get("report")
                        if isinstance(candidate_bundle.get("reports"), dict)
                        else None
                    ),
                }
            )
            if len(candidates) >= 50:
                break
        if not candidates:
            return {"run_id": run_id, "matches": []}
        try:
            embedding_result = embedding_service.embed_texts(
                [current_text] + [candidate["text"] for candidate in candidates]
            )
        except EmbeddingServiceError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        query_vector = embedding_result.vectors[0]
        current_reasons = sorted(
            {
                str(item.get("reasonCode") or "")
                for item in self._extract_failed_checks(current_bundle)
                if item.get("reasonCode")
            }
        )
        matches: list[dict[str, Any]] = []
        for index, candidate in enumerate(candidates, start=1):
            score = self._cosine_similarity(query_vector, embedding_result.vectors[index])
            overlap = sorted(set(current_reasons) & set(candidate["reason_codes"]))
            candidate_bundle = candidate["bundle"]
            candidate_summary = (
                candidate_bundle.get("summary", {})
                if isinstance(candidate_bundle.get("summary"), dict)
                else {}
            )
            matches.append(
                {
                    "run_id": candidate["run"].run_id,
                    "score": round(score, 4),
                    "gate_status": self._gate_status(candidate_bundle),
                    "reason_codes": candidate["reason_codes"],
                    "summary": {
                        "shared_reason_codes": overlap,
                        "metrics": {
                            key: candidate_summary.get(key)
                            for key in ("a11ySerious", "perfLcpMs", "perfFcpMs", "loadFailedRequests")
                            if key in candidate_summary
                        },
                    },
                    "why_matched": self._why_matched(overlap, score),
                    "report_path": candidate["report_path"],
                }
            )
        matches.sort(key=lambda item: item["score"], reverse=True)
        return {"run_id": run_id, "matches": matches[:limit]}

    def evaluate_template_target(
        self, *, template_id: str, target_name: str, requester: str | None = None
    ) -> dict[str, Any]:
        template = universal_platform_service.get_template(template_id, requester=requester)
        flow = universal_platform_service.get_flow(template.flow_id, requester=requester)
        return target_feasibility_service.evaluate_template(template, flow, target_name=target_name)

    def _get_campaign_record(
        self, campaign_id: str, *, requester: str | None = None
    ) -> ProofCampaignRecord:
        for item in self._read_json(self._campaign_ledger_path):
            record = ProofCampaignRecord.model_validate(item)
            if record.campaign_id != campaign_id:
                continue
            if requester and record.created_by and record.created_by != requester:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="proof campaign not found",
                )
            return record
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="proof campaign not found")

    def _build_campaign_report(
        self,
        *,
        campaign_id: str,
        model: str,
        name: str | None,
        description: str | None,
        run_ids: list[str],
    ) -> dict[str, Any]:
        run_reports = [self._build_run_snapshot(run_id) for run_id in run_ids]
        valid_reports = [item for item in run_reports if item.get("ok") is True]
        gate_passed = [item for item in valid_reports if item.get("gateStatus") == "passed"]
        evidence_ratios = [
            float(item.get("evidenceCoverage", {}).get("ratio", 0))
            for item in valid_reports
            if isinstance(item.get("evidenceCoverage"), dict)
        ]
        invalid_runs = [
            str(item.get("runId") or "unknown") for item in run_reports if item.get("ok") is not True
        ]
        critical_missing: list[dict[str, Any]] = []
        for item in valid_reports:
            evidence = item.get("evidence", {})
            if not isinstance(evidence, dict):
                continue
            missing = [key for key in ["gate", "a11y", "perf", "visual", "security"] if evidence.get(key) is not True]
            if missing:
                critical_missing.append({"runId": item["runId"], "missing": missing})
        reason_codes: list[str] = []
        if invalid_runs:
            reason_codes.append("INVALID_RUN_PRESENT")
        if critical_missing:
            reason_codes.append("CRITICAL_EVIDENCE_MISSING")
        return {
            "campaignId": campaign_id,
            "model": model,
            "name": name,
            "description": description,
            "generatedAt": datetime.now(UTC).isoformat(),
            "runIds": run_ids,
            "ok": len(reason_codes) == 0,
            "policyMode": "strict",
            "reasonCodes": reason_codes,
            "policy": {
                "ok": len(reason_codes) == 0,
                "reasonCodes": reason_codes,
                "invalidRuns": invalid_runs,
                "criticalEvidenceMissing": critical_missing,
            },
            "stats": {
                "runCount": len(run_reports),
                "validRunCount": len(valid_reports),
                "gatePassedCount": len(gate_passed),
                "gatePassRate": round((len(gate_passed) / len(valid_reports)), 4) if valid_reports else 0,
                "avgEvidenceCoverage": round(sum(evidence_ratios) / len(evidence_ratios), 4)
                if evidence_ratios
                else 0,
            },
            "runReports": run_reports,
        }

    def _build_campaign_diff(self, left_report: dict[str, Any], right_report: dict[str, Any]) -> dict[str, Any]:
        left_stats = left_report.get("stats", {}) if isinstance(left_report, dict) else {}
        right_stats = right_report.get("stats", {}) if isinstance(right_report, dict) else {}
        def num(payload: dict[str, Any], key: str) -> float:
            value = payload.get(key)
            return float(value) if isinstance(value, (int, float)) else 0.0
        return {
            "campaignA": left_report.get("campaignId"),
            "campaignB": right_report.get("campaignId"),
            "generatedAt": datetime.now(UTC).isoformat(),
            "delta": {
                "runCount": num(right_stats, "runCount") - num(left_stats, "runCount"),
                "validRunCount": num(right_stats, "validRunCount") - num(left_stats, "validRunCount"),
                "gatePassedCount": num(right_stats, "gatePassedCount") - num(left_stats, "gatePassedCount"),
                "gatePassRate": round(num(right_stats, "gatePassRate") - num(left_stats, "gatePassRate"), 4),
                "avgEvidenceCoverage": round(
                    num(right_stats, "avgEvidenceCoverage") - num(left_stats, "avgEvidenceCoverage"),
                    4,
                ),
            },
        }

    def _build_run_snapshot(self, run_id: str) -> dict[str, Any]:
        try:
            bundle = self._read_run_bundle(run_id)
        except HTTPException as exc:
            return {"runId": run_id, "ok": False, "detail": exc.detail}
        failed_checks = self._extract_failed_checks(bundle)
        evidence = {
            "gate": bundle.get("gateResults", {}).get("status") is not None,
            "a11y": self._path_exists(run_id, bundle.get("reports", {}).get("a11y")),
            "perf": self._path_exists(run_id, bundle.get("reports", {}).get("perf")),
            "visual": self._path_exists(run_id, bundle.get("reports", {}).get("visual")),
            "security": self._path_exists(run_id, bundle.get("reports", {}).get("security")),
            "aiReview": self._path_exists(run_id, bundle.get("reports", {}).get("aiReview")),
        }
        evidence_total = len(evidence)
        present = len([value for value in evidence.values() if value is True])
        return {
            "runId": run_id,
            "ok": True,
            "gateStatus": self._gate_status(bundle),
            "failedCheckCount": len(failed_checks),
            "failedChecks": [item["id"] for item in failed_checks],
            "evidence": evidence,
            "evidenceCoverage": {
                "present": present,
                "total": evidence_total,
                "ratio": round((present / evidence_total), 4) if evidence_total else 0,
            },
        }

    def _extract_failed_checks(self, bundle: dict[str, Any]) -> list[dict[str, Any]]:
        checks = bundle.get("gateResults", {}).get("checks", [])
        if not isinstance(checks, list):
            return []
        failed: list[dict[str, Any]] = []
        for item in checks:
            if not isinstance(item, dict):
                continue
            status_value = str(item.get("status") or "")
            if status_value not in {"failed", "blocked"}:
                continue
            failed.append(
                {
                    "id": str(item.get("id") or "unknown"),
                    "reasonCode": str(item.get("reasonCode") or ""),
                    "evidencePath": str(item.get("evidencePath") or ""),
                }
            )
        return failed

    def _read_run_bundle(self, run_id: str) -> dict[str, Any]:
        manifest_path = self._safe_run_path(run_id, "manifest.json")
        if not manifest_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"manifest not found for run: {run_id}",
            )
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"manifest invalid for run: {run_id}",
            )
        return payload

    def _safe_run_path(self, run_id: str, relative_path: str) -> Path:
        run_root = runtime_path("artifacts", "runs", run_id, root=self._root)
        candidate = (run_root / relative_path).resolve()
        if not str(candidate).startswith(str(run_root.resolve())):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"invalid run artifact path: {relative_path}",
            )
        return candidate

    def _path_exists(self, run_id: str, relative_path: Any) -> bool:
        if not isinstance(relative_path, str) or not relative_path.strip():
            return False
        try:
            return self._safe_run_path(run_id, relative_path).exists()
        except HTTPException:
            return False

    def _gate_status(self, bundle: dict[str, Any]) -> str | None:
        gate_results = bundle.get("gateResults")
        if not isinstance(gate_results, dict):
            return None
        status_value = gate_results.get("status")
        return str(status_value) if isinstance(status_value, str) else None

    def _read_json(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if not isinstance(payload, list):
            return []
        return [item for item in payload if isinstance(item, dict)]

    def _write_json(self, path: Path, payload: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _group_findings(self, findings: Any) -> dict[str, int]:
        result = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        if not isinstance(findings, list):
            return result
        for item in findings:
            if not isinstance(item, dict):
                continue
            severity = str(item.get("severity") or "").strip().lower()
            if severity in result:
                result[severity] += 1
        return result

    def _recommend_release_action(
        self,
        *,
        gate_status: str | None,
        failed_checks: list[dict[str, Any]],
        added_failures: list[str],
        persisted_failures: list[str],
        high_or_above: int,
        ai_enabled: bool,
    ) -> tuple[str, str]:
        if gate_status in {"failed", "blocked"}:
            return (
                "blocked",
                "Investigate the failed or blocked checks before promoting this candidate.",
            )
        if added_failures or persisted_failures or high_or_above > 0:
            return (
                "investigate",
                "Use the compare details and AI findings to review the highest-risk changes before shipping.",
            )
        if gate_status == "passed" and ai_enabled:
            return (
                "review-ready",
                "The candidate is ready for an operator decision. Verify the evidence snapshot, then choose whether to ship or continue reviewing.",
            )
        return (
            "insufficient-evidence",
            "Collect a compare result or AI review first so this brief can support a stronger decision.",
        )

    def _read_number(self, value: Any) -> int | None:
        if isinstance(value, (int, float)):
            return int(value)
        return None

    def _build_similarity_text(self, run: Any, bundle: dict[str, Any]) -> str:
        run_id = getattr(run, "run_id", None)
        if run_id is None and isinstance(run, dict):
            run_id = run.get("run_id")
        run_status = getattr(run, "status", None)
        if run_status is None and isinstance(run, dict):
            run_status = run.get("status")
        failed_checks = self._extract_failed_checks(bundle)
        reason_codes = ", ".join(
            sorted({str(item.get("reasonCode") or "") for item in failed_checks if item.get("reasonCode")})
        )
        summary = bundle.get("summary", {}) if isinstance(bundle.get("summary"), dict) else {}
        ai_review = None
        try:
            ai_review = self.read_run_ai_review(run_id=str(run_id), requester=None) if run_id else None
        except HTTPException:
            ai_review = None
        ai_summary = ai_review.get("summary", {}) if isinstance(ai_review, dict) else {}
        return "\n".join(
            [
                f"run_id={run_id or 'unknown'}",
                f"status={run_status or 'unknown'}",
                f"gate_status={self._gate_status(bundle) or 'unknown'}",
                f"reason_codes={reason_codes or 'none'}",
                f"a11y={summary.get('a11ySerious', 'n/a')}",
                f"lcp={summary.get('perfLcpMs', 'n/a')}",
                f"load_failed={summary.get('loadFailedRequests', 'n/a')}",
                f"ai_high={ai_summary.get('highOrAbove', 'n/a')}",
                f"ai_total={ai_summary.get('totalFindings', 'n/a')}",
            ]
        )

    def _cosine_similarity(self, left: list[float], right: list[float]) -> float:
        numerator = sum(a * b for a, b in zip(left, right, strict=False))
        left_norm = sqrt(sum(a * a for a in left))
        right_norm = sqrt(sum(b * b for b in right))
        if left_norm == 0 or right_norm == 0:
            return 0.0
        return numerator / (left_norm * right_norm)

    def _why_matched(self, overlap: list[str], score: float) -> str:
        if overlap:
            return f"Shared failure reasons: {', '.join(overlap[:3])} (score {score:.2f})."
        if score >= 0.8:
            return f"High semantic similarity across governed failure evidence (score {score:.2f})."
        return f"Closest available governed failure evidence in the current workspace (score {score:.2f})."


proof_service = ProofService()
