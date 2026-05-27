#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
DEFAULT_ALLOWED_AGGREGATES="pr_required_gate"
REPORT_PATH="${UIQ_BRANCH_PROTECTION_REPORT_PATH:-}"
report_status=""
report_reason=""
report_exit_code=""
report_feature_blocked=0
required_checks=()

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ci/check-branch-protection.sh [--branch <name>] [--repo <owner/name>] [--aggregate <check1,check2>]

Checks whether branch protection required checks are reduced to one aggregate check.

Options:
  --branch <name>       Branch to inspect. Default: current git branch.
  --repo <owner/name>   Repository to inspect. Default: inferred from remote.origin.url.
  --aggregate <csv>     Allowed aggregate checks. Default: pr_required_gate
  -h, --help            Show help.

Examples:
  bash scripts/ci/check-branch-protection.sh
  bash scripts/ci/check-branch-protection.sh --branch main --aggregate pr_required_gate
  bash scripts/ci/check-branch-protection.sh --repo octo-org/octo-repo --branch release
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

write_report() {
  local actual_exit_code="$1"
  local final_exit_code final_status required_checks_json allowed_aggregates_json
  if [[ -z "${REPORT_PATH}" ]]; then
    return 0
  fi

  final_exit_code="${report_exit_code:-$actual_exit_code}"
  final_status="${report_status}"
  if [[ -z "${final_status}" ]]; then
    case "${final_exit_code}" in
      0) final_status="passed" ;;
      1) final_status="failed" ;;
      *) final_status="blocked" ;;
    esac
  fi

  required_checks_json="$(printf '%s\n' "${required_checks[@]}" | python3 -c 'import json,sys; print(json.dumps([line.rstrip("\n") for line in sys.stdin if line.rstrip("\n")], ensure_ascii=False))')"
  allowed_aggregates_json="$(printf '%s\n' "${allowed_aggregates}" | python3 -c 'import json,sys; raw=sys.stdin.read().strip(); items=[item.strip() for item in raw.split(",") if item.strip()]; print(json.dumps(items, ensure_ascii=False))')"

  mkdir -p "$(dirname "${REPORT_PATH}")"
  UIQ_BP_REPORT_PATH="${REPORT_PATH}" \
  UIQ_BP_REPORT_STATUS="${final_status}" \
  UIQ_BP_REPORT_REASON="${report_reason}" \
  UIQ_BP_REPORT_EXIT_CODE="${final_exit_code}" \
  UIQ_BP_REPORT_REPO="${repo}" \
  UIQ_BP_REPORT_BRANCH="${branch}" \
  UIQ_BP_REPORT_ALLOWED_AGGREGATES_JSON="${allowed_aggregates_json}" \
  UIQ_BP_REPORT_REQUIRED_CHECKS_JSON="${required_checks_json}" \
  UIQ_BP_REPORT_FEATURE_BLOCKED="${report_feature_blocked}" \
  python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

payload = {
    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": os.environ["UIQ_BP_REPORT_STATUS"],
    "reason": os.environ["UIQ_BP_REPORT_REASON"] or None,
    "exit_code": int(os.environ["UIQ_BP_REPORT_EXIT_CODE"]),
    "repo": os.environ["UIQ_BP_REPORT_REPO"] or None,
    "branch": os.environ["UIQ_BP_REPORT_BRANCH"] or None,
    "allowed_aggregate_checks": json.loads(os.environ["UIQ_BP_REPORT_ALLOWED_AGGREGATES_JSON"]),
    "required_checks": json.loads(os.environ["UIQ_BP_REPORT_REQUIRED_CHECKS_JSON"]),
    "feature_blocked": os.environ["UIQ_BP_REPORT_FEATURE_BLOCKED"] == "1",
}

Path(os.environ["UIQ_BP_REPORT_PATH"]).write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

infer_repo_from_git() {
  local remote_url host path
  remote_url="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "${remote_url}" ]]; then
    return 1
  fi

  if [[ "${remote_url}" =~ ^git@([^:]+):(.+)$ ]]; then
    host="${BASH_REMATCH[1]}"
    path="${BASH_REMATCH[2]}"
  elif [[ "${remote_url}" =~ ^https?://([^/]+)/(.+)$ ]]; then
    host="${BASH_REMATCH[1]}"
    path="${BASH_REMATCH[2]}"
  else
    return 1
  fi

  path="${path%.git}"
  if [[ "${host}" != "github.com" ]]; then
    return 1
  fi

  printf '%s' "${path}"
}

print_auth_fix_steps() {
  local repo="$1"
  local branch="$2"

  cat <<EOF
[$SCRIPT_NAME] Unable to query branch protection via GitHub API.

Step-by-step fix:
1) Check current auth status
   gh auth status

2) Login with required scopes (repo/read:org)
   gh auth login --hostname github.com --web --git-protocol https --scopes repo,read:org

3) Verify repository access
   gh repo view ${repo}

4) Verify target branch exists
   gh api repos/${repo}/branches/${branch} --jq '.name'

5) Re-run this check
   bash scripts/ci/check-branch-protection.sh --repo ${repo} --branch ${branch}

If step 3/4 fails but auth is valid, request maintainer/admin permission to read branch protection settings.
EOF
}

branch=""
repo=""
allowed_aggregates="${UIQ_REQUIRED_AGGREGATE_CHECKS:-${DEFAULT_ALLOWED_AGGREGATES}}"
trap 'write_report "$?"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -lt 2 ]] && usage >&2 && exit 2
      branch="$2"
      shift 2
      ;;
    --repo)
      [[ $# -lt 2 ]] && usage >&2 && exit 2
      repo="$2"
      shift 2
      ;;
    --aggregate)
      [[ $# -lt 2 ]] && usage >&2 && exit 2
      allowed_aggregates="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[$SCRIPT_NAME] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  report_reason="gh_cli_missing"
  report_exit_code=2
  echo "[$SCRIPT_NAME] ERROR: GitHub CLI (gh) is required." >&2
  echo "Install: https://cli.github.com/" >&2
  exit 2
fi

if [[ -z "${branch}" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [[ -z "${branch}" || "${branch}" == "HEAD" ]]; then
  report_reason="branch_inference_failed"
  report_exit_code=2
  echo "[$SCRIPT_NAME] ERROR: cannot infer branch. Use --branch <name>." >&2
  exit 2
fi

if [[ -z "${repo}" ]]; then
  repo="$(infer_repo_from_git || true)"
fi
if [[ -z "${repo}" ]]; then
  report_reason="repo_inference_failed"
  report_exit_code=2
  echo "[$SCRIPT_NAME] ERROR: cannot infer repository. Use --repo <owner/name>." >&2
  exit 2
fi

api_path="repos/${repo}/branches/${branch}/protection"
tmp_err="$(mktemp)"
set +e
protection_json="$(gh api -H "Accept: application/vnd.github+json" "${api_path}" 2>"${tmp_err}")"
gh_exit=$?
set -e
if [[ ${gh_exit} -ne 0 ]]; then
  if grep -q "Branch not protected" "${tmp_err}" 2>/dev/null; then
    branch_json="$(gh api -H "Accept: application/vnd.github+json" "repos/${repo}/branches/${branch}" 2>"${tmp_err}")" || {
      report_reason="gh_api_failed"
      report_exit_code=2
      echo "[$SCRIPT_NAME] gh api failed:" >&2
      sed 's/^/  /' "${tmp_err}" >&2 || true
      rm -f "${tmp_err}"
      print_auth_fix_steps "${repo}" "${branch}"
      exit 2
    }
    if [[ "$(python3 -c 'import json,sys; data=json.load(sys.stdin); print("true" if data.get("protected") else "false")' <<<"${branch_json}")" == "true" ]]; then
      protection_json="$(python3 -c 'import json,sys
data=json.load(sys.stdin)
print(json.dumps({"required_status_checks": (data.get("protection") or {}).get("required_status_checks") or {}}, ensure_ascii=False))' <<<"${branch_json}")"
      gh_exit=0
    else
      report_reason="branch_not_protected"
      report_exit_code=1
      echo "[$SCRIPT_NAME] FAIL: branch '${branch}' is not protected." >&2
      rm -f "${tmp_err}"
      exit 1
    fi
  else
    report_reason="gh_api_failed"
    report_exit_code=2
    echo "[$SCRIPT_NAME] gh api failed:" >&2
    sed 's/^/  /' "${tmp_err}" >&2 || true
    if grep -q "HTTP 404" "${tmp_err}" 2>/dev/null; then
      report_reason="github_repo_or_branch_not_visible"
    elif grep -q "HTTP 403" "${tmp_err}" 2>/dev/null; then
      report_reason="github_auth_or_permission_denied"
    fi
    if grep -q "Upgrade to GitHub Pro or make this repository public" "${tmp_err}" 2>/dev/null; then
      report_reason="github_feature_unavailable"
      report_feature_blocked=1
      echo "[$SCRIPT_NAME] remote branch-protection truth is currently blocked by GitHub feature availability for this repository." >&2
      echo "[$SCRIPT_NAME] use the scheduled/manual branch-protection-audit workflow artifacts as the external evidence surface when available." >&2
    elif grep -q "HTTP 404" "${tmp_err}" 2>/dev/null; then
      report_reason="github_repo_or_branch_inaccessible"
    elif grep -q "HTTP 403" "${tmp_err}" 2>/dev/null; then
      report_reason="github_auth_forbidden"
    elif grep -Eqi "authentication required|not logged in" "${tmp_err}" 2>/dev/null; then
      report_reason="github_auth_missing"
    fi
    rm -f "${tmp_err}"
    print_auth_fix_steps "${repo}" "${branch}"
    exit 2
  fi
fi
rm -f "${tmp_err}"

required_checks=()
while IFS= read -r line; do
  required_checks+=("${line}")
done < <(
  python3 -c 'import json,sys
data=json.loads(sys.stdin.read())
r=data.get("required_status_checks") or {}
checks=[(x or {}).get("context","").strip() for x in (r.get("checks") or [])]
contexts=[x.strip() for x in (r.get("contexts") or []) if isinstance(x,str)]
merged=[x for x in checks+contexts if x]
seen=set()
for item in merged:
    if item not in seen:
        seen.add(item)
        print(item)
' <<<"${protection_json}"
)

echo "[$SCRIPT_NAME] Repo: ${repo}"
echo "[$SCRIPT_NAME] Branch: ${branch}"
echo "[$SCRIPT_NAME] Allowed aggregate checks: ${allowed_aggregates}"

count="${#required_checks[@]}"
if [[ "${count}" -eq 0 ]]; then
  report_status="failed"
  report_reason="missing_required_status_checks"
  report_exit_code=1
  echo "[$SCRIPT_NAME] FAIL: branch protection has no required status checks configured."
  exit 1
fi

echo "[$SCRIPT_NAME] Required checks (${count}):"
for check in "${required_checks[@]}"; do
  echo "  - ${check}"
done

if [[ "${count}" -ne 1 ]]; then
  report_status="failed"
  report_reason="multiple_required_checks"
  report_exit_code=1
  echo "[$SCRIPT_NAME] FAIL: expected exactly one required aggregate check, got ${count}."
  echo "[$SCRIPT_NAME] Hint: keep only one aggregate check in Branch Protection settings."
  exit 1
fi

only_check="${required_checks[0]}"
is_allowed=0
IFS=',' read -r -a allowed_list <<<"${allowed_aggregates}"
for expected in "${allowed_list[@]}"; do
  expected="$(trim "${expected}")"
  if [[ -n "${expected}" && "${only_check}" == "${expected}" ]]; then
    is_allowed=1
    break
  fi
done

if [[ "${is_allowed}" -ne 1 ]]; then
  report_status="failed"
  report_reason="disallowed_required_check"
  report_exit_code=1
  echo "[$SCRIPT_NAME] FAIL: required check '${only_check}' is not in allowed aggregate list."
  echo "[$SCRIPT_NAME] Allowed: ${allowed_aggregates}"
  exit 1
fi

report_status="passed"
report_reason="single_allowed_aggregate_check"
report_exit_code=0
echo "[$SCRIPT_NAME] PASS: branch protection uses a single aggregate required check (${only_check})."
