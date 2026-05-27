#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/check-branch-protection.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

repo_dir="$tmp_dir/repo"
bin_dir="$tmp_dir/bin"
mkdir -p "$repo_dir" "$bin_dir"

git -C "$repo_dir" init -q
git -C "$repo_dir" checkout -q -b main
git -C "$repo_dir" remote add origin "https://github.com/example-org/example-repo.git"

write_fake_gh() {
  local body="$1"
  cat >"$bin_dir/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "$body" >&2
exit 1
EOF
  chmod +x "$bin_dir/gh"
}

run_case() {
  local label="$1"
  local gh_stderr="$2"
  local expected_reason="$3"
  local report_path="$tmp_dir/${label}.json"

  write_fake_gh "$gh_stderr"
  (
    cd "$repo_dir"
    set +e
    PATH="$bin_dir:$PATH" \
      UIQ_BRANCH_PROTECTION_REPORT_PATH="$report_path" \
      bash "$ROOT_DIR/scripts/ci/check-branch-protection.sh" --branch main >/dev/null 2>&1
    rc=$?
    set -e
    if [[ "$rc" -ne 2 ]]; then
      echo "expected exit 2 for $label, got $rc" >&2
      exit 1
    fi
  )

  python3 - "$report_path" "$expected_reason" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = sys.argv[2]
actual = report.get("reason")
if actual != expected:
    raise SystemExit(f"expected reason={expected!r}, got {actual!r}")
if report.get("status") != "blocked":
    raise SystemExit(f"expected status='blocked', got {report.get('status')!r}")
PY
}

run_case "http404" "gh: Not Found (HTTP 404)" "github_repo_or_branch_inaccessible"
run_case "http403" "gh: Forbidden (HTTP 403)" "github_auth_forbidden"
run_case "authmissing" "error: authentication required" "github_auth_missing"

echo "check-branch-protection reason mapping checks passed"
