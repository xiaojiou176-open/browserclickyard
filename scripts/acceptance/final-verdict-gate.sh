#!/usr/bin/env bash
set -euo pipefail

OUT_DIR=".runtime-cache/acceptance"
OUT_FILE="$OUT_DIR/final-verdict.json"
mkdir -p "$OUT_DIR"

ROWS=""
CRITICAL_FAILED=0
HIGH_FAILED=0

latest_run_dir() {
  node -e "const fs=require('fs');const path=require('path');const root='.runtime-cache/artifacts/runs';if(!fs.existsSync(root)){process.exit(0);}const dirs=fs.readdirSync(root,{withFileTypes:true}).filter((d)=>d.isDirectory()).map((d)=>path.join(root,d.name));if(dirs.length===0){process.exit(0);}dirs.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);process.stdout.write(dirs[0]);" 2>/dev/null
}

append_row() {
  local id="$1" level="$2" status="$3" cmd="$4" evidence="$5"
  ROWS="${ROWS}
    {\"id\":\"$id\",\"level\":\"$level\",\"status\":\"$status\",\"command\":\"$cmd\",\"evidence\":\"$evidence\"},"
  if [ "$status" != "PASS" ]; then
    if [ "$level" = "CRITICAL" ]; then
      CRITICAL_FAILED=$((CRITICAL_FAILED + 1))
    elif [ "$level" = "HIGH" ]; then
      HIGH_FAILED=$((HIGH_FAILED + 1))
    fi
  fi
}

run_check() {
  local id="$1" level="$2"
  shift 2
  local cmd_display
  cmd_display="$(printf '%q ' "$@")"
  cmd_display="${cmd_display% }"
  local log_file="/tmp/uiq_gate_${id//[^A-Za-z0-9_.-]/_}.log"
  if "$@" >"$log_file" 2>&1; then
    append_row "$id" "$level" "PASS" "$cmd_display" "$log_file"
  else
    append_row "$id" "$level" "FAIL" "$cmd_display" "$log_file"
  fi
}

verify_profile_summary() {
  local id="$1" level="$2"
  shift 2
  local before after summary status
  local cmd_display
  cmd_display="$(printf '%q ' "$@")"
  cmd_display="${cmd_display% }"
  local log_file="/tmp/uiq_gate_${id//[^A-Za-z0-9_.-]/_}.log"
  before="$(latest_run_dir || true)"
  if ! "$@" >"$log_file" 2>&1; then
    append_row "$id" "$level" "FAIL" "$cmd_display" "$log_file"
    return
  fi
  after="$(latest_run_dir || true)"
  summary="$after/reports/summary.json"
  if [ "$after" = "$before" ] || [ ! -f "$summary" ]; then
    append_row "$id" "$level" "FAIL" "$cmd_display" "missing summary.json"
    return
  fi
  status="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.status||''));" "$summary" 2>/dev/null)"
  if [ "$status" = "passed" ]; then
    append_row "$id" "$level" "PASS" "$cmd_display" "$summary"
  else
    append_row "$id" "$level" "FAIL" "$cmd_display" "$summary"
  fi
}

run_check "critical_typecheck" "CRITICAL" pnpm typecheck
run_check "high_frontend_unit" "HIGH" pnpm --dir apps/command-center test
run_check "high_ct" "HIGH" pnpm test:ct
run_check "high_e2e_smoke" "HIGH" pnpm test:e2e -- --grep @smoke
verify_profile_summary "high_pr_profile_local_quality" "HIGH" pnpm uiq run --profile pr --target web.local
verify_profile_summary "high_nightly_profile_local_quality" "HIGH" pnpm uiq run --profile nightly --target web.local

overall="FAIL"
[ "$CRITICAL_FAILED" -eq 0 ] && overall="PASS"

cat >"$OUT_FILE" <<EOF
{
  "generatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "overall": "$overall",
  "criticalFailed": $CRITICAL_FAILED,
  "highFailed": $HIGH_FAILED,
  "checks": [${ROWS%,}
  ]
}
EOF

echo "[final-verdict] overall=$overall"
echo "[final-verdict] report=$OUT_FILE"
[ "$overall" = "PASS" ]
