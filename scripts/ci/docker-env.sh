#!/usr/bin/env bash
set -euo pipefail

UIQ_CI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UIQ_CI_COMPOSE_FILE="$UIQ_CI_ROOT_DIR/docker/compose.ci.yml"
UIQ_ENV_CONTRACT_FILE="$UIQ_CI_ROOT_DIR/.env.example"
UIQ_RUNTIME_CACHE_HOST_ROOT="$UIQ_CI_ROOT_DIR/.runtime-cache"
UIQ_RUNNER_TEMP_CONTAINER="/tmp/uiq-runner"
UIQ_RUNTIME_CACHE_CONTAINER_ROOT="/workspace/.runtime-cache"
if [[ -n "${UIQ_HOST_RUNNER_TEMP_ROOT:-}" && "${UIQ_HOST_RUNNER_TEMP_ROOT}" == /* ]]; then
  UIQ_HOST_RUNNER_TEMP_ROOT="${UIQ_HOST_RUNNER_TEMP_ROOT}"
else
  UIQ_HOST_RUNNER_TEMP_ROOT="${UIQ_RUNTIME_CACHE_HOST_ROOT}/container-runs"
fi
UIQ_CI_GATE_IMAGE_REF="${UIQ_CI_GATE_IMAGE_REF:-uiq-ci-base:local}"
UIQ_CI_BROWSER_IMAGE_REF="${UIQ_CI_BROWSER_IMAGE_REF:-uiq-ci-browser:local}"
UIQ_CONTAINER_GATE_TTL_HOURS=72
UIQ_CONTAINER_GATE_MAX_SIZE_BYTES=$((2 * 1024 * 1024 * 1024))
UIQ_CONTAINER_CONTRACT_ENV_NAMES=(
  PRE_COMMIT_HOME
  TMPDIR
  npm_config_cache
  RUNNER_TEMP
  COREPACK_HOME
  PNPM_STORE_PATH
  UV_CACHE_DIR
  PIP_CACHE_DIR
  PLAYWRIGHT_BROWSERS_PATH
  UIQ_RUNTIME_CACHE_ROOT
  LIVE_GEMINI_API_KEY
)
UIQ_CONTAINER_RESERVED_FORWARD_ENV_NAMES=(
  TMPDIR
  RUNNER_TEMP
  COREPACK_HOME
  PNPM_STORE_PATH
  UV_CACHE_DIR
  PIP_CACHE_DIR
  PLAYWRIGHT_BROWSERS_PATH
  UIQ_RUNTIME_CACHE_ROOT
  UIQ_NODE_MODULES_DIR
  UIQ_PNPM_STORE_DIR
  UIQ_PYTHON_ENV_ROOT
  UV_PROJECT_ENVIRONMENT
  NODE_PATH
  npm_config_modules_dir
  npm_config_virtual_store_dir
  npm_config_store_dir
)

uiq_to_bool() {
  local raw="${1:-}"
  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

uiq_require_ci_prereqs() {
  if [[ ! -f "$UIQ_CI_COMPOSE_FILE" ]]; then
    echo "[container-gate] missing CI compose file: $UIQ_CI_COMPOSE_FILE" >&2
    return 1
  fi

  if [[ ! -f "$UIQ_ENV_CONTRACT_FILE" ]]; then
    echo "[container-gate] missing env contract file: $UIQ_ENV_CONTRACT_FILE" >&2
    return 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "[container-gate] docker command not found" >&2
    return 1
  fi
}

uiq_pick_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    UIQ_COMPOSE_CMD=(docker compose)
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    UIQ_COMPOSE_CMD=(docker-compose)
    return 0
  fi

  echo "[container-gate] docker compose CLI not available" >&2
  return 1
}

uiq_require_python3() {
  if command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  echo "[container-gate] python3 is required to sanitize Docker config for container gates" >&2
  echo "[container-gate] install python3 or remove the host Docker config input before retrying" >&2
  return 1
}

uiq_prepare_host_docker_config() {
  local source_dir="${DOCKER_CONFIG:-$HOME/.docker}"
  local source_file="$source_dir/config.json"
  local host_docker_root="$UIQ_HOST_RUNNER_TEMP_ROOT/uiq-docker-config"
  local target_file="$host_docker_root/config.json"
  local shared_subdir=""
  local preserve_contexts="1"
  if [[ "$(uiq_to_bool "${UIQ_DOCKER_STRIP_CONTEXTS:-0}")" == "1" ]]; then
    preserve_contexts="0"
  fi

  mkdir -p "$host_docker_root"

  if [[ -n "${DOCKER_AUTH_CONFIG:-}" ]]; then
    uiq_require_python3 || return 1
    UIQ_DOCKER_CONFIG_JSON="$DOCKER_AUTH_CONFIG" UIQ_DOCKER_PRESERVE_CONTEXTS="$preserve_contexts" python3 - "$target_file" <<'PY'
import json
import os
import sys
from pathlib import Path

target_path = Path(sys.argv[1])
payload = json.loads(os.environ["UIQ_DOCKER_CONFIG_JSON"])
payload.pop("credsStore", None)
payload.pop("credStore", None)
payload.pop("credHelpers", None)
if os.environ.get("UIQ_DOCKER_PRESERVE_CONTEXTS") != "1":
    payload.pop("currentContext", None)
target_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  elif [[ -f "$source_file" ]]; then
    uiq_require_python3 || return 1
    UIQ_DOCKER_PRESERVE_CONTEXTS="$preserve_contexts" python3 - "$source_file" "$target_file" <<'PY'
import json
import os
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
target_path = Path(sys.argv[2])
payload = json.loads(source_path.read_text(encoding="utf-8"))
payload.pop("credsStore", None)
payload.pop("credStore", None)
payload.pop("credHelpers", None)
if os.environ.get("UIQ_DOCKER_PRESERVE_CONTEXTS") != "1":
    payload.pop("currentContext", None)
target_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  else
    printf '%s\n' '{' '  "auths": {}' '}' >"$target_file"
  fi

  for shared_subdir in cli-plugins; do
    if [[ -d "$source_dir/$shared_subdir" && ! -e "$host_docker_root/$shared_subdir" ]]; then
      ln -s "$source_dir/$shared_subdir" "$host_docker_root/$shared_subdir"
    fi
  done

  if [[ "$preserve_contexts" == "1" && -d "$source_dir/contexts" && ! -e "$host_docker_root/contexts" ]]; then
    ln -s "$source_dir/contexts" "$host_docker_root/contexts"
  elif [[ "$preserve_contexts" != "1" && -e "$host_docker_root/contexts" ]]; then
    rm -rf "$host_docker_root/contexts"
  fi

  export DOCKER_CONFIG="$host_docker_root"
  export UIQ_HOST_DOCKER_CONFIG_DIR="$host_docker_root"
}

uiq_prepare_container_gate_dirs() {
  local gate_name="$1"
  local run_id="${UIQ_CONTAINER_GATE_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
  local shared_runner_temp_root="$UIQ_HOST_RUNNER_TEMP_ROOT"

  UIQ_CONTAINER_GATE_RUN_ID="$run_id"
  UIQ_CONTAINER_GATE_HOST_ROOT="$UIQ_RUNTIME_CACHE_HOST_ROOT/container-gates"
  UIQ_CONTAINER_GATE_HOST_RUN_DIR="$UIQ_CONTAINER_GATE_HOST_ROOT/$gate_name/$run_id"
  UIQ_CONTAINER_GATE_HOST_LOG_DIR="$UIQ_CONTAINER_GATE_HOST_RUN_DIR/logs"
  UIQ_CONTAINER_GATE_HOST_ARTIFACT_DIR="$UIQ_CONTAINER_GATE_HOST_RUN_DIR/artifacts"
  UIQ_CONTAINER_GATE_HOST_STATE_DIR="$UIQ_CONTAINER_GATE_HOST_RUN_DIR/state"
  # Keep runner-temp isolated per gate run, but outside the workspace bind mount,
  # so /workspace and /tmp/uiq-runner do not point at overlapping host paths.
  UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT="$shared_runner_temp_root/$gate_name/$run_id"

  UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR="$UIQ_RUNTIME_CACHE_CONTAINER_ROOT/container-gates/$gate_name/$run_id"
  UIQ_CONTAINER_GATE_CONTAINER_LOG_DIR="$UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR/logs"
  UIQ_CONTAINER_GATE_CONTAINER_ARTIFACT_DIR="$UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR/artifacts"
  UIQ_CONTAINER_GATE_CONTAINER_STATE_DIR="$UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR/state"

  mkdir -p \
    "$UIQ_RUNTIME_CACHE_HOST_ROOT" \
    "$UIQ_HOST_RUNNER_TEMP_ROOT" \
    "$UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT" \
    "$UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT/uiq-node-modules" \
    "$UIQ_CONTAINER_GATE_HOST_ROOT" \
    "$UIQ_CONTAINER_GATE_HOST_LOG_DIR" \
    "$UIQ_CONTAINER_GATE_HOST_ARTIFACT_DIR" \
    "$UIQ_CONTAINER_GATE_HOST_STATE_DIR"

  # Pre-create the node_modules bridge so Docker does not materialize it as a
  # root-owned bind target that non-root CI browser users cannot write to.
  chmod 0777 "$UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT/uiq-node-modules"

  export UIQ_CONTAINER_GATE_RUN_ID
  export UIQ_CONTAINER_GATE_HOST_ROOT
  export UIQ_CONTAINER_GATE_HOST_RUN_DIR
  export UIQ_CONTAINER_GATE_HOST_LOG_DIR
  export UIQ_CONTAINER_GATE_HOST_ARTIFACT_DIR
  export UIQ_CONTAINER_GATE_HOST_STATE_DIR
  export UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT
  export UIQ_CONTAINER_GATE_CONTAINER_RUN_DIR
  export UIQ_CONTAINER_GATE_CONTAINER_LOG_DIR
  export UIQ_CONTAINER_GATE_CONTAINER_ARTIFACT_DIR
  export UIQ_CONTAINER_GATE_CONTAINER_STATE_DIR
  export UIQ_CI_GATE_IMAGE_REF="uiq-ci-base:${run_id}"
  export UIQ_CI_BROWSER_IMAGE_REF="uiq-ci-browser:${run_id}"
}

uiq_cleanup_current_container_gate_bridge() {
  local bridge_root="${UIQ_CONTAINER_GATE_HOST_RUNNER_TEMP_ROOT:-}"
  [[ -n "$bridge_root" ]] || return 0
  [[ -e "$bridge_root" ]] || return 0
  rm -rf "$bridge_root"
  rmdir "$(dirname "$bridge_root")" 2>/dev/null || true
}

uiq_prune_expired_container_gate_history() {
  local gate_root="${UIQ_CONTAINER_GATE_HOST_ROOT:-$UIQ_RUNTIME_CACHE_HOST_ROOT/container-gates}"
  local runner_root="${UIQ_HOST_RUNNER_TEMP_ROOT}"

  python3 - "$gate_root" "$runner_root" "$UIQ_CONTAINER_GATE_TTL_HOURS" "$UIQ_CONTAINER_GATE_MAX_SIZE_BYTES" <<'PY'
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path


def looks_like_run_id(path: Path) -> bool:
    name = path.name
    parts = name.split("-")
    return len(parts) == 3 and all(part.isdigit() for part in parts)


def dir_size_bytes(path: Path) -> int:
    try:
        output = os.popen(f"du -sk '{path}'").read().strip().split()
        if not output:
            return 0
        return int(output[0]) * 1024
    except Exception:
        return 0


def collect_prunable_units(root: Path) -> list[Path]:
    if not root.exists():
        return []
    units: list[Path] = []
    now = time.time()
    for top_entry in root.iterdir():
        if not top_entry.is_dir():
            continue
        children = [child for child in top_entry.iterdir() if child.is_dir()]
        immediate_runs = [child for child in children if looks_like_run_id(child)]
        if immediate_runs:
            units.extend(immediate_runs)
            continue
        nested_runs: list[Path] = []
        for child in children:
            nested_runs.extend(
                grandchild
                for grandchild in child.iterdir()
                if grandchild.is_dir() and looks_like_run_id(grandchild)
            )
        if nested_runs:
            units.extend(nested_runs)
            continue
        units.append(top_entry)
    return units


def prune_units(root: Path, ttl_seconds: float, max_size_bytes: int) -> None:
    units = collect_prunable_units(root)
    if not units:
        return
    now = time.time()
    kept: list[tuple[Path, float, int]] = []
    for run_dir in units:
        age_seconds = now - run_dir.stat().st_mtime
        if age_seconds > ttl_seconds:
            shutil.rmtree(run_dir, ignore_errors=True)
            continue
        kept.append((run_dir, run_dir.stat().st_mtime, dir_size_bytes(run_dir)))

    total_size = sum(size for _, _, size in kept)
    if total_size > max_size_bytes:
        for run_dir, _, size in sorted(kept, key=lambda item: item[1]):
            if total_size <= max_size_bytes:
                break
            shutil.rmtree(run_dir, ignore_errors=True)
            total_size -= size

    for gate_dir in root.iterdir():
        if not gate_dir.is_dir():
            continue
        for candidate in gate_dir.iterdir():
            if not candidate.is_dir():
                continue
            try:
                candidate.rmdir()
            except OSError:
                pass
        try:
            gate_dir.rmdir()
        except OSError:
            pass


gate_root = Path(sys.argv[1])
runner_root = Path(sys.argv[2])
ttl_hours = int(sys.argv[3])
ttl_seconds = ttl_hours * 3600
max_size_bytes = int(sys.argv[4])

prune_units(gate_root, ttl_seconds, max_size_bytes)
prune_units(runner_root, ttl_seconds, max_size_bytes)
PY
}

uiq_collect_contract_env_names() {
  sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$UIQ_ENV_CONTRACT_FILE"
}

uiq_append_env_arg_if_set() {
  local target_array_name="$1"
  local env_name="$2"

  if [[ -n "${!env_name+x}" ]]; then
    eval "$target_array_name+=(\"-e\" \"$env_name\")"
  fi
}

uiq_is_reserved_container_env_name() {
  local env_name="$1"
  local reserved_name=""
  for reserved_name in "${UIQ_CONTAINER_RESERVED_FORWARD_ENV_NAMES[@]}"; do
    if [[ "$reserved_name" == "$env_name" ]]; then
      return 0
    fi
  done
  return 1
}

uiq_collect_forward_env_args() {
  local target_array_name="$1"
  local env_name
  local candidate

  eval "$target_array_name=()"

  while IFS= read -r env_name; do
    [[ -n "$env_name" ]] || continue
    uiq_is_reserved_container_env_name "$env_name" && continue
    uiq_append_env_arg_if_set "$target_array_name" "$env_name"
  done < <(uiq_collect_contract_env_names)

  for env_name in CI GITHUB_ACTIONS GITHUB_REF GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GH_TOKEN GITHUB_TOKEN; do
    uiq_append_env_arg_if_set "$target_array_name" "$env_name"
  done

  for env_name in "${UIQ_CONTAINER_CONTRACT_ENV_NAMES[@]}"; do
    uiq_is_reserved_container_env_name "$env_name" && continue
    uiq_append_env_arg_if_set "$target_array_name" "$env_name"
  done

  while IFS='=' read -r candidate _; do
    [[ "$candidate" == UIQ_* ]] || continue
    uiq_is_reserved_container_env_name "$candidate" && continue
    uiq_append_env_arg_if_set "$target_array_name" "$candidate"
  done < <(env)
}
