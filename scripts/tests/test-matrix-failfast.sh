#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tmp_dir="$(mktemp -d ".runtime-cache/test-matrix-failfast.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

child_pid_file="$tmp_dir/child.pid"
long_runner="$tmp_dir/long-runner.sh"
fast_fail="$tmp_dir/fast-fail.sh"

cat >"$long_runner" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import os
import signal
import subprocess

child = subprocess.Popen([
    "python3",
    "-c",
    "import time\n"
    "while True:\n"
    "    time.sleep(0.2)\n",
])
pid_file = os.environ["UIQ_TEST_CHILD_PID_FILE"]
with open(pid_file, "w", encoding="utf-8") as handle:
    handle.write(str(child.pid))
child.wait()
PY
SH
chmod +x "$long_runner"

cat >"$fast_fail" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sleep 1
exit 1
SH
chmod +x "$fast_fail"

export UIQ_TEST_CHILD_PID_FILE="$child_pid_file"
export UIQ_CONTAINER_GATE_NAME="test-matrix"
export UIQ_SUITE_WEB_E2E=0
export UIQ_SUITE_FRONTEND_E2E=0
export UIQ_SUITE_FRONTEND_UNIT=1
export UIQ_SUITE_BACKEND=0
export UIQ_SUITE_AUTOMATION_CHECK=0
export UIQ_SUITE_ORCHESTRATOR_MCP=0
export UIQ_SUITE_TEST_TRUTH_GATE=1
export UIQ_SUITE_COVERAGE_GATE=0
export UIQ_SUITE_MUTATION_GATE=0
export UIQ_FAILFAST_TERM_GRACE_SEC=1
export UIQ_TEST_LOG_DIR="$tmp_dir/logs"
export UIQ_TEST_MATRIX_CMD_TEST_TRUTH_GATE="$long_runner"
export UIQ_TEST_MATRIX_CMD_FRONTEND_UNIT="$fast_fail"
export UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE="1"

set +e
output="$(bash scripts/test-matrix.sh parallel 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "expected test-matrix to fail fast, but it succeeded" >&2
  exit 1
fi

for _ in $(seq 1 20); do
  if [[ -f "$child_pid_file" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "$child_pid_file" ]]; then
  echo "expected child pid file to exist" >&2
  exit 1
fi

child_pid="$(cat "$child_pid_file")"
sleep 1.5
if kill -0 "$child_pid" >/dev/null 2>&1; then
  echo "expected child pid $child_pid to be terminated" >&2
  exit 1
fi

if ! grep -Fq "[term] test-truth-gate" <<<"$output" && ! grep -Fq "[kill] test-truth-gate" <<<"$output"; then
  echo "expected fail-fast output to include TERM or KILL for test-truth-gate" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if ! grep -Fq "fail-fast: stopped remaining suites after failure in frontend-unit" <<<"$output"; then
  echo "expected fail-fast summary message in output" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "test-matrix fail-fast cleanup passed"
