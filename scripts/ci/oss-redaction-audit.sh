#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"

cleanup_node_artifacts() {
  uiq_cleanup_root_node_artifacts "$ROOT_DIR"
}

FRESH_CLONE_ROOT="$(mktemp -d ".runtime-cache/oss-redaction-clone.XXXXXX")"
FRESH_CLONE_DIR="$FRESH_CLONE_ROOT/repo"
trap 'cleanup_node_artifacts; rm -rf "$FRESH_CLONE_ROOT"' EXIT
uiq_repair_shared_module_links "$ROOT_DIR"

REPORT_DIR=".runtime-cache/reports/oss-redaction"
mkdir -p "$REPORT_DIR"

log_step() {
  printf '[oss-redaction] %s\n' "$1"
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[oss-redaction] FAIL: required tool '$tool' is not installed." >&2
    exit 1
  fi
}

extract_github_slug() {
  local remote_url=""
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  case "$remote_url" in
    https://github.com/*)
      remote_url="${remote_url#https://github.com/}"
      ;;
    git@github.com:*)
      remote_url="${remote_url#git@github.com:}"
      ;;
    *)
      echo ""
      return 0
      ;;
  esac
  remote_url="${remote_url%.git}"
  echo "$remote_url"
}

summarize_trufflehog() {
  local report_path="$1"
  python3 - "$report_path" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
verified = 0
unverified = 0
for line in path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line.startswith("{"):
        continue
    row = json.loads(line)
    if "DetectorName" not in row:
        continue
    if row.get("Verified"):
        verified += 1
    else:
        unverified += 1
print(f"verified={verified}")
print(f"unverified={unverified}")
PY
}

scan_github_text_surfaces() {
  local slug="$1"
  local report_path="$2"
  local issues_json="$REPORT_DIR/github-issues.json"
  local issue_comments_json="$REPORT_DIR/github-issue-comments.json"
  local pr_comments_json="$REPORT_DIR/github-pr-comments.json"

  gh api --paginate --slurp "repos/$slug/issues?state=all&per_page=100" >"$issues_json"
  gh api --paginate --slurp "repos/$slug/issues/comments?per_page=100" >"$issue_comments_json"
  gh api --paginate --slurp "repos/$slug/pulls/comments?per_page=100" >"$pr_comments_json"

  python3 - "$issues_json" "$issue_comments_json" "$pr_comments_json" <<'PY' >"$report_path"
import json
import re
import sys
from pathlib import Path

records = []
for arg in sys.argv[1:]:
    payload = json.loads(Path(arg).read_text(encoding="utf-8"))
    if isinstance(payload, list):
        for page in payload:
            if isinstance(page, list):
                records.extend(page)

patterns = {
    "aws_access_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "github_token": re.compile(r"\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b"),
    "openai_like_key": re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    "private_key": re.compile(r"-----BEGIN [A-Z ]+PRIVATE KEY-----"),
    "bearer_token": re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}\b", re.I),
    "session_cookie": re.compile(r"\b(?:session|cookie|csrf|token)[=:][A-Za-z0-9._%+-]{20,}\b", re.I),
}
allow = re.compile(r"(example\.com|users\.noreply\.github\.com|localhost|127\.0\.0\.1)", re.I)

findings = []
for record in records:
    body = str(record.get("body") or "")
    if not body:
        continue
    for label, pattern in patterns.items():
        match = pattern.search(body)
        if not match:
            continue
        if allow.search(match.group(0)):
            continue
        findings.append(
            {
                "type": label,
                "id": record.get("id"),
                "html_url": record.get("html_url"),
                "sample": match.group(0)[:120],
            }
        )

summary = {}
for finding in findings:
    summary[finding["type"]] = summary.get(finding["type"], 0) + 1

print(
    json.dumps(
        {
            "status": "completed",
            "total_records": len(records),
            "summary": summary,
            "sample_findings": findings[:50],
        },
        ensure_ascii=False,
        indent=2,
    )
)
PY
}

run_presidio_advisory() {
  local report_path="$1"
  if ! command -v uvx >/dev/null 2>&1; then
    printf '{\n  "status": "skipped",\n  "reason": "uvx unavailable"\n}\n' >"$report_path"
    return 0
  fi
  uvx --from presidio-analyzer python - <<'PY' >"$report_path"
import json
import re
import subprocess
from pathlib import Path
from presidio_analyzer import Pattern, PatternRecognizer

repo = Path(".")
files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
text_exts = {".md", ".txt", ".rst", ".yml", ".yaml", ".json", ".jsonl", ".csv", ".ts", ".tsx", ".js", ".mjs", ".py", ".sh", ".env", ".example"}
scan_files = []
for rel in files:
    path = repo / rel
    if not path.exists() or not path.is_file():
        continue
    if any(part in {".git", "node_modules", ".runtime-cache", "dist", "build", "coverage", "test-results"} for part in path.parts):
        continue
    if path.suffix.lower() in text_exts or path.name in {"README", "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".env.example"}:
        scan_files.append(path)

recognizers = [
    PatternRecognizer(supported_entity="EMAIL_ADDRESS", patterns=[Pattern("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", 0.7)]),
    PatternRecognizer(supported_entity="IP_ADDRESS", patterns=[Pattern("ipv4", r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)", 0.55)]),
    PatternRecognizer(supported_entity="URL", patterns=[Pattern("url", r"https?://[^\s)\]\">`]+", 0.55)]),
]

allow_email = re.compile(r"(@example\.(com|org|net)$|@users\.noreply\.github\.com$|@localhost$)", re.I)
allow_url = re.compile(r"(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net)|schemas\.openxmlformats\.org|opensource\.org|github\.com|docs\.github\.com|python\.org|nodejs\.org|pnpm\.io|pypi\.org|npmjs\.com|registry\.npmjs\.org|repo\.maven\.apache\.org)", re.I)
allow_ip = re.compile(r"^(127\.0\.0\.1|0\.0\.0\.0)$")

results = []
for path in scan_files:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for recognizer in recognizers:
        entity = recognizer.supported_entities[0]
        for match in recognizer.analyze(text=text, entities=[entity], nlp_artifacts=None):
            snippet = text[match.start:match.end][:200]
            if entity == "EMAIL_ADDRESS" and allow_email.search(snippet):
                continue
            if entity == "URL" and (allow_url.search(snippet) or "${" in snippet):
                continue
            if entity == "IP_ADDRESS" and allow_ip.search(snippet):
                continue
            results.append({"file": str(path), "entity": entity, "match": snippet})

summary = {}
for item in results:
    summary[item["entity"]] = summary.get(item["entity"], 0) + 1

print(json.dumps({
    "status": "completed",
    "scanned_files": len(scan_files),
    "summary": summary,
    "sample_findings": results[:80],
}, ensure_ascii=False, indent=2))
PY
}

run_scancode_advisory() {
  local report_path="$1"
  if ! command -v uvx >/dev/null 2>&1; then
    printf '{\n  "status": "skipped",\n  "reason": "uvx unavailable"\n}\n' >"$report_path"
    return 0
  fi
  if ! timeout 180s uvx --from scancode-toolkit scancode \
    --classify \
    --license \
    --package \
    --summary \
    --json-pp "$report_path" \
    . >/dev/null; then
    rm -f "$report_path"
    printf '{\n  "status": "blocked",\n  "reason": "scancode timed out or failed before producing a complete report"\n}\n' >"$report_path"
  fi
}

require_tool gitleaks
require_tool git-secrets

log_step "0/9 prepare fresh clone"
git clone --no-local "file://$ROOT_DIR" "$FRESH_CLONE_DIR" >/dev/null 2>&1

log_step "1/9 gitleaks history scan"
gitleaks git . \
  --config .gitleaks.toml \
  --report-format csv \
  --report-path "$REPORT_DIR/gitleaks-git.csv" \
  --redact \
  --no-banner

log_step "2/9 gitleaks working tree scan"
gitleaks dir . \
  --config .gitleaks.toml \
  --report-format csv \
  --report-path "$REPORT_DIR/gitleaks-dir.csv" \
  --redact \
  --no-banner

log_step "3/9 gitleaks fresh-clone working tree scan"
gitleaks dir "$FRESH_CLONE_DIR" \
  --config .gitleaks.toml \
  --report-format csv \
  --report-path "$REPORT_DIR/gitleaks-fresh-clone.csv" \
  --redact \
  --no-banner

log_step "4/9 git-secrets working tree scan"
git-secrets --scan -r . >"$REPORT_DIR/git-secrets-scan.txt" 2>&1

log_step "5/9 git-secrets history scan"
git-secrets --scan-history >"$REPORT_DIR/git-secrets-history.txt" 2>&1

if command -v trufflehog >/dev/null 2>&1; then
  log_step "6/9 trufflehog history scan"
  trufflehog git "file://$ROOT_DIR" --json --results=verified,unknown >"$REPORT_DIR/trufflehog-git.jsonl"
  summarize_trufflehog "$REPORT_DIR/trufflehog-git.jsonl" >"$REPORT_DIR/trufflehog-summary.txt"
  log_step "7/9 trufflehog fresh-clone scan"
  trufflehog git "file://$FRESH_CLONE_DIR" --json --results=verified,unknown >"$REPORT_DIR/trufflehog-fresh-clone.jsonl"
  summarize_trufflehog "$REPORT_DIR/trufflehog-fresh-clone.jsonl" >"$REPORT_DIR/trufflehog-fresh-clone-summary.txt"
else
  printf 'status=skipped\nreason=trufflehog unavailable\n' >"$REPORT_DIR/trufflehog-summary.txt"
  printf 'status=skipped\nreason=trufflehog unavailable\n' >"$REPORT_DIR/trufflehog-fresh-clone-summary.txt"
fi

log_step "8/9 presidio advisory scan"
run_presidio_advisory "$REPORT_DIR/presidio-advisory.json"

log_step "9/9 scancode advisory scan"
run_scancode_advisory "$REPORT_DIR/scancode-advisory.json"

slug="$(extract_github_slug)"
if [[ -n "$slug" ]] && command -v gh >/dev/null 2>&1; then
  log_step "github secret-scanning capability check"
  if gh api "repos/$slug/secret-scanning/alerts?state=open&per_page=1" >"$REPORT_DIR/github-secret-scanning.json" 2>"$REPORT_DIR/github-secret-scanning.stderr"; then
    :
  else
    if rg -n "disabled|not available|upgrade to github pro|enable this feature|private to enable this feature" "$REPORT_DIR/github-secret-scanning.stderr" >/dev/null 2>&1; then
      printf '{\n  "status": "blocked",\n  "reason": "GitHub Secret Scanning is disabled or unavailable for this repository"\n}\n' >"$REPORT_DIR/github-secret-scanning.json"
    else
      cat "$REPORT_DIR/github-secret-scanning.stderr" >&2
      exit 1
    fi
  fi
  log_step "github issue/pr comment surface scan"
  if scan_github_text_surfaces "$slug" "$REPORT_DIR/github-text-surfaces.json" 2>"$REPORT_DIR/github-text-surfaces.stderr"; then
    :
  else
    printf '{\n  "status": "blocked",\n  "reason": "github text-surface scan failed"\n}\n' >"$REPORT_DIR/github-text-surfaces.json"
  fi
fi

echo "[oss-redaction] PASS"
