#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_PROJECT_ROOT="${UIQ_PYTHON_PROJECT_ROOT:-$ROOT_DIR/services/api}"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/python-toolchain.sh"

usage() {
  cat <<'EOF' >&2
Usage: bash scripts/lib/python-exec.sh <tool> [args...]

Tools:
  sync
  python
  pytest
  ruff
  uvicorn
  alembic
  pre-commit
  pip-audit
  bandit
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

tool="$1"
shift

uiq_require_uv
uiq_export_python_env

python_bin="${UIQ_PYTHON_ENV_ROOT}/bin/python"
if ! uiq_python_env_healthy; then
  uiq_sync_python_env "$ROOT_DIR" "$PYTHON_PROJECT_ROOT"
  python_bin="${UIQ_PYTHON_ENV_ROOT}/bin/python"
fi

resolve_env_bin() {
  local name="$1"
  local bin_path="${UIQ_PYTHON_ENV_ROOT}/bin/${name}"
  if [[ -x "$bin_path" ]]; then
    printf '%s\n' "$bin_path"
    return 0
  fi
  return 1
}

case "$tool" in
  sync)
    uiq_sync_python_env "$ROOT_DIR" "$PYTHON_PROJECT_ROOT"
    exit 0
    ;;
  python)
    cd "$PYTHON_PROJECT_ROOT"
    exec "$python_bin" "$@"
    ;;
  pytest)
    cd "$PYTHON_PROJECT_ROOT"
    exec "$python_bin" -m pytest "$@"
    ;;
  uvicorn)
    cd "$PYTHON_PROJECT_ROOT"
    exec "$(resolve_env_bin uvicorn)" "$@"
    ;;
  alembic)
    cd "$ROOT_DIR"
    alembic_args=("$@")
    if [[ " $* " != *" -c "* ]] && [[ " $* " != *" --config "* ]]; then
      alembic_args=("-c" "services/api/alembic.ini" "${alembic_args[@]}")
    else
      for ((i = 0; i < ${#alembic_args[@]}; i += 1)); do
        if [[ "${alembic_args[$i]}" == "-c" || "${alembic_args[$i]}" == "--config" ]]; then
          next_index=$((i + 1))
          if [[ $next_index -lt ${#alembic_args[@]} && "${alembic_args[$next_index]}" == "alembic.ini" ]]; then
            alembic_args[$next_index]="services/api/alembic.ini"
          fi
        fi
      done
    fi
    exec "$(resolve_env_bin alembic)" "${alembic_args[@]}"
    ;;
  *)
    cd "$PYTHON_PROJECT_ROOT"
    if bin_path="$(resolve_env_bin "$tool")"; then
      exec "$bin_path" "$@"
    fi
    exec uv run --extra dev "$tool" "$@"
    ;;
esac
