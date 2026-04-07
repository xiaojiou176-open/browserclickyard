#!/usr/bin/env bash
set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR=".runtime-cache/artifacts/ci"
RUN_LOG_DIR="$ARTIFACT_DIR/system-audit"
SUMMARY_PATH="$ARTIFACT_DIR/system-audit.json"
TMP_RESULTS="$(mktemp -t uiq-system-audit.XXXXXX)"

MODE="full"
INCLUDE_HEAVY="${UIQ_SYSTEM_AUDIT_INCLUDE_HEAVY:-1}"

usage() {
  cat <<'EOF'
Usage: bash scripts/ci/system-audit.sh [--minimal|--full] [--include-heavy|--skip-heavy]

Options:
  --minimal        Run minimal mode (skip heavy checks by default).
  --full           Run full mode (include heavy checks by default).
  --include-heavy  Force include heavy checks (e.g. coverage).
  --skip-heavy     Force skip heavy checks (e.g. coverage).
  -h, --help       Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --minimal)
      MODE="minimal"
      INCLUDE_HEAVY="0"
      shift
      ;;
    --full)
      MODE="full"
      shift
      ;;
    --include-heavy)
      INCLUDE_HEAVY="1"
      shift
      ;;
    --skip-heavy)
      INCLUDE_HEAVY="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[system-audit] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" == "full" && -z "${UIQ_SYSTEM_AUDIT_INCLUDE_HEAVY:-}" ]]; then
  INCLUDE_HEAVY="1"
fi

mkdir -p "$RUN_LOG_DIR"
: >"$TMP_RESULTS"

trap 'rm -f "$TMP_RESULTS"' EXIT

has_script() {
  local script_name="$1"
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    process.exit(pkg?.scripts && pkg.scripts[process.argv[1]] ? 0 : 1);
  ' "$script_name" >/dev/null 2>&1
}

resolve_live_preflight_command() {
  if has_script "live:preflight:key"; then
    printf '%s' "pnpm live:preflight:key"
    return 0
  fi

  if [[ -f "scripts/lib/live-key-preflight.mjs" ]]; then
    printf '%s' "node scripts/lib/live-key-preflight.mjs --assert"
    return 0
  fi

  return 1
}

append_result() {
  local name="$1"
  local command="$2"
  local status="$3"
  local exit_code="$4"
  local duration_ms="$5"
  local log_path="$6"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$status" "$exit_code" "$duration_ms" "$command" "$log_path" >>"$TMP_RESULTS"
}

run_gate() {
  local name="$1"
  local command="$2"
  local heavy="$3"

  if [[ "$heavy" == "1" && "$INCLUDE_HEAVY" != "1" ]]; then
    echo "[system-audit] skip $name (heavy gate disabled)"
    append_result "$name" "$command" "skipped" "0" "0" ""
    return 0
  fi

  local safe_name
  safe_name="$(echo "$name" | tr ':/ ' '___')"
  local log_path="$RUN_LOG_DIR/${safe_name}.log"
  local started_at ended_at duration_ms rc
  started_at="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  echo "[system-audit] run $name"
  set +e
  bash -lc "$command" >"$log_path" 2>&1
  rc=$?
  set -e

  ended_at="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  duration_ms=$((ended_at - started_at))

  if (( rc == 0 )); then
    echo "[system-audit] pass $name (${duration_ms}ms)"
    append_result "$name" "$command" "passed" "$rc" "$duration_ms" "$log_path"
    return 0
  fi

  echo "[system-audit] fail $name rc=$rc (${duration_ms}ms, log: $log_path)" >&2
  append_result "$name" "$command" "failed" "$rc" "$duration_ms" "$log_path"
  return "$rc"
}

write_summary() {
  local overall_status="$1"
  local overall_exit_code="$2"
  local started_epoch_ms="$3"
  local finished_epoch_ms="$4"
  local include_heavy="$5"
  local mode="$6"

  python3 - "$TMP_RESULTS" "$SUMMARY_PATH" "$overall_status" "$overall_exit_code" "$started_epoch_ms" "$finished_epoch_ms" "$include_heavy" "$mode" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

results_path, summary_path, overall_status, overall_exit_code, started_ms, finished_ms, include_heavy, mode = sys.argv[1:]
rows = []
with open(results_path, "r", encoding="utf-8") as fh:
  for line in fh:
    line = line.rstrip("\n")
    if not line:
      continue
    name, status, exit_code, duration_ms, command, log_path = line.split("\t")
    rows.append({
      "name": name,
      "status": status,
      "exit_code": int(exit_code),
      "duration_ms": int(duration_ms),
      "command": command,
      "log_path": log_path or None,
    })

payload = {
  "audit": "system-audit",
  "timestamp_utc": datetime.now(timezone.utc).isoformat(),
  "mode": mode,
  "include_heavy": include_heavy == "1",
  "overall_status": overall_status,
  "overall_exit_code": int(overall_exit_code),
  "duration_ms": int(finished_ms) - int(started_ms),
  "gates": rows,
}

os.makedirs(os.path.dirname(summary_path), exist_ok=True)
with open(summary_path, "w", encoding="utf-8") as out:
  json.dump(payload, out, ensure_ascii=False, indent=2)
  out.write("\n")
print(summary_path)
PY
}

main() {
  local live_preflight_command
  if ! live_preflight_command="$(resolve_live_preflight_command)"; then
    echo "[system-audit] missing live key preflight command: expected npm script live:preflight:key or scripts/lib/live-key-preflight.mjs" >&2
    exit 1
  fi
  if [[ "$MODE" == "minimal" && -z "${UIQ_LIVE_LLM_ENABLED:-}" ]]; then
    live_preflight_command="UIQ_LIVE_LLM_ENABLED=true $live_preflight_command"
  fi

  local started_epoch_ms
  started_epoch_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  local failed_rc=0
  set -e
  local require_live_preflight="${UIQ_SYSTEM_AUDIT_REQUIRE_LIVE_PREFLIGHT:-0}"
  local should_run_live_preflight="0"
  if [[ "$require_live_preflight" == "1" || -n "${GEMINI_API_KEY:-}" || -n "${UIQ_LIVE_LLM_ENABLED:-}" ]]; then
    should_run_live_preflight="1"
  fi
  if [[ "$should_run_live_preflight" == "1" ]]; then
    run_gate "live:preflight:key" "$live_preflight_command" "0" || failed_rc=$?
  else
    echo "[system-audit] skip live:preflight:key (missing GEMINI_API_KEY/UIQ_LIVE_LLM_ENABLED)"
    append_result "live:preflight:key" "$live_preflight_command" "skipped" "0" "0" ""
  fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:lint" "pnpm lint:all" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:truth" "pnpm gate:test:truth" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:docs" "pnpm gate:docs:ssot" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:log" "node scripts/ci/check-log-quality.mjs" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:github-security-alerts" "pnpm gate:github:security-alerts" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:sensitive" "pnpm gate:sensitive-surfaces" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "pre-commit:secret" "pnpm gate:secret-leak" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "docs-gate" "bash scripts/docs-gate.sh" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "env-reduction:enforce" "pnpm env:governance:enforce" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "env:deletion-budget" "pnpm env:deletion:budget" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "env:admission" "pnpm env:admission:check" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "env:tail-decisions" "pnpm env:tail:decisions" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "env:deprecated-aliases" "pnpm gate:env:deprecated-aliases" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "gemini-only-policy" "pnpm gemini-only-policy" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "provider-readiness:strict" "node scripts/ai/check-provider-readiness.mjs --strict" "0" || failed_rc=$?; fi
  if (( failed_rc == 0 )); then run_gate "test:coverage" "pnpm test:coverage" "1" || failed_rc=$?; fi

  local finished_epoch_ms
  finished_epoch_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  if (( failed_rc == 0 )); then
    write_summary "passed" "0" "$started_epoch_ms" "$finished_epoch_ms" "$INCLUDE_HEAVY" "$MODE" >/dev/null
    echo "[system-audit] PASS (summary: $SUMMARY_PATH)"
    exit 0
  fi

  write_summary "failed" "$failed_rc" "$started_epoch_ms" "$finished_epoch_ms" "$INCLUDE_HEAVY" "$MODE" >/dev/null
  echo "[system-audit] FAIL rc=$failed_rc (summary: $SUMMARY_PATH)" >&2
  exit "$failed_rc"
}

main "$@"
