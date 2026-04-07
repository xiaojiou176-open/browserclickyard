#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

mkdir -p .runtime-cache

tmp_dir="$(mktemp -d ".runtime-cache/pre-push-local-gate.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

repo_dir="$tmp_dir/repo"
heavy_env_log="$tmp_dir/heavy.env"
mkdir -p "$repo_dir/scripts/ci" "$repo_dir/scripts/release" "$repo_dir/scripts" "$repo_dir/bin"

cp scripts/ci/pre-push-local-gate.sh "$repo_dir/scripts/ci/pre-push-local-gate.sh"
cp scripts/ci/check-workflow-runner-governance.mjs "$repo_dir/scripts/ci/check-workflow-runner-governance.mjs"

cat >"$repo_dir/scripts/ci/run-gate-in-container.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  test-matrix)
    exec env UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE=0 bash scripts/test-matrix.sh
    ;;
  verify-all)
    exec bash scripts/verify-all.sh
    ;;
  *)
    echo "unsupported gate: ${1:-}" >&2
    exit 1
    ;;
esac
SH

cat >"$repo_dir/scripts/release/check-workflow-pnpm-version-guard.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

cat >"$repo_dir/scripts/preflight.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

cat >"$repo_dir/scripts/test-matrix.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE=${UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE:-unset}" >>"${UIQ_HEAVY_ENV_LOG:?}"
exit 0
SH

cat >"$repo_dir/scripts/verify-all.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

cat >"$repo_dir/bin/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

chmod +x \
  "$repo_dir/scripts/ci/pre-push-local-gate.sh" \
  "$repo_dir/scripts/ci/run-gate-in-container.sh" \
  "$repo_dir/scripts/release/check-workflow-pnpm-version-guard.sh" \
  "$repo_dir/scripts/preflight.sh" \
  "$repo_dir/scripts/test-matrix.sh" \
  "$repo_dir/scripts/verify-all.sh" \
  "$repo_dir/bin/pnpm"

(
  cd "$repo_dir"
  git init -q
  git config user.name "test"
  git config user.email "test@example.com"
  mkdir -p backend
  printf '%s\n' "print('ok')" > services/api/app.py
  git add services/api/app.py
  git commit -m "init" -q
)

run_gate() {
  (
    cd "$repo_dir"
    PATH="$repo_dir/bin:$PATH" "$@"
  )
}

set +e
case_one_output="$(run_gate env UIQ_PREPUSH_HEAVY=0 UIQ_HEAVY_ENV_LOG="$heavy_env_log" bash scripts/ci/pre-push-local-gate.sh 2>&1)"
case_one_status=$?
set -e
if [[ "$case_one_status" -eq 0 ]]; then
  echo "expected non-heavy mode to fail on code changes without explicit bypass" >&2
  exit 1
fi
if ! grep -Fq "code changes detected but heavy gates are disabled" <<<"$case_one_output"; then
  echo "expected non-heavy failure reason for code changes" >&2
  printf '%s\n' "$case_one_output" >&2
  exit 1
fi

set +e
case_two_output="$(run_gate env UIQ_PREPUSH_HEAVY=0 UIQ_ALLOW_LIGHT_PREPUSH=1 UIQ_HEAVY_ENV_LOG="$heavy_env_log" bash scripts/ci/pre-push-local-gate.sh 2>&1)"
case_two_status=$?
set -e
if [[ "$case_two_status" -eq 0 ]]; then
  echo "expected bypass without reason to fail" >&2
  exit 1
fi
if ! grep -Fq "requires UIQ_ALLOW_LIGHT_PREPUSH_REASON" <<<"$case_two_output"; then
  echo "expected missing bypass reason failure message" >&2
  printf '%s\n' "$case_two_output" >&2
  exit 1
fi

case_three_output="$(
  run_gate env \
    UIQ_PREPUSH_HEAVY=0 \
    UIQ_ALLOW_LIGHT_PREPUSH=1 \
    UIQ_ALLOW_LIGHT_PREPUSH_REASON="temporary local debug" \
    UIQ_HEAVY_ENV_LOG="$heavy_env_log" \
    bash scripts/ci/pre-push-local-gate.sh 2>&1
)"
if ! grep -Fq "WARN: light pre-push override enabled" <<<"$case_three_output"; then
  echo "expected light override warning with reason" >&2
  printf '%s\n' "$case_three_output" >&2
  exit 1
fi
if ! grep -Fq "pre-push local quality gate passed" <<<"$case_three_output"; then
  echo "expected successful completion for bypass with reason" >&2
  printf '%s\n' "$case_three_output" >&2
  exit 1
fi

case_four_output="$(
  run_gate env \
    UIQ_PREPUSH_HEAVY=1 \
    UIQ_HEAVY_ENV_LOG="$heavy_env_log" \
    bash scripts/ci/pre-push-local-gate.sh 2>&1
)"
if ! grep -Fq "[pre-push][test-matrix] PASS" <<<"$case_four_output"; then
  echo "expected heavy mode to run test-matrix" >&2
  printf '%s\n' "$case_four_output" >&2
  exit 1
fi
if ! grep -Fq "[pre-push][verify-all] PASS" <<<"$case_four_output"; then
  echo "expected heavy mode to run verify-all" >&2
  printf '%s\n' "$case_four_output" >&2
  exit 1
fi
if ! grep -Fq "UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE=0" "$heavy_env_log"; then
  echo "expected heavy mode to force UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE=0" >&2
  cat "$heavy_env_log" >&2
  exit 1
fi

case_five_output="$(
  run_gate env \
    UIQ_PREPUSH_HEAVY=true \
    UIQ_HEAVY_ENV_LOG="$heavy_env_log" \
    bash scripts/ci/pre-push-local-gate.sh 2>&1
)"
if ! grep -Fq "[pre-push][test-matrix] PASS" <<<"$case_five_output"; then
  echo "expected truthy heavy mode (true) to run heavy gates" >&2
  printf '%s\n' "$case_five_output" >&2
  exit 1
fi

echo "pre-push local gate policy checks passed"
