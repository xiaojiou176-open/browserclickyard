#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage: scripts/ci/make-failure-bundle.sh <job-name> [output-dir]

Args/env resolution:
  job-name    arg1 > FAILURE_BUNDLE_JOB > CI_JOB_NAME > GITHUB_JOB
  output-dir  arg2 > FAILURE_BUNDLE_OUTPUT_DIR

Default output:
  .runtime-cache/artifacts/ci/failure-bundles/<job-slug>/
USAGE
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

slugify_job() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  value="$(printf '%s' "$value" | tr '/[:space:]' '__')"
  value="$(printf '%s' "$value" | tr -cd 'a-z0-9._-')"
  if [[ -z "$value" ]]; then
    value="unknown-job"
  fi
  printf '%s' "$value"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

json_str_or_null() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf 'null'
  else
    printf '"%s"' "$(json_escape "$value")"
  fi
}

job_name="${1:-${FAILURE_BUNDLE_JOB:-${CI_JOB_NAME:-${GITHUB_JOB:-}}}}"
job_name="$(trim "$job_name")"
if [[ -z "$job_name" ]]; then
  usage >&2
  exit 2
fi

safe_job="$(slugify_job "$job_name")"
bundle_dir="${2:-${FAILURE_BUNDLE_OUTPUT_DIR:-}}"
if [[ -z "$bundle_dir" ]]; then
  bundle_dir=".runtime-cache/artifacts/ci/failure-bundles/${safe_job}"
fi

mkdir -p "$bundle_dir"

generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

bundle_index="$bundle_dir/bundle-index.json"
repro_file="$bundle_dir/repro.md"
env_file="$bundle_dir/env.txt"
paths_file="$bundle_dir/paths.txt"
manifest_file=""
tar_file=""
tar_created=false
tar_error=""

repro_cmd="$(bash "${SCRIPT_DIR}/job-repro-command.sh" "$job_name" 2>/dev/null || true)"
if [[ -z "$repro_cmd" ]]; then
  repro_cmd="# Failed to resolve repro command for job: $job_name"
fi

cat >"$repro_file" <<EOF
# CI Failure Reproduction

- generated_at_utc: $generated_at
- job_name: $job_name
- suggested_bundle_dir: $bundle_dir

## Minimal Reproduction Command

\`\`\`bash
$repro_cmd
\`\`\`
EOF

{
  echo "generated_at_utc=$generated_at"
  echo "job_name=$job_name"
  echo "safe_job=$safe_job"
  echo "repo_root=$ROOT_DIR"
  echo "pwd=$(pwd)"
  echo "shell=${SHELL:-unknown}"
  echo "user=${USER:-unknown}"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  echo "os=$(uname -s 2>/dev/null || echo unknown)"
  echo "kernel=$(uname -r 2>/dev/null || echo unknown)"
  echo "git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "git_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo ""
  echo "# Selected environment (CI/toolchain/runtime)"
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    if [[ "$key" == AUTOMATION_* || "$key" =~ (TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL) ]]; then
      echo "${key}=***REDACTED***"
    else
      echo "${key}=${value}"
    fi
  done < <(env | sort | grep -E '^(CI|GITHUB|PNPM|NODE|NPM|PLAYWRIGHT|PYTHON|UV|UIQ|TM_|BASE_URL|AUTOMATION|REPLAY_|MIDSCENE_|RUN_ID|WORKFLOW)=' || true)
} >"$env_file"

runtime_root=".runtime-cache"
runtime_root_exists=false
if [[ -d "$runtime_root" ]]; then
  runtime_root_exists=true
fi

max_tar_mb="${FAILURE_BUNDLE_MAX_TAR_MB:-200}"
if ! [[ "$max_tar_mb" =~ ^[0-9]+$ ]]; then
  max_tar_mb=200
fi
declare -a tar_allowlist=(
  ".runtime-cache/automation"
  ".runtime-cache/logs"
  ".runtime-cache/artifacts"
  ".runtime-cache/reports"
)

declare -a available_paths=()
if [[ -d "$runtime_root" ]]; then
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    available_paths+=("$path")
  done < <(find "$runtime_root" -mindepth 1 -maxdepth 1 | LC_ALL=C sort)
fi

{
  echo "generated_at_utc=$generated_at"
  echo "job_name=$job_name"
  echo "runtime_root=$runtime_root"
  echo "runtime_root_exists=$runtime_root_exists"
  echo ""
  if [[ "$runtime_root_exists" != "true" ]]; then
    echo "(absent) .runtime-cache is missing"
  elif [[ ${#available_paths[@]} -eq 0 ]]; then
    echo "(empty) .runtime-cache exists but has no first-level entries"
  else
    for path in "${available_paths[@]}"; do
      size="$(du -sh "$path" 2>/dev/null | awk '{print $1}' || true)"
      if [[ -z "$size" ]]; then
        size="n/a"
      fi
      if [[ -d "$path" ]]; then
        file_count="$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')"
      else
        file_count="1"
      fi
      printf '%s\tfiles=%s\tsize=%s\n' "$path" "$file_count" "$size"
    done
  fi
} >"$paths_file"

if [[ ${#available_paths[@]} -gt 0 ]]; then
  manifest_file="$bundle_dir/runtime-cache-manifest.txt"
  {
    echo "# Runtime cache subset manifest"
    echo "generated_at_utc=$generated_at"
    echo "job_name=$job_name"
    echo ""
    for path in "${available_paths[@]}"; do
      kind="file"
      if [[ -d "$path" ]]; then
        kind="dir"
      fi
      size="$(du -sh "$path" 2>/dev/null | awk '{print $1}' || true)"
      if [[ -z "$size" ]]; then
        size="n/a"
      fi
      echo "$path | kind=$kind | size=$size"
    done
  } >"$manifest_file"
fi

subset_count="${#available_paths[@]}"
declare -a tar_candidates=()
for candidate in "${tar_allowlist[@]}"; do
  if [[ -e "$candidate" ]]; then
    tar_candidates+=("$candidate")
  fi
done

bundle_dir_rel=""
if [[ "$bundle_dir" == /* ]]; then
  if [[ "$bundle_dir" == "$ROOT_DIR/"* ]]; then
    bundle_dir_rel="${bundle_dir#"$ROOT_DIR/"}"
  fi
else
  bundle_dir_rel="${bundle_dir#./}"
fi

declare -a tar_excludes=(
  ".runtime-cache/artifacts/ci/failure-bundles"
  ".runtime-cache/artifacts/ci/failure-bundles/*"
)
if [[ -n "$bundle_dir_rel" ]]; then
  tar_excludes+=("$bundle_dir_rel")
  tar_excludes+=("$bundle_dir_rel/*")
fi

tar_reason=""
if [[ ${#tar_candidates[@]} -eq 0 ]]; then
  tar_reason="no_allowlisted_runtime_paths"
elif [[ -n "$tar_error" ]]; then
  tar_reason="$tar_error"
fi

if [[ ${#tar_candidates[@]} -gt 0 ]] && [[ -z "$tar_reason" ]]; then
  total_tar_mb=0
  for candidate in "${tar_candidates[@]}"; do
    size_mb="$(du -sm "$candidate" 2>/dev/null | awk '{print $1}' || true)"
    if [[ -z "$size_mb" ]]; then
      size_mb=0
    fi
    total_tar_mb=$((total_tar_mb + size_mb))
  done
  if [[ "$total_tar_mb" -gt "$max_tar_mb" ]]; then
    tar_reason="tar_size_exceeds_limit:${total_tar_mb}MB>${max_tar_mb}MB"
  fi
fi

if [[ ${#tar_candidates[@]} -gt 0 ]] && [[ -z "$tar_reason" ]] && command -v tar >/dev/null 2>&1; then
  tar_file="$bundle_dir/runtime-cache-subsets.tar.gz"
  declare -a tar_args=(-czf "$tar_file")
  for exclude_pattern in "${tar_excludes[@]}"; do
    tar_args+=(--exclude="$exclude_pattern")
  done
  tar_args+=("${tar_candidates[@]}")

  if tar "${tar_args[@]}" >/dev/null 2>&1; then
    tar_created=true
  else
    tar_error="tar command failed"
    tar_reason="$tar_error"
    rm -f "$tar_file"
    tar_file=""
  fi
elif [[ ${#tar_candidates[@]} -gt 0 ]] && [[ -z "$tar_reason" ]]; then
  tar_reason="tar command not available"
fi

run_id="${GITHUB_RUN_ID:-}"
run_attempt="${GITHUB_RUN_ATTEMPT:-}"
git_sha="${GITHUB_SHA:-}"
workflow_name="${GITHUB_WORKFLOW:-}"
event_name="${GITHUB_EVENT_NAME:-}"
run_result="${FAILURE_BUNDLE_RESULT:-unknown}"
bundle_index_escaped="$(json_escape "$bundle_index")"

{
  echo "{"
  echo "  \"generated_at_utc\": \"$(json_escape "$generated_at")\","
  echo "  \"job_name\": \"$(json_escape "$job_name")\","
  echo "  \"safe_job\": \"$(json_escape "$safe_job")\","
  echo "  \"run_id\": $(json_str_or_null "$run_id"),"
  echo "  \"run_attempt\": $(json_str_or_null "$run_attempt"),"
  echo "  \"git_sha\": $(json_str_or_null "$git_sha"),"
  echo "  \"workflow\": $(json_str_or_null "$workflow_name"),"
  echo "  \"event_name\": $(json_str_or_null "$event_name"),"
  echo "  \"run_result\": $(json_str_or_null "$run_result"),"
  echo "  \"bundle_dir\": \"$(json_escape "$bundle_dir")\","
  echo "  \"files\": {"
  echo "    \"bundle_index\": \"$bundle_index_escaped\","
  echo "    \"repro\": \"$(json_escape "$repro_file")\","
  echo "    \"env\": \"$(json_escape "$env_file")\","
  echo "    \"paths\": \"$(json_escape "$paths_file")\""
  echo "  },"
  echo "  \"runtime_cache\": {"
  echo "    \"root\": \".runtime-cache\","
  echo "    \"root_exists\": $runtime_root_exists,"
  echo "    \"subset_count\": $subset_count,"
  echo "    \"manifest\": $(json_str_or_null "$manifest_file"),"
  echo "    \"tar_candidates\": ["
  for idx in "${!tar_candidates[@]}"; do
    comma=","
    if [[ "$idx" -eq $((${#tar_candidates[@]} - 1)) ]]; then
      comma=""
    fi
    echo "      \"$(json_escape "${tar_candidates[$idx]}")\"${comma}"
  done
  echo "    ],"
  echo "    \"tar_max_mb\": $max_tar_mb,"
  echo "    \"tar\": $(json_str_or_null "$tar_file"),"
  echo "    \"tar_created\": $tar_created,"
  echo "    \"tar_error\": $(json_str_or_null "$tar_error"),"
  echo "    \"tar_reason\": $(json_str_or_null "$tar_reason")"
  echo "  }"
  echo "}"
} >"$bundle_index"

printf 'bundle_dir=%s\n' "$bundle_dir"
printf 'bundle_index=%s\n' "$bundle_index"
printf 'repro=%s\n' "$repro_file"
printf 'env=%s\n' "$env_file"
printf 'paths=%s\n' "$paths_file"
if [[ -n "$manifest_file" ]]; then
  printf 'manifest=%s\n' "$manifest_file"
fi
if [[ -n "$tar_file" ]]; then
  printf 'tar=%s\n' "$tar_file"
fi
