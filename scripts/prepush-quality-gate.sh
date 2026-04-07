#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR=".runtime-cache/artifacts/prepush-quality-gate"
RUN_ID="$(date +"%Y%m%d-%H%M%S")"
RUN_DIR="$ARTIFACT_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"

echo "[prepush-quality-gate] run id: $RUN_ID"
echo "[prepush-quality-gate] phase 1/2: gate:commit:atomic"

set +e
pnpm gate:commit:atomic 2>&1 | tee "$RUN_DIR/gate-commit-atomic.log"
commit_rc=${PIPESTATUS[0]}
set -e

if (( commit_rc != 0 )); then
  echo "[prepush-quality-gate] FAIL gate:commit:atomic (rc=$commit_rc)"
  echo "[prepush-quality-gate] log: $RUN_DIR/gate-commit-atomic.log"
  exit "$commit_rc"
fi

echo "[prepush-quality-gate] PASS gate:commit:atomic"
echo "[prepush-quality-gate] phase 2/2: run 5 gates in parallel"

declare -a gate_names=(
  "lint:all"
  "gate:system2:6-8"
  "gate:test:truth"
  "gate:e2e:authenticity"
  "gate:docs:ssot"
)

declare -a gate_cmds=(
  "pnpm lint:all"
  "pnpm gate:system2:6-8"
  "pnpm gate:test:truth"
  "pnpm gate:e2e:authenticity"
  "pnpm gate:docs:ssot"
)

declare -a gate_pids=()
declare -a gate_logs=()
declare -a gate_rcs=()

for idx in "${!gate_names[@]}"; do
  gate="${gate_names[$idx]}"
  gate_cmd="${gate_cmds[$idx]}"
  safe_name="$(echo "$gate" | tr ':' '-')"
  log_path="$RUN_DIR/${safe_name}.log"
  gate_logs[$idx]="$log_path"
  echo "[prepush-quality-gate] start $gate -> $log_path"
  (
    set -o pipefail
    bash -lc "$gate_cmd" >"$log_path" 2>&1
  ) &
  gate_pids[$idx]=$!
done

failed_count=0
final_rc=0

for idx in "${!gate_names[@]}"; do
  gate="${gate_names[$idx]}"
  pid="${gate_pids[$idx]}"
  set +e
  wait "$pid"
  rc=$?
  set -e
  gate_rcs[$idx]="$rc"
  if (( rc != 0 )); then
    ((failed_count += 1))
    if (( final_rc == 0 )); then
      final_rc="$rc"
    fi
  fi
done

echo
echo "[prepush-quality-gate] summary"
for idx in "${!gate_names[@]}"; do
  gate="${gate_names[$idx]}"
  rc="${gate_rcs[$idx]}"
  if (( rc == 0 )); then
    echo "  - PASS $gate"
  else
    echo "  - FAIL $gate (rc=$rc, log=${gate_logs[$idx]})"
  fi
done

if (( failed_count > 0 )); then
  echo
  echo "[prepush-quality-gate] failed gates detail"
  for idx in "${!gate_names[@]}"; do
    gate="${gate_names[$idx]}"
    rc="${gate_rcs[$idx]}"
    if (( rc != 0 )); then
      echo "--- $gate (rc=$rc) tail -n 40 ---"
      tail -n 40 "${gate_logs[$idx]}" || true
      echo "--- end $gate ---"
    fi
  done
  exit "$final_rc"
fi

echo "[prepush-quality-gate] all gates passed"
