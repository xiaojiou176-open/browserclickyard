#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./docker-env.sh
source "$ROOT_DIR/scripts/ci/docker-env.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/ci/run-gate-in-container.sh <gate-name>

Supported gate names:
  docs-gate
  exec
  lint-all
  lockfile-drift
  test-matrix
  verify-all
EOF
}

resolve_gate() {
  local gate_name="$1"

  case "$gate_name" in
    docs-gate)
      UIQ_GATE_SERVICE="ci-gate"
      UIQ_GATE_COMMAND="bash scripts/docs-gate.sh"
      UIQ_GATE_BUILD_SERVICES=(ci-gate)
      ;;
    lint-all)
      UIQ_GATE_SERVICE="ci-gate"
      UIQ_GATE_COMMAND="bash scripts/lint-all.sh"
      UIQ_GATE_BUILD_SERVICES=(ci-gate)
      ;;
    exec)
      UIQ_GATE_SERVICE="${UIQ_CONTAINER_GATE_SERVICE_OVERRIDE:-}"
      UIQ_GATE_COMMAND="${UIQ_CONTAINER_GATE_COMMAND_OVERRIDE:-}"
      case "${UIQ_CONTAINER_GATE_BUILD_OVERRIDE:-${UIQ_GATE_SERVICE}}" in
        ci-browser)
          UIQ_GATE_BUILD_SERVICES=(ci-gate ci-browser)
          ;;
        ci-gate)
          UIQ_GATE_BUILD_SERVICES=(ci-gate)
          ;;
        *)
          echo "[container-gate] unsupported exec build override: ${UIQ_CONTAINER_GATE_BUILD_OVERRIDE:-${UIQ_GATE_SERVICE}}" >&2
          return 1
          ;;
      esac
      if [[ -z "$UIQ_GATE_SERVICE" || -z "$UIQ_GATE_COMMAND" ]]; then
        echo "[container-gate] exec gate requires UIQ_CONTAINER_GATE_SERVICE_OVERRIDE and UIQ_CONTAINER_GATE_COMMAND_OVERRIDE" >&2
        return 1
      fi
      ;;
    lockfile-drift)
      UIQ_GATE_SERVICE="ci-gate"
      UIQ_GATE_COMMAND="bash scripts/lib/pnpm-safe.sh gate:lock:drift"
      UIQ_GATE_BUILD_SERVICES=(ci-gate)
      ;;
    test-matrix)
      UIQ_GATE_SERVICE="ci-browser"
      UIQ_GATE_COMMAND="UIQ_SKIP_NODE_LINK_REPAIR=1 UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 bash scripts/test-matrix.sh"
      UIQ_GATE_BUILD_SERVICES=(ci-gate ci-browser)
      ;;
    verify-all)
      UIQ_GATE_SERVICE="ci-browser"
      UIQ_GATE_COMMAND="UIQ_SKIP_NODE_LINK_REPAIR=1 UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 bash scripts/verify-all.sh"
      UIQ_GATE_BUILD_SERVICES=(ci-gate ci-browser)
      ;;
    *)
      echo "[container-gate] unsupported gate: $gate_name" >&2
      usage >&2
      return 1
      ;;
  esac
}

should_skip_build() {
  case "${UIQ_SKIP_CONTAINER_BUILD:-0}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
  esac
  return 1
}

uiq_cleanup_container_gate_artifacts() {
  local exit_code="${1:-0}"
  local ttl_hours="${UIQ_CONTAINER_GATE_TTL_HOURS:-72}"
  local -a image_refs=()
  local repo_tmp_root="$ROOT_DIR/tmp"
  local repo_tmp_runner_bridge="$repo_tmp_root/uiq-runner"
  case "${UIQ_GATE_SERVICE:-}" in
    ci-gate)
      [[ -n "${UIQ_CI_GATE_IMAGE_REF:-}" ]] && image_refs+=("${UIQ_CI_GATE_IMAGE_REF}")
      ;;
    ci-browser)
      [[ -n "${UIQ_CI_BROWSER_IMAGE_REF:-}" ]] && image_refs+=("${UIQ_CI_BROWSER_IMAGE_REF}")
      [[ -n "${UIQ_CI_GATE_IMAGE_REF:-}" ]] && image_refs+=("${UIQ_CI_GATE_IMAGE_REF}")
      ;;
  esac

  if [[ "${#image_refs[@]}" -gt 0 ]]; then
    docker image rm "${image_refs[@]}" >/dev/null 2>&1 || true
  fi

  if [[ -n "${UIQ_HOST_DOCKER_CONFIG_DIR:-}" && -d "${UIQ_HOST_DOCKER_CONFIG_DIR:-}" ]]; then
    rm -rf "${UIQ_HOST_DOCKER_CONFIG_DIR}" || true
  fi

  if [[ -L "$repo_tmp_runner_bridge" || -d "$repo_tmp_runner_bridge" ]]; then
    rm -rf "$repo_tmp_runner_bridge" || true
  fi
  if [[ "$exit_code" == "0" && -n "${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT:-}" && -d "${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT:-}" ]]; then
    rm -rf "${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT}" || true
  fi
  if [[ "$exit_code" == "0" && -n "${UIQ_CONTAINER_GATE_HOST_RUN_DIR:-}" && -d "${UIQ_CONTAINER_GATE_HOST_RUN_DIR:-}" ]]; then
    find "${UIQ_CONTAINER_GATE_HOST_RUN_DIR}" -mindepth 1 -maxdepth 2 -type d -empty -delete 2>/dev/null || true
  fi
  if [[ "${ttl_hours}" =~ ^[0-9]+$ ]] && (( ttl_hours > 0 )); then
    local ttl_minutes=$((ttl_hours * 60))
    for root in "${UIQ_CONTAINER_GATE_HOST_ROOT:-}" "${UIQ_HOST_RUNNER_TEMP_ROOT:-}"; do
      [[ -n "${root}" && -d "${root}" ]] || continue
      find "${root}" -mindepth 2 -maxdepth 2 -type d -mmin +"${ttl_minutes}" -exec rm -rf {} + 2>/dev/null || true
      find "${root}" -mindepth 1 -maxdepth 2 -type d -empty -delete 2>/dev/null || true
    done
  fi
  if [[ -d "$repo_tmp_root" ]] && ! find "$repo_tmp_root" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
    rmdir "$repo_tmp_root" >/dev/null 2>&1 || true
  fi
}

main() {
  local gate_name="${1:-}"
  shift || true
  local gate_mode_arg="${1:-}"
  local -a forward_env_args=()
  local -a compose_run_args=()
  local bootstrap_cmd="UIQ_SKIP_NODE_LINK_REPAIR=1 UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 bash scripts/lib/pnpm-safe.sh gate:lock:drift && UIQ_SKIP_NODE_LINK_REPAIR=1 UIQ_SKIP_SHARED_MODULE_LINK_REPAIR=1 bash scripts/ci/pnpm-install-safe.sh --frozen-lockfile && bash scripts/lib/python-exec.sh sync"
  local gate_shell_cmd=""
  local playwright_browsers_path=""
  local container_runner_temp_root=""

  if [[ -z "$gate_name" ]]; then
    usage >&2
    exit 1
  fi

  cleanup() {
    local exit_code=$?
    trap - EXIT
    uiq_cleanup_container_gate_artifacts "$exit_code"
    exit "$exit_code"
  }
  trap cleanup EXIT

  uiq_require_ci_prereqs
  uiq_pick_compose_cmd
  resolve_gate "$gate_name"
  uiq_prepare_container_gate_dirs "$gate_name"
  uiq_prepare_host_docker_config
  export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"
  export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-0}"
  container_runner_temp_root="${UIQ_RUNNER_TEMP_CONTAINER}"
  playwright_browsers_path="${container_runner_temp_root}/uiq-ms-playwright/${UIQ_GATE_SERVICE}"
  uiq_collect_forward_env_args forward_env_args

  printf '%s\n' "$gate_name" >"$UIQ_CONTAINER_GATE_HOST_STATE_DIR/gate-name.txt"
  printf '%s\n' "$UIQ_GATE_SERVICE" >"$UIQ_CONTAINER_GATE_HOST_STATE_DIR/service.txt"
  printf '%s\n' "$UIQ_GATE_COMMAND" >"$UIQ_CONTAINER_GATE_HOST_STATE_DIR/command.txt"

  echo "[container-gate] gate=$gate_name service=$UIQ_GATE_SERVICE"
  echo "[container-gate] run-dir=$UIQ_CONTAINER_GATE_HOST_RUN_DIR"
  echo "[container-gate] docker-config=$DOCKER_CONFIG"
  if should_skip_build; then
    echo "[container-gate] build skipped by UIQ_SKIP_CONTAINER_BUILD=1"
  else
    echo "[container-gate] building services: ${UIQ_GATE_BUILD_SERVICES[*]}"
    for build_service in "${UIQ_GATE_BUILD_SERVICES[@]}"; do
      "${UIQ_COMPOSE_CMD[@]}" -f "$UIQ_CI_COMPOSE_FILE" build "$build_service"
    done
  fi

  if [[ "$UIQ_GATE_SERVICE" == "ci-browser" ]]; then
    playwright_browsers_path="/ms-playwright"
  fi

  gate_shell_cmd="mkdir -p '$UIQ_CONTAINER_GATE_CONTAINER_LOG_DIR' '$UIQ_CONTAINER_GATE_CONTAINER_ARTIFACT_DIR' '$UIQ_CONTAINER_GATE_CONTAINER_STATE_DIR' '$container_runner_temp_root/tmp' && $bootstrap_cmd && $UIQ_GATE_COMMAND"

  compose_run_args=(
    --rm
    -T
    -v "${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT}:${UIQ_RUNNER_TEMP_CONTAINER}"
    -v "${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT}/uiq-node-modules:/workspace/node_modules"
    -e "CI=true"
    -e "TMPDIR=$container_runner_temp_root/tmp"
    -e "UIQ_CONTAINER_GATE_NAME=$gate_name"
    -e "UIQ_CONTAINER_GATE_RUN_ID=$UIQ_CONTAINER_GATE_RUN_ID"
    -e "UIQ_CONTAINER_GATE_RUN_DIR=$UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR"
    -e "UIQ_CONTAINER_GATE_LOG_DIR=$UIQ_CONTAINER_GATE_CONTAINER_LOG_DIR"
    -e "UIQ_CONTAINER_GATE_ARTIFACT_DIR=$UIQ_CONTAINER_GATE_CONTAINER_ARTIFACT_DIR"
    -e "UIQ_CONTAINER_GATE_STATE_DIR=$UIQ_CONTAINER_GATE_CONTAINER_STATE_DIR"
    -e "UIQ_RUNTIME_CACHE_ROOT=$UIQ_RUNTIME_CACHE_CONTAINER_ROOT"
    -e "RUNNER_TEMP=$container_runner_temp_root"
    -e "COREPACK_HOME=$container_runner_temp_root/uiq-corepack"
    -e "PNPM_STORE_PATH=$container_runner_temp_root/uiq-pnpm-store"
    -e "UIQ_NODE_MODULES_DIR=/workspace/node_modules"
    -e "npm_config_store_dir=$container_runner_temp_root/uiq-pnpm-store"
    -e "UV_CACHE_DIR=$container_runner_temp_root/uiq-python-cache/uv"
    -e "UV_HTTP_TIMEOUT=${UV_HTTP_TIMEOUT:-120}"
    -e "PIP_CACHE_DIR=$container_runner_temp_root/uiq-python-cache/pip"
    -e "UIQ_PYTHON_ENV_ROOT=$container_runner_temp_root/uiq-python-env"
    -e "UV_PROJECT_ENVIRONMENT=$container_runner_temp_root/uiq-python-env"
    -e "PLAYWRIGHT_BROWSERS_PATH=$playwright_browsers_path"
    -e "HEADLESS=true"
  )

  if [[ -n "${PRE_COMMIT_HOME:-}" ]]; then
    compose_run_args+=(-e "PRE_COMMIT_HOME=$PRE_COMMIT_HOME")
  fi

  if [[ -n "$gate_mode_arg" ]]; then
    case "$gate_name" in
      test-matrix)
        compose_run_args+=(-e "UIQ_TEST_MODE=$gate_mode_arg")
        ;;
      *)
        echo "[container-gate] WARN: ignoring extra argument '$gate_mode_arg' for gate '$gate_name'"
        ;;
    esac
  fi

  compose_run_args+=("${forward_env_args[@]}")
  compose_run_args+=("$UIQ_GATE_SERVICE" bash -lc "$gate_shell_cmd")

  local gate_status=0
  if "${UIQ_COMPOSE_CMD[@]}" -f "$UIQ_CI_COMPOSE_FILE" run "${compose_run_args[@]}"; then
    gate_status=0
  else
    gate_status=$?
  fi

  if [[ "$gate_status" -eq 0 ]]; then
    uiq_cleanup_current_container_gate_bridge
  fi
  uiq_prune_expired_container_gate_history

  return "$gate_status"
}

main "$@"
