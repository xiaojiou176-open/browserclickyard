#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    report_path = Path(os.environ["UIQ_BRANCH_PROTECTION_REPORT_PATH"])
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "blocked",
        "reason": "missing_privileged_token",
        "exit_code": 2,
        "repo": os.environ.get("UIQ_BRANCH_PROTECTION_REPO", ""),
        "branch": os.environ.get("UIQ_BRANCH_PROTECTION_BRANCH", "main"),
        "allowed_aggregate_checks": [],
        "required_checks": [],
        "feature_blocked": False,
    }
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
