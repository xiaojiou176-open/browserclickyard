#!/usr/bin/env bash
set -euo pipefail

uiq_python_project_root() {
  if [[ -n "${UIQ_PYTHON_PROJECT_ROOT:-}" ]]; then
    printf '%s\n' "$UIQ_PYTHON_PROJECT_ROOT"
    return 0
  fi
  printf '%s\n' "${PWD}/services/api"
}

uiq_required_python_version() {
  printf '%s\n' "${UIQ_PYTHON_VERSION:-3.12}"
}

uiq_resolve_python_env_root() {
  if [[ -n "${UIQ_PYTHON_ENV_ROOT:-}" ]]; then
    printf '%s\n' "$UIQ_PYTHON_ENV_ROOT"
    return 0
  fi
  if [[ -n "${RUNNER_TEMP:-}" ]]; then
    printf '%s\n' "${RUNNER_TEMP}/uiq-python-env"
    return 0
  fi
  printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/python-env"
}

uiq_export_python_env() {
  export UIQ_PYTHON_ENV_ROOT="${UIQ_PYTHON_ENV_ROOT:-$(uiq_resolve_python_env_root)}"
  export UIQ_PYTHON_VERSION="${UIQ_PYTHON_VERSION:-$(uiq_required_python_version)}"
  export UV_PYTHON="${UV_PYTHON:-$UIQ_PYTHON_VERSION}"
  export UV_PROJECT_ENVIRONMENT="$UIQ_PYTHON_ENV_ROOT"
  mkdir -p "$(dirname "$UIQ_PYTHON_ENV_ROOT")"
}

uiq_cleanup_python_root_noise() {
  local root_dir="${1:-$PWD}"
  rm -rf "${root_dir}/pagestress.egg-info"
}

uiq_python_env_healthy() {
  local python_bin="${UIQ_PYTHON_ENV_ROOT}/bin/python"
  if [[ ! -x "$python_bin" ]]; then
    return 1
  fi
  "$python_bin" -c "import sys; import os; expected=os.environ.get('UIQ_PYTHON_VERSION','3.12'); assert sys.executable; assert sys.version.startswith(expected), (sys.version, expected)" >/dev/null 2>&1
}

uiq_require_uv() {
  if ! command -v uv >/dev/null 2>&1; then
    echo "error: uv not found in PATH" >&2
    return 1
  fi
}

uiq_project_has_dependency_group() {
  local project_root="$1"
  local group_name="$2"
  local pyproject_file="${project_root}/pyproject.toml"
  [[ -f "$pyproject_file" ]] || return 1
  python3 - "$pyproject_file" "$group_name" <<'PY'
from pathlib import Path
import sys
import tomllib

pyproject_path = Path(sys.argv[1])
group_name = sys.argv[2]
payload = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
groups = payload.get("dependency-groups") or {}
if group_name in groups:
    raise SystemExit(0)
raise SystemExit(1)
PY
}

uiq_sync_python_env() {
  local root_dir="${1:-$PWD}"
  local project_root="${2:-$(uiq_python_project_root)}"
  local sync_root="$project_root"
  local -a sync_args=("--frozen" "--all-extras" "--python" "$(uiq_required_python_version)")
  uiq_require_uv
  uiq_export_python_env
  uiq_cleanup_python_root_noise "$root_dir"
  if [[ -d "$UIQ_PYTHON_ENV_ROOT" ]] && ! uiq_python_env_healthy; then
    rm -rf "$UIQ_PYTHON_ENV_ROOT"
  fi
  if [[ ! -f "$sync_root/uv.lock" && -f "$root_dir/uv.lock" ]]; then
    sync_root="$root_dir"
  fi
  if [[ "$sync_root" != "$project_root" ]]; then
    # When we fall back to the repo-root lockfile, we only need third-party deps.
    # Installing the root project itself adds an expensive editable build step.
    sync_args+=("--no-install-project")
  fi
  if uiq_project_has_dependency_group "$sync_root" "dev"; then
    sync_args+=("--group" "dev")
  fi
  if (
    cd "$sync_root"
    uv sync "${sync_args[@]}"
  ); then
    uiq_cleanup_python_root_noise "$root_dir"
    return 0
  else
    local status=$?
    uiq_cleanup_python_root_noise "$root_dir"
    return "$status"
  fi
}
