#!/usr/bin/env python3
import json
import os
from pathlib import Path


def main() -> None:
    log_path = Path(".runtime-cache/artifacts/ci/branch-protection-audit.log")
    report_path = Path(".runtime-cache/artifacts/ci/branch-protection-audit.json")
    log = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
    status = report.get("status", "missing")
    exit_code = report.get("exit_code", "unknown")
    required_checks = report.get("required_checks") or []
    required_count = len(required_checks)
    aggregate_name = required_checks[0] if len(required_checks) == 1 else ", ".join(required_checks) or "unknown"
    reason = report.get("reason") or "unknown"
    repo = report.get("repo") or os.environ.get("UIQ_BRANCH_PROTECTION_REPO", "")
    branch = report.get("branch") or os.environ.get("UIQ_BRANCH_PROTECTION_BRANCH", "main")
    summary = Path(".runtime-cache/artifacts/ci/branch-protection-audit.md")
    lines = [
        "# Branch Protection Audit",
        "",
        f"- Repo: `{repo}`",
        f"- Branch: `{branch}`",
        f"- Result: `{status.upper()}`",
        f"- Exit code: `{exit_code}`",
        f"- Reason: `{reason}`",
        f"- Required checks count: `{required_count}`",
        f"- Required checks: `{aggregate_name}`",
        "- Evidence files:",
        "  - `.runtime-cache/artifacts/ci/branch-protection-audit.json`",
        "  - `.runtime-cache/artifacts/ci/branch-protection-audit.log`",
        "  - `.runtime-cache/artifacts/ci/branch-protection-audit.md`",
    ]
    if reason == "missing_privileged_token":
        lines.extend(
            [
                "",
                "> Branch protection truth is blocked because no GitHub token was available for this run.",
                "> This is a workflow/runtime blocker, not proof of current branch protection state.",
            ]
        )
    elif status == "blocked":
        lines.extend(
            [
                "",
                "> Remote branch-protection truth is currently blocked by external GitHub feature or permission state.",
                "> Treat this artifact bundle as the audit evidence surface until the external dependency is resolved.",
            ]
        )
    elif not log:
        lines.extend(["", "> Audit log was not captured; inspect workflow step output."])
    summary.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
