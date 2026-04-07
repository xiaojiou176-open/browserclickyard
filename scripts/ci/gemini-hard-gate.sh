#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="gemini-hard-gate"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
TIMING_DIR="${PROJECT_ROOT}/.runtime-cache/artifacts/ci-timing"
TIMING_FILE="${TIMING_DIR}/gemini-hard-gate-timing.json"

steps=(
  "ENV contract gate|pnpm env:check"
  "ENV governance strict gate|pnpm env:governance:check:strict"
  "AI provider readiness gate|pnpm ai:check"
  "Gemini-only policy gate|pnpm gemini-only-policy"
  "Automation routing gate|pnpm test:automation:routing"
)

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

if [[ -f "${ENV_FILE}" ]]; then
  echo "[$SCRIPT_NAME] Loading env from ${ENV_FILE}"
  load_env_file_safely "${ENV_FILE}"
else
  echo "[$SCRIPT_NAME] No .env found at ${ENV_FILE}; continuing"
fi

echo "[$SCRIPT_NAME] Starting hard gate ($(date -u +'%Y-%m-%dT%H:%M:%SZ'))"
mkdir -p "$TIMING_DIR"

declare -a STEP_LABELS=()
declare -a STEP_COMMANDS=()
declare -a STEP_STARTS=()
declare -a STEP_START_MS=()
declare -a STEP_ENDS=()
declare -a STEP_STATUSES=()
declare -a STEP_DURATIONS=()

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

run_step_sync() {
  local index="$1"
  local label="$2"
  local command="$3"
  local started_at
  local ended_at
  local duration_ms

  echo ""
  echo "[$SCRIPT_NAME] Step ${index}/${#steps[@]}: ${label}"
  echo "[$SCRIPT_NAME] Command: ${command}"
  started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  local started_ms
  started_ms="$(now_ms)"

  if ! run_command_without_eval "$command"; then
    ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    duration_ms="$(( $(now_ms) - started_ms ))"
    STEP_LABELS+=("$label")
    STEP_COMMANDS+=("$command")
    STEP_STARTS+=("$started_at")
    STEP_START_MS+=("$started_ms")
    STEP_ENDS+=("$ended_at")
    STEP_DURATIONS+=("$duration_ms")
    STEP_STATUSES+=("failed")
    echo ""
    echo "[$SCRIPT_NAME] FAIL at step ${index}/${#steps[@]}: ${label}" >&2
    echo "[$SCRIPT_NAME] Re-run failed step: ${command}" >&2
    echo "[$SCRIPT_NAME] Re-run full hard gate: pnpm gemini:hard-gate" >&2
    exit 1
  fi

  ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  duration_ms="$(( $(now_ms) - started_ms ))"
  STEP_LABELS+=("$label")
  STEP_COMMANDS+=("$command")
  STEP_STARTS+=("$started_at")
  STEP_START_MS+=("$started_ms")
  STEP_ENDS+=("$ended_at")
  STEP_DURATIONS+=("$duration_ms")
  STEP_STATUSES+=("passed")
  echo "[$SCRIPT_NAME] PASS: ${label}"
}

run_parallel_group() {
  local group_name="$1"
  shift
  local entries=("$@")
  local pids=()
  local labels=()
  local cmds=()
  local logs=()
  local starts=()
  local starts_ms=()
  local failed=0
  echo ""
  echo "[$SCRIPT_NAME] Parallel group: ${group_name} (${#entries[@]} steps)"
  for entry in "${entries[@]}"; do
    IFS='|' read -r label command <<<"$entry"
    local log_file
    log_file="$(mktemp)"
    labels+=("$label")
    cmds+=("$command")
    logs+=("$log_file")
    starts+=("$(date -u +'%Y-%m-%dT%H:%M:%SZ')")
    starts_ms+=("$(now_ms)")
    (
      set +e
      run_command_without_eval "$command" >"$log_file" 2>&1
      echo $? >"${log_file}.rc"
    ) &
    pids+=("$!")
    echo "[$SCRIPT_NAME] Spawned: ${label}"
  done

  for i in "${!pids[@]}"; do
    local ended_at
    local duration_ms
    local rc
    wait "${pids[$i]}"
    ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    duration_ms="$(( $(now_ms) - ${starts_ms[$i]} ))"
    rc="$(cat "${logs[$i]}.rc" 2>/dev/null || echo 1)"
    STEP_LABELS+=("${labels[$i]}")
    STEP_COMMANDS+=("${cmds[$i]}")
    STEP_STARTS+=("${starts[$i]}")
    STEP_START_MS+=("${starts_ms[$i]}")
    STEP_ENDS+=("$ended_at")
    STEP_DURATIONS+=("$duration_ms")
    if [[ "$rc" == "0" ]]; then
      STEP_STATUSES+=("passed")
      echo "[$SCRIPT_NAME] PASS: ${labels[$i]}"
    else
      STEP_STATUSES+=("failed")
      failed=1
      echo "[$SCRIPT_NAME] FAIL: ${labels[$i]}" >&2
      cat "${logs[$i]}" >&2
      echo "[$SCRIPT_NAME] Re-run failed step: ${cmds[$i]}" >&2
    fi
    rm -f "${logs[$i]}" "${logs[$i]}.rc"
  done

  if [[ "$failed" != "0" ]]; then
    exit 1
  fi
}

run_parallel_group "core-gemini-checks" \
  "${steps[0]}" \
  "${steps[1]}" \
  "${steps[2]}" \
  "${steps[3]}"

run_step_sync "5" "Automation routing gate" "pnpm test:automation:routing"

STEP_LABELS_FILE="$(mktemp)"
STEP_COMMANDS_FILE="$(mktemp)"
STEP_STARTS_FILE="$(mktemp)"
STEP_ENDS_FILE="$(mktemp)"
STEP_STATUSES_FILE="$(mktemp)"
STEP_DURATIONS_FILE="$(mktemp)"
printf "%s\n" "${STEP_LABELS[@]}" >"$STEP_LABELS_FILE"
printf "%s\n" "${STEP_COMMANDS[@]}" >"$STEP_COMMANDS_FILE"
printf "%s\n" "${STEP_STARTS[@]}" >"$STEP_STARTS_FILE"
printf "%s\n" "${STEP_ENDS[@]}" >"$STEP_ENDS_FILE"
printf "%s\n" "${STEP_STATUSES[@]}" >"$STEP_STATUSES_FILE"
printf "%s\n" "${STEP_DURATIONS[@]}" >"$STEP_DURATIONS_FILE"

export STEP_LABELS_FILE STEP_COMMANDS_FILE STEP_STARTS_FILE STEP_ENDS_FILE STEP_STATUSES_FILE STEP_DURATIONS_FILE TIMING_FILE
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

def lines(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [line.rstrip("\n") for line in fh]

labels = lines(os.environ["STEP_LABELS_FILE"])
commands = lines(os.environ["STEP_COMMANDS_FILE"])
starts = lines(os.environ["STEP_STARTS_FILE"])
ends = lines(os.environ["STEP_ENDS_FILE"])
statuses = lines(os.environ["STEP_STATUSES_FILE"])
durations = lines(os.environ["STEP_DURATIONS_FILE"])
timing_file = os.environ["TIMING_FILE"]

payload = {
    "script": "gemini-hard-gate",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "steps": []
}

for idx, label in enumerate(labels):
    payload["steps"].append(
        {
            "index": idx + 1,
            "label": label,
            "command": commands[idx],
            "status": statuses[idx],
            "started_at": starts[idx],
            "ended_at": ends[idx],
            "duration_ms": int(durations[idx]),
        }
    )

payload["total_duration_ms"] = sum(step["duration_ms"] for step in payload["steps"])
with open(timing_file, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY
rm -f "$STEP_LABELS_FILE" "$STEP_COMMANDS_FILE" "$STEP_STARTS_FILE" "$STEP_ENDS_FILE" "$STEP_STATUSES_FILE" "$STEP_DURATIONS_FILE"

echo ""
echo "[$SCRIPT_NAME] PASS: all ${#steps[@]} steps completed"
echo "[$SCRIPT_NAME] Timing report: ${TIMING_FILE}"
