#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=./docker-env.sh
source "$ROOT_DIR/scripts/ci/docker-env.sh"

echo "[iac-consistency-gate] start"

exists_path() {
  local candidate="$1"
  [[ -e "$candidate" ]]
}

to_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) echo "1" ;;
    *) echo "0" ;;
  esac
}

has_devcontainer=0
has_compose=0
has_nix=0
is_ci=0

case "${CI:-}" in
  1|true|TRUE|yes|YES|on|ON) is_ci=1 ;;
esac

if exists_path ".devcontainer" || exists_path "devcontainer"; then
  has_devcontainer=1
fi

if exists_path "docker-compose.yml" || exists_path "docker-compose.yaml"; then
  has_compose=1
fi

if exists_path "nix" || exists_path "flake.nix" || exists_path "shell.nix" || exists_path "default.nix"; then
  has_nix=1
fi

echo "[iac-consistency-gate] presence: devcontainer=${has_devcontainer} compose=${has_compose} nix=${has_nix}"

if [[ "$has_devcontainer" != "1" ]]; then
  echo "[iac-consistency-gate] FAIL: missing .devcontainer directory (container truth source requires devcontainer contract)." >&2
  exit 1
fi

required_files=(
  ".dockerignore"
  ".devcontainer/devcontainer.json"
  ".devcontainer/compose.yaml"
  "services/api/Dockerfile"
  "apps/command-center/Dockerfile"
  "docker/ci/base.Dockerfile"
  "docker/ci/browser.Dockerfile"
  "docker/compose.ci.yml"
)

for required in "${required_files[@]}"; do
  if [[ ! -f "$required" ]]; then
    echo "[iac-consistency-gate] FAIL: missing required IaC file: $required" >&2
    exit 1
  fi
done

file_has_pattern() {
  local candidate="$1"
  local pattern="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -n "$pattern" "$candidate" >/dev/null 2>&1
    return $?
  fi
  grep -nE "$pattern" "$candidate" >/dev/null 2>&1
}

require_pattern_in_file() {
  local candidate="$1"
  local pattern="$2"
  local failure_message="$3"
  if ! file_has_pattern "$candidate" "$pattern"; then
    echo "[iac-consistency-gate] FAIL: ${failure_message}" >&2
    exit 1
  fi
}

require_pattern_in_file ".devcontainer/devcontainer.json" "\\.\\./docker/compose\\.ci\\.yml" ".devcontainer/devcontainer.json must reference ../docker/compose.ci.yml"
require_pattern_in_file ".devcontainer/devcontainer.json" "compose\\.yaml" ".devcontainer/devcontainer.json must reference .devcontainer/compose.yaml override"
require_pattern_in_file ".devcontainer/devcontainer.json" "\"service\"\\s*:\\s*\"devcontainer\"" ".devcontainer/devcontainer.json must set service=devcontainer"
require_pattern_in_file ".devcontainer/devcontainer.json" "\"workspaceFolder\"\\s*:\\s*\"/workspace\"" ".devcontainer/devcontainer.json must set workspaceFolder=/workspace"
require_pattern_in_file ".devcontainer/compose.yaml" "dockerfile:\\s*docker/ci/browser\\.Dockerfile" ".devcontainer/compose.yaml must reuse docker/ci/browser.Dockerfile"
require_pattern_in_file ".devcontainer/compose.yaml" "image:\\s*uiq-ci-browser:local" ".devcontainer/compose.yaml must align image tag with CI browser image"

for env_name in "${UIQ_CONTAINER_CONTRACT_ENV_NAMES[@]}"; do
  require_pattern_in_file \
    "docker/compose.ci.yml" \
    "^[[:space:]]+${env_name}:" \
    "docker/compose.ci.yml missing container contract env '${env_name}'"
  require_pattern_in_file \
    ".devcontainer/compose.yaml" \
    "^[[:space:]]+${env_name}:" \
    ".devcontainer/compose.yaml missing container contract env '${env_name}'"
done

if [[ ! -f "docker-compose.yml" && ! -f "docker-compose.yaml" ]]; then
  echo "[iac-consistency-gate] FAIL: missing required IaC file: docker-compose.yml (or docker-compose.yaml)" >&2
  exit 1
fi

readme_compose_pattern='docker compose up -d --build'
if command -v rg >/dev/null 2>&1; then
  if ! rg -n "$readme_compose_pattern" README.md >/dev/null 2>&1; then
    echo "[iac-consistency-gate] FAIL: README.md must document docker compose startup command." >&2
    exit 1
  fi
else
  if ! grep -nE "$readme_compose_pattern" README.md >/dev/null 2>&1; then
    echo "[iac-consistency-gate] FAIL: README.md must document docker compose startup command." >&2
    exit 1
  fi
fi

if command -v docker >/dev/null 2>&1; then
  temp_env_created=0
  compose_cmd=()
  cleanup_temp_env() {
    if [[ "$temp_env_created" -eq 1 ]]; then
      rm -f .env
    fi
  }
  trap cleanup_temp_env EXIT

  if [[ ! -f ".env" && -f ".env.example" ]]; then
    cp .env.example .env
    temp_env_created=1
  fi

  if [[ -f ".env" ]]; then
    if docker compose version >/dev/null 2>&1; then
      compose_cmd=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
      compose_cmd=(docker-compose)
    elif [[ "$is_ci" == "1" ]]; then
      if [[ "$(to_bool "${UIQ_ALLOW_COMPOSE_SKIP:-0}")" == "1" ]]; then
        if [[ -z "${UIQ_ALLOW_COMPOSE_SKIP_REASON:-}" ]]; then
          echo "[iac-consistency-gate] FAIL: UIQ_ALLOW_COMPOSE_SKIP=1 requires UIQ_ALLOW_COMPOSE_SKIP_REASON." >&2
          exit 1
        fi
        echo "[iac-consistency-gate] WARN: compose CLI unavailable on CI runner, skipping compose config validation due to UIQ_ALLOW_COMPOSE_SKIP=1."
        echo "[iac-consistency-gate] WARN: compose skip reason is provided (redacted)."
        compose_cmd=()
      else
        echo "[iac-consistency-gate] FAIL: compose CLI unavailable on CI runner; set UIQ_ALLOW_COMPOSE_SKIP=1 to override." >&2
        exit 1
      fi
    else
      echo "[iac-consistency-gate] FAIL: docker compose plugin not available on runner." >&2
      exit 1
    fi

    if [[ "${#compose_cmd[@]}" -gt 0 ]]; then
      if "${compose_cmd[@]}" config --help 2>/dev/null | grep -q -- '--quiet'; then
        "${compose_cmd[@]}" config --quiet
        "${compose_cmd[@]}" -f docker/compose.ci.yml config --quiet
      else
        "${compose_cmd[@]}" config >/dev/null
        "${compose_cmd[@]}" -f docker/compose.ci.yml config >/dev/null
      fi
    fi
  else
    echo "[iac-consistency-gate] FAIL: neither .env nor .env.example found for docker compose validation." >&2
    exit 1
  fi
else
  echo "[iac-consistency-gate] FAIL: docker command not found; cannot validate compose config." >&2
  exit 1
fi

echo "[iac-consistency-gate] PASS"
