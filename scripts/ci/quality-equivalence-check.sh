#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="quality-equivalence-check"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TIMING_DIR=".runtime-cache/artifacts/ci-timing"
BASELINE_FILE="${TIMING_DIR}/baseline.json"
CURRENT_FILE="${TIMING_DIR}/current.json"
DIFF_FILE="${TIMING_DIR}/diff.json"
mkdir -p "$TIMING_DIR"

trim_spaces() {
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  printf '%s' "$text"
}

unquote_env_value() {
  local value="$1"
  if [[ ${#value} -ge 2 ]]; then
    local first_char="${value:0:1}"
    local last_char="${value: -1}"
    if [[ "$first_char" == "$last_char" && ( "$first_char" == "'" || "$first_char" == '"' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

load_env_file_safely() {
  local env_path="$1"
  local line
  local key
  local value
  local trimmed

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_spaces "$line")"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$trimmed" != *=* ]] && continue
    key="${trimmed%%=*}"
    value="${trimmed#*=}"
    key="$(trim_spaces "$key")"
    value="$(trim_spaces "$value")"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(unquote_env_value "$value")"
    export "$key=$value"
  done < "$env_path"
}

run_command_without_eval() {
  local command="$1"
  local -a argv=()
  read -r -a argv <<<"$command"
  [[ "${#argv[@]}" -gt 0 ]]
  "${argv[@]}"
}

if [[ -f ".env" ]]; then
  load_env_file_safely ".env"
fi

if [[ -z "${GEMINI_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" ]]; then
  if [[ "${UIQ_ALLOW_DUMMY_GEMINI_KEY:-0}" == "1" ]]; then
    echo "[$SCRIPT_NAME] WARN: using dummy Gemini key by explicit override (UIQ_ALLOW_DUMMY_GEMINI_KEY=1)" >&2
    export GEMINI_API_KEY="ci_dummy_gemini_key"
  else
    echo "[$SCRIPT_NAME] FAIL: GEMINI_API_KEY is required (dummy fallback disabled)." >&2
    echo "[$SCRIPT_NAME] If you need a local dry run, set UIQ_ALLOW_DUMMY_GEMINI_KEY=1 explicitly." >&2
    exit 1
  fi
fi
export VIDEO_ANALYZER_PROVIDER="${VIDEO_ANALYZER_PROVIDER:-gemini}"
export GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-pro-preview}"

declare -a NAMES=()
declare -a COMMANDS=()
declare -a DURATIONS=()
declare -a STATUSES=()

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

run_timed_step() {
  local name="$1"
  local command="$2"
  local start_ms end_ms duration_ms
  echo "[$SCRIPT_NAME] RUN ${name}: ${command}"
  start_ms="$(now_ms)"
  if run_command_without_eval "$command"; then
    end_ms="$(now_ms)"
    duration_ms="$(( end_ms - start_ms ))"
    NAMES+=("$name")
    COMMANDS+=("$command")
    DURATIONS+=("$duration_ms")
    STATUSES+=("passed")
    echo "[$SCRIPT_NAME] PASS ${name} (${duration_ms}ms)"
  else
    end_ms="$(now_ms)"
    duration_ms="$(( end_ms - start_ms ))"
    NAMES+=("$name")
    COMMANDS+=("$command")
    DURATIONS+=("$duration_ms")
    STATUSES+=("failed")
    echo "[$SCRIPT_NAME] FAIL ${name} (${duration_ms}ms)" >&2
    exit 1
  fi
}

run_timed_step "env.check" "pnpm env:check"
run_timed_step "env.governance.strict" "pnpm env:governance:check:strict"
run_timed_step "ai.check" "pnpm ai:check"
run_timed_step "gemini.only.policy" "pnpm gemini-only-policy"
run_timed_step "automation.routing" "pnpm test:automation:routing"
run_timed_step "orchestrator.report.contract" "pnpm test:orchestrator -- --testNamePattern report"
run_timed_step "mcp.smoke" "pnpm mcp:smoke"

NAMES_FILE="$(mktemp)"
COMMANDS_FILE="$(mktemp)"
DURATIONS_FILE="$(mktemp)"
STATUSES_FILE="$(mktemp)"
printf "%s\n" "${NAMES[@]}" >"$NAMES_FILE"
printf "%s\n" "${COMMANDS[@]}" >"$COMMANDS_FILE"
printf "%s\n" "${DURATIONS[@]}" >"$DURATIONS_FILE"
printf "%s\n" "${STATUSES[@]}" >"$STATUSES_FILE"

export NAMES_FILE COMMANDS_FILE DURATIONS_FILE STATUSES_FILE CURRENT_FILE BASELINE_FILE DIFF_FILE
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

def read_lines(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as fh:
        return [line.rstrip("\n") for line in fh]

names = read_lines(os.environ["NAMES_FILE"])
commands = read_lines(os.environ["COMMANDS_FILE"])
durations = [int(item) for item in read_lines(os.environ["DURATIONS_FILE"])]
statuses = read_lines(os.environ["STATUSES_FILE"])

current = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "suites": [],
}
for idx, name in enumerate(names):
    current["suites"].append(
        {
            "name": name,
            "command": commands[idx],
            "duration_ms": durations[idx],
            "status": statuses[idx],
        }
    )
current["total_duration_ms"] = sum(durations)

current_path = Path(os.environ["CURRENT_FILE"])
current_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

baseline_path = Path(os.environ["BASELINE_FILE"])
if not baseline_path.exists():
    baseline_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
baseline_by_name = {item["name"]: item for item in baseline.get("suites", [])}

diff = {
    "generated_at": current["generated_at"],
    "baseline_file": str(baseline_path),
    "current_file": str(current_path),
    "suite_diffs": [],
    "total_duration_ms": {
      "baseline": baseline.get("total_duration_ms"),
      "current": current.get("total_duration_ms"),
      "delta": (current.get("total_duration_ms", 0) - baseline.get("total_duration_ms", 0)),
    },
}

for item in current["suites"]:
    base = baseline_by_name.get(item["name"], {})
    base_duration = int(base.get("duration_ms", 0))
    cur_duration = int(item["duration_ms"])
    delta = cur_duration - base_duration
    regression_ratio = 0.0 if base_duration == 0 else (delta / base_duration)
    diff["suite_diffs"].append(
        {
            "name": item["name"],
            "baseline_duration_ms": base_duration,
            "current_duration_ms": cur_duration,
            "delta_ms": delta,
            "regression_ratio": round(regression_ratio, 4),
        }
    )

Path(os.environ["DIFF_FILE"]).write_text(json.dumps(diff, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

rm -f "$NAMES_FILE" "$COMMANDS_FILE" "$DURATIONS_FILE" "$STATUSES_FILE"

echo "[$SCRIPT_NAME] wrote ${CURRENT_FILE}"
echo "[$SCRIPT_NAME] wrote ${DIFF_FILE}"
echo "[$SCRIPT_NAME] baseline ${BASELINE_FILE}"
