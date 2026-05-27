#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

mkdir -p .runtime-cache
tmp_dir="$(mktemp -d ".runtime-cache/verify-all-web-runtime.XXXXXX")"
tmp_dir="$(cd "$tmp_dir" && pwd)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

repo_dir="$tmp_dir/repo"
pnpm_log="$tmp_dir/pnpm.log"
mkdir -p "$repo_dir/scripts/ci" "$repo_dir/scripts/lib" "$repo_dir/bin"

cp scripts/verify-all.sh "$repo_dir/scripts/verify-all.sh"
cp scripts/lib/ports.sh "$repo_dir/scripts/lib/ports.sh"

cat >"$repo_dir/scripts/lib/node-toolchain.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
uiq_export_node_env() { :; }
uiq_repair_shared_module_links() { :; }
SH

cat >"$repo_dir/scripts/lib/pnpm-safe.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec pnpm "$@"
SH

cat >"$repo_dir/scripts/ci/verify-run-evidence.mjs" <<'JS'
process.exit(0);
JS

cat >"$repo_dir/scripts/ci/run-gate-in-container.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${1:-}" != "verify-all" ]]; then
  echo "expected verify-all gate name, got: ${1:-}" >&2
  exit 1
fi
export UIQ_CONTAINER_GATE_NAME=verify-all
shift
exec bash "$ROOT_DIR/scripts/verify-all.sh" "$@"
SH

cat >"$repo_dir/scripts/lint-all.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

cat >"$repo_dir/scripts/ci/check-branch-protection.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exit 0
SH

cat >"$repo_dir/bin/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
log_file="${UIQ_VERIFY_PNPM_LOG:?}"
printf 'UIQ_WEB_PORT=%s args=%s\n' "${UIQ_WEB_PORT:-}" "$*" >>"$log_file"
exit 0
SH

cat >"$repo_dir/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--no-pager" ]]; then
  shift
fi
case "${1:-}" in
  status)
    exit 0
    ;;
  diff)
    exit 0
    ;;
  ls-files)
    exit 0
    ;;
  rev-parse)
    if [[ "${2:-}" == "--abbrev-ref" ]]; then
      printf '%s\n' "${UIQ_GIT_BRANCH:-main}"
      exit 0
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
SH

chmod +x \
  "$repo_dir/scripts/verify-all.sh" \
  "$repo_dir/scripts/lib/node-toolchain.sh" \
  "$repo_dir/scripts/lib/pnpm-safe.sh" \
  "$repo_dir/scripts/lint-all.sh" \
  "$repo_dir/scripts/ci/check-branch-protection.sh" \
  "$repo_dir/bin/pnpm" \
  "$repo_dir/bin/git"

run_verify_and_capture_web_line() {
  local runner_name="$1"
  local forced_port="$2"
  local workspace_hint="${3:-}"
  : >"$pnpm_log"

  local -a env_vars=(
    "PATH=$repo_dir/bin:$PATH"
    "UIQ_VERIFY_PNPM_LOG=$pnpm_log"
    "UIQ_VERIFY_ENABLE_COVERAGE_GATE=0"
    "UIQ_VERIFY_ENABLE_MUTATION_GATE=0"
    "UIQ_VERIFY_ENABLE_TAURI_GATE=0"
    "UIQ_VERIFY_BRANCH_PROTECTION_STRICT=0"
    "RUNNER_NAME=$runner_name"
    "GITHUB_WORKSPACE=${workspace_hint:-$repo_dir}"
    "PWD=${workspace_hint:-$repo_dir}"
    "RUNNER_TEMP=${workspace_hint:-$repo_dir/.tmp}"
  )
  if [[ -n "$forced_port" ]]; then
    env_vars+=("UIQ_WEB_PORT=$forced_port")
  fi

  (
    cd "$repo_dir"
    env "${env_vars[@]}" bash scripts/verify-all.sh >/dev/null
  )

  local web_line
  web_line="$(grep -F "args=uiq run --profile pr --target web.ci" "$pnpm_log" | tail -n1 || true)"
  if [[ -z "$web_line" ]]; then
    echo "expected verify-all to invoke web.ci profile run" >&2
    cat "$pnpm_log" >&2
    exit 1
  fi
  printf '%s\n' "$web_line"
}

extract_logged_port() {
  local line="$1"
  local token
  token="$(printf '%s\n' "$line" | grep -Eo 'UIQ_WEB_PORT=[0-9]+' || true)"
  if [[ -z "$token" ]]; then
    echo "failed to extract UIQ_WEB_PORT from line: $line" >&2
    exit 1
  fi
  printf '%s\n' "${token#UIQ_WEB_PORT=}"
}

assert_web_line_uses_base_url_port() {
  local line="$1"
  local port="$2"
  if ! grep -Fq -- "--base-url http://127.0.0.1:${port}" <<<"$line"; then
    echo "expected web.ci command to include base-url for port ${port}" >&2
    echo "$line" >&2
    exit 1
  fi
}

line_01="$(run_verify_and_capture_web_line "pool-core99-01" "")"
line_02="$(run_verify_and_capture_web_line "pool-core99-02" "")"
line_03="$(run_verify_and_capture_web_line "pool-core99-03" "")"

port_01="$(extract_logged_port "$line_01")"
port_02="$(extract_logged_port "$line_02")"
port_03="$(extract_logged_port "$line_03")"

assert_web_line_uses_base_url_port "$line_01" "$port_01"
assert_web_line_uses_base_url_port "$line_02" "$port_02"
assert_web_line_uses_base_url_port "$line_03" "$port_03"

if [[ "$port_01" == "43173" || "$port_02" == "43173" || "$port_03" == "43173" ]]; then
  echo "expected verify-all web runtime ports to avoid frontend-e2e default 43173" >&2
  echo "resolved ports: $port_01, $port_02, $port_03" >&2
  exit 1
fi

if [[ "$port_01" == "$port_02" || "$port_01" == "$port_03" || "$port_02" == "$port_03" ]]; then
  echo "expected runner-suffixed web runtime ports to be unique across -01/-02/-03" >&2
  echo "resolved ports: $port_01, $port_02, $port_03" >&2
  exit 1
fi

line_fallback="$(run_verify_and_capture_web_line "pool-core99" "44001")"
port_fallback="$(extract_logged_port "$line_fallback")"
if [[ "$port_fallback" != "44001" ]]; then
  echo "expected fallback UIQ_WEB_PORT override to be preserved, got $port_fallback" >&2
  exit 1
fi
assert_web_line_uses_base_url_port "$line_fallback" "$port_fallback"

line_path_fallback="$(run_verify_and_capture_web_line "" "" "/tmp/actions-runner/pool-core02-03/_work/uiq")"
port_path_fallback="$(extract_logged_port "$line_path_fallback")"
if [[ "$port_path_fallback" != "44175" ]]; then
  echo "expected path-based fallback to map -03 suffix to 44175, got $port_path_fallback" >&2
  exit 1
fi
assert_web_line_uses_base_url_port "$line_path_fallback" "$port_path_fallback"

: >"$pnpm_log"
light_output="$(
  (
    cd "$repo_dir"
    env \
      "PATH=$repo_dir/bin:$PATH" \
      "UIQ_VERIFY_PNPM_LOG=$pnpm_log" \
      "CI=true" \
      "UIQ_VERIFY_ENABLE_COVERAGE_GATE=0" \
      "UIQ_VERIFY_ENABLE_MUTATION_GATE=0" \
      "UIQ_VERIFY_ENABLE_TAURI_GATE=0" \
      "UIQ_VERIFY_BRANCH_PROTECTION_STRICT=0" \
      "RUNNER_NAME=pool-core99-01" \
      "GITHUB_WORKSPACE=$repo_dir" \
      "PWD=$repo_dir" \
      "RUNNER_TEMP=$repo_dir/.tmp" \
      bash scripts/verify-all.sh
  ) 2>&1
)"
if ! grep -Fq "[optional-gates] coverage/mutation disabled by config" <<<"$light_output"; then
  echo "expected verify-all light mode to report optional gates disabled" >&2
  printf '%s\n' "$light_output" >&2
  exit 1
fi
if grep -Fq "args=test:coverage" "$pnpm_log"; then
  echo "expected verify-all light mode to skip test:coverage under CI" >&2
  cat "$pnpm_log" >&2
  exit 1
fi
if grep -Fq "args=mutation:effective" "$pnpm_log"; then
  echo "expected verify-all light mode to skip mutation:effective under CI" >&2
  cat "$pnpm_log" >&2
  exit 1
fi

echo "verify-all web runtime port mapping checks passed"
