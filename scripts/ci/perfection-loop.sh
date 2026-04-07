#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="perfection-loop"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ROUNDS="${PERFECTION_ROUNDS:-10}"
SCOPE="${PERFECTION_SCOPE:-full}"
ARTIFACT_DIR="${PERFECTION_ARTIFACT_DIR:-.runtime-cache/artifacts/perfection}"
PERF_TARGET_RATIO="${PERFECTION_PERF_TARGET_RATIO:--0.10}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [[ "$ROUNDS" -lt 1 ]]; then
  echo "[$SCRIPT_NAME] invalid PERFECTION_ROUNDS=$ROUNDS" >&2
  exit 2
fi

load_env_file_safely() {
  local env_file="$1"
  local line trimmed key raw_value value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    if [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]]; then
      continue
    fi

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      raw_value="${BASH_REMATCH[2]}"
      raw_value="${raw_value#"${raw_value%%[![:space:]]*}"}"
      value="$raw_value"

      if [[ "$value" =~ ^\"(.*)\"[[:space:]]*$ ]]; then
        value="${BASH_REMATCH[1]}"
      elif [[ "$value" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
        value="${BASH_REMATCH[1]}"
      else
        value="${value%%[[:space:]]#*}"
        value="${value%"${value##*[![:space:]]}"}"
      fi

      export "${key}=${value}"
    fi
  done < "$env_file"
}

if [[ -f ".env" ]]; then
  load_env_file_safely ".env"
fi

if [[ -z "${GEMINI_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" ]]; then
  echo "[$SCRIPT_NAME] missing GEMINI_API_KEY/GEMINI_API_KEY" >&2
  exit 1
fi

if [[ "${PERFECTION_ENV_ONLY:-0}" == "1" ]]; then
  echo "[$SCRIPT_NAME] env load check mode complete."
  exit 0
fi

mkdir -p "$ARTIFACT_DIR"
# Prevent stale rounds from previous executions polluting aggregation verdict.
find "$ARTIFACT_DIR" -mindepth 1 -maxdepth 1 \( -name 'round-*' -o -name 'summary.json' -o -name 'final-report.md' \) -exec rm -rf {} +

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

collect_har_summary() {
  local run_id="$1"
  local out_file="$2"
  node - <<'NODE' "$run_id" "$out_file"
const fs = require('fs');
const [runId, outFile] = process.argv.slice(2);
const harPath = `.runtime-cache/artifacts/runs/${runId}/network/capture.har`;
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har?.log?.entries || [];
const statusCounts = {};
for (const e of entries) {
  const s = e?.response?.status || 0;
  statusCounts[s] = (statusCounts[s] || 0) + 1;
}
const slowest = entries
  .map((e) => ({
    method: e?.request?.method || '',
    status: e?.response?.status || 0,
    timeMs: Number((e?.time || 0).toFixed(1)),
    url: e?.request?.url || '',
  }))
  .sort((a, b) => b.timeMs - a.timeMs)
  .slice(0, 10);
const summary = { runId, totalRequests: entries.length, statusCounts, slowest };
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
NODE
}

run_round() {
  local idx="$1"
  local round_dir
  round_dir="$(printf "%s/round-%02d" "$ARTIFACT_DIR" "$idx")"
  mkdir -p "$round_dir"

  local commands_log="$round_dir/commands.log"
  local timing_json="$round_dir/timing.json"
  local status_json="$round_dir/status.json"

  local -a step_names=()
  local -a step_cmds=()
  local -a step_status=()
  local -a step_durations=()

  run_step() {
    local name="$1"
    local cmd="$2"
    local start end duration rc
    echo "[$SCRIPT_NAME][round-$idx] RUN $name :: $cmd" | tee -a "$commands_log"
    start="$(now_ms)"
    set +e
    bash -lc "$cmd" >>"$commands_log" 2>&1
    rc=$?
    set -e
    end="$(now_ms)"
    duration="$(( end - start ))"
    step_names+=("$name")
    step_cmds+=("$cmd")
    step_durations+=("$duration")
    if [[ "$rc" -eq 0 ]]; then
      step_status+=("passed")
      echo "[$SCRIPT_NAME][round-$idx] PASS $name (${duration}ms)" | tee -a "$commands_log"
      return 0
    else
      step_status+=("failed")
      echo "[$SCRIPT_NAME][round-$idx] FAIL $name (${duration}ms, rc=$rc)" | tee -a "$commands_log"
      return 1
    fi
  }

  local fail_reason=""
  local round_ok=1

  # Release-grade gates
  local -a full_steps=(
    "env.check|pnpm env:check"
    "env.governance|pnpm env:governance:check:strict"
    "ai.check|pnpm ai:check"
    "gemini.only|pnpm gemini-only-policy"
    "typecheck|pnpm typecheck"
    "matrix.full|pnpm test:matrix:full"
    "mcp.check|pnpm mcp:check"
    "mcp.test|pnpm mcp:test"
    "orchestrator.test|pnpm test:orchestrator"
    "contract.test|pnpm test:contract"
    "mcp.regression|pnpm test:mcp-server:regression"
    "ct.test|pnpm test:ct"
    "gemini.hard.gate|pnpm gemini:hard-gate"
    "automation.routing|pnpm test:automation:routing"
    "embedding.cache|pnpm test:backend:embedding-cache"
  )

  local -a smoke_steps=(
    "env.check|pnpm env:check"
    "ai.check|pnpm ai:check"
    "gemini.only|pnpm gemini-only-policy"
    "typecheck|pnpm typecheck"
    "matrix.full|pnpm test:matrix:full"
    "mcp.test|pnpm mcp:test"
    "gemini.hard.gate|pnpm gemini:hard-gate"
  )

  local -a selected_steps=()
  if [[ "$SCOPE" == "smoke" ]]; then
    selected_steps=("${smoke_steps[@]}")
  else
    selected_steps=("${full_steps[@]}")
  fi

  for entry in "${selected_steps[@]}"; do
    IFS='|' read -r step_name step_cmd <<<"$entry"
    if ! run_step "$step_name" "$step_cmd"; then
      round_ok=0
      fail_reason="step_failed:$step_name"
      break
    fi
  done

  local capture_run_id=""
  local har_summary_file="$round_dir/har-summary.json"
  local gemini_audit_file="$round_dir/gemini-ui-audit.json"
  local gemini_status="not_run"

  if [[ "$round_ok" -eq 1 ]]; then
    # Start frontend runtime for capture
    local web_log="$round_dir/web-dev.log"
    set +e
    pnpm web:dev:ci >"$web_log" 2>&1 &
    local web_pid=$!
    set -e
    sleep 2

    if ! run_step "uiq.capture" "pnpm uiq capture --target web.local"; then
      round_ok=0
      fail_reason="step_failed:uiq.capture"
    else
      capture_run_id="$(grep -E '^runId=' "$commands_log" | tail -n1 | cut -d'=' -f2)"
      if [[ -z "$capture_run_id" ]]; then
        round_ok=0
        fail_reason="missing_capture_run_id"
      fi
    fi

    if [[ "$round_ok" -eq 1 ]]; then
      rm -rf .runtime-cache/test-results/frontend-e2e-generated
      if ! run_step "e2e.artifacts" "UIQ_E2E_ARTIFACT_POLICY=full pnpm test:e2e -- --grep '@generic|@core-nonstub'"; then
        round_ok=0
        fail_reason="step_failed:e2e.artifacts"
      fi
    fi

    if [[ "$round_ok" -eq 1 ]]; then
      collect_har_summary "$capture_run_id" "$har_summary_file" || {
        round_ok=0
        fail_reason="har_summary_failed"
      }
    fi

    if [[ "$round_ok" -eq 1 ]]; then
      local screenshot_file=".runtime-cache/artifacts/runs/${capture_run_id}/screenshots/route_safe.png"
      if [[ ! -f "$screenshot_file" ]]; then
        screenshot_file=".runtime-cache/artifacts/runs/${capture_run_id}/screenshots/route_home.png"
      fi
      local video_file
      video_file="$(find .runtime-cache/test-results/frontend-e2e-generated -type f -name '*.webm' -print0 | xargs -0 ls -1t 2>/dev/null | head -n1)"
      if [[ -z "$video_file" || ! -f "$video_file" ]]; then
        round_ok=0
        fail_reason="missing_video_artifact"
      else
        if run_step "gemini.audit" "pnpm ci:gemini:audit --screenshot '$screenshot_file' --video '$video_file' --har-summary '$har_summary_file' --output '$gemini_audit_file' --model '${GEMINI_MODEL:-gemini-3.1-pro-preview}' --thinking-level '${GEMINI_THINKING_LEVEL:-high}' --temperature '${GEMINI_TEMPERATURE:-0.1}'"; then
          gemini_status="$(node - <<'NODE' "$gemini_audit_file"
const fs=require('fs');
const file=process.argv[2];
const payload=JSON.parse(fs.readFileSync(file,'utf8'));
process.stdout.write(String(payload?.analysis?.functional_status || 'warning').toLowerCase());
NODE
)"
          if [[ "$gemini_status" != "pass" ]]; then
            round_ok=0
            fail_reason="gemini_status:$gemini_status"
          fi
        else
          round_ok=0
          fail_reason="step_failed:gemini.audit"
        fi
      fi
    fi

    if [[ -n "${web_pid:-}" ]]; then
      kill "$web_pid" >/dev/null 2>&1 || true
      wait "$web_pid" >/dev/null 2>&1 || true
    fi
  fi

  local total_ms=0
  for d in "${step_durations[@]}"; do
    total_ms="$(( total_ms + d ))"
  done

  local names_file cmds_file status_file dur_file
  names_file="$(mktemp)"; cmds_file="$(mktemp)"; status_file="$(mktemp)"; dur_file="$(mktemp)"
  printf "%s\n" "${step_names[@]}" >"$names_file"
  printf "%s\n" "${step_cmds[@]}" >"$cmds_file"
  printf "%s\n" "${step_status[@]}" >"$status_file"
  printf "%s\n" "${step_durations[@]}" >"$dur_file"

  node - <<'NODE' "$timing_json" "$names_file" "$cmds_file" "$status_file" "$dur_file"
const fs = require('fs');
const [timingPath, namesFile, cmdsFile, statusFile, durFile] = process.argv.slice(2);
const read = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const names = read(namesFile);
const cmds = read(cmdsFile);
const status = read(statusFile);
const durations = read(durFile).map((x) => Number(x));
const steps = names.map((name, i) => ({ name, command: cmds[i], status: status[i], duration_ms: durations[i] || 0 }));
const total = steps.reduce((acc, cur) => acc + cur.duration_ms, 0);
fs.writeFileSync(timingPath, JSON.stringify({ generated_at: new Date().toISOString(), steps, total_duration_ms: total }, null, 2) + '\n', 'utf8');
NODE

  rm -f "$names_file" "$cmds_file" "$status_file" "$dur_file"

  node - <<'NODE' "$status_json" "$idx" "$round_ok" "$fail_reason" "$gemini_status" "$capture_run_id" "$total_ms"
const fs = require('fs');
const [statusPath, idx, ok, reason, geminiStatus, runId, totalMs] = process.argv.slice(2);
const payload = {
  round: Number(idx),
  generated_at: new Date().toISOString(),
  round_passed: ok === '1',
  reason: reason || null,
  gemini_functional_status: geminiStatus || null,
  capture_run_id: runId || null,
  total_duration_ms: Number(totalMs || 0),
};
fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
NODE

  if [[ "$round_ok" -eq 1 ]]; then
    echo "[$SCRIPT_NAME] round-$idx PASS total=${total_ms}ms"
    return 0
  fi

  echo "[$SCRIPT_NAME] round-$idx FAIL reason=$fail_reason total=${total_ms}ms" >&2
  return 1
}

for (( i=1; i<=ROUNDS; i++ )); do
  if ! run_round "$i"; then
    break
  fi
done

set +e
PERFECTION_ARTIFACT_DIR="$ARTIFACT_DIR" \
PERFECTION_PERF_TARGET_RATIO="$PERF_TARGET_RATIO" \
PERFECTION_ALLOW_BASELINE_ONLY="$([[ "$SCOPE" == "smoke" || "$ROUNDS" -eq 1 ]] && echo 1 || echo 0)" \
PERFECTION_REQUIRE_PERF_TARGET="${PERFECTION_REQUIRE_PERF_TARGET:-0}" \
node scripts/ci/perfection-aggregate.mjs
agg_rc=$?
set -e

if [[ "$agg_rc" -ne 0 ]]; then
  echo "[$SCRIPT_NAME] aggregate indicates not perfect yet (or loop interrupted)." >&2
  exit 1
fi

echo "[$SCRIPT_NAME] Perfect criteria met."
