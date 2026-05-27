#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

release_tag="${RELEASE_CANDIDATE_TAG:-}"
output_path="${RELEASE_GATE_OUTPUT:-}"

for arg in "$@"; do
  case "$arg" in
    --tag=*)
      release_tag="${arg#*=}"
      ;;
    --output=*)
      output_path="${arg#*=}"
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$release_tag" ]]; then
  release_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
fi

ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
artifacts_dir=".runtime-cache/release-gate"
mkdir -p "$artifacts_dir"
if [[ -z "$output_path" ]]; then
  output_path="$artifacts_dir/release-gate-${ts//[:]/-}.json"
fi

status="GO_CANDIDATE"
decision="GO_CANDIDATE"
reason_code="ok"
changed_files=0
range_text=""

if [[ -z "$release_tag" ]]; then
  status="BLOCKED"
  decision="NO_GO"
  reason_code="missing_release_candidate_tag"
else
  if ! git rev-parse --verify --quiet "refs/tags/${release_tag}" >/dev/null; then
    status="BLOCKED"
    decision="NO_GO"
    reason_code="release_candidate_tag_not_found"
  else
    range_text="${release_tag}..HEAD"
    changed_files="$(git diff --name-only "$range_text" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
    if [[ "$changed_files" -gt 50 ]]; then
      status="AUDIT_ONLY"
      decision="MANUAL_APPROVAL_REQUIRED"
      reason_code="changed_files_gt_50"
    fi
  fi
fi

python3 - "$output_path" "$ts" "$release_tag" "$range_text" "$changed_files" "$status" "$decision" "$reason_code" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

(
    output_path,
    checked_at,
    release_tag,
    diff_range,
    changed_files,
    status,
    decision,
    reason_code,
) = sys.argv[1:9]

payload = {
    "checked_at": checked_at,
    "release_candidate_tag": release_tag or None,
    "diff_range": diff_range or None,
    "changed_files": int(changed_files),
    "thresholds": {
        "changed_files_audit_only_gt": 50,
    },
    "status": status,
    "decision": decision,
    "reason_code": reason_code,
}
path = Path(output_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(payload, ensure_ascii=False))
PY

cp "$output_path" "$artifacts_dir/latest.json"

echo ""
echo "Release gate summary"
echo "- checked_at: $ts"
echo "- release_candidate_tag: ${release_tag:-<missing>}"
echo "- changed_files: $changed_files"
echo "- status: $status"
echo "- decision: $decision"
echo "- reason_code: $reason_code"
echo "- report: $output_path"

if [[ "$status" == "BLOCKED" || "$decision" == "MANUAL_APPROVAL_REQUIRED" ]]; then
  exit 1
fi
