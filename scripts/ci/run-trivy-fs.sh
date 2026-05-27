#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

LOCAL_TRIVY_BIN="${UIQ_TRIVY_BIN:-$ROOT_DIR/.runtime-cache/bin/trivy}"
TRIVY_IMAGE="${UIQ_TRIVY_IMAGE:-docker.io/aquasec/trivy:0.66.0}"

declare -a TRIVY_CMD=()
if command -v trivy >/dev/null 2>&1; then
  TRIVY_CMD=(trivy)
elif [[ -x "$LOCAL_TRIVY_BIN" ]]; then
  export PATH="$(dirname "$LOCAL_TRIVY_BIN"):$PATH"
  TRIVY_CMD=(trivy)
elif command -v docker >/dev/null 2>&1; then
  TRIVY_CMD=(
    docker run --rm
    --user "$(id -u):$(id -g)"
    -v "$ROOT_DIR:/work"
    -w /work
    "$TRIVY_IMAGE"
  )
  echo "[trivy] INFO: local trivy missing, falling back to Docker image ${TRIVY_IMAGE}"
else
  echo "[trivy] FAIL: trivy is not installed, no repo-local binary was found, and Docker is unavailable. Install trivy, place a repo-local binary at .runtime-cache/bin/trivy, or use the CI workflows that wire aquasecurity/setup-trivy." >&2
  exit 127
fi

if [[ "${#TRIVY_CMD[@]}" -eq 0 ]]; then
  if [[ -x "$LOCAL_TRIVY_BIN" ]]; then
    export PATH="$(dirname "$LOCAL_TRIVY_BIN"):$PATH"
  else
    echo "[trivy] FAIL: trivy is not installed. Install it first, place a repo-local binary at .runtime-cache/bin/trivy, or use the CI workflows that wire aquasecurity/setup-trivy." >&2
    exit 127
  fi
fi

REPORT_DIR="${UIQ_TRIVY_REPORT_DIR:-.runtime-cache/artifacts/ci}"
FORMAT="${UIQ_TRIVY_FORMAT:-table}"
OUTPUT_PATH="${UIQ_TRIVY_OUTPUT_PATH:-${REPORT_DIR}/trivy-results.${FORMAT}}"
SEVERITY="${UIQ_TRIVY_SEVERITY:-HIGH,CRITICAL}"
SCANNERS="${UIQ_TRIVY_SCANNERS:-vuln,misconfig,secret}"
CACHE_DIR="${UIQ_TRIVY_CACHE_DIR:-.runtime-cache/cache/trivy}"

mkdir -p "$REPORT_DIR" "$CACHE_DIR"

declare -a TRIVY_ARGS=(
  fs
  --scanners "$SCANNERS"
  --severity "$SEVERITY"
  --cache-dir "$CACHE_DIR"
  --skip-dirs .git
  --skip-dirs node_modules
  --skip-dirs .runtime-cache
  --skip-dirs dist
  --skip-dirs build
  --no-progress
  --exit-code 1
)

if [[ "${UIQ_TRIVY_IGNORE_UNFIXED:-1}" == "1" ]]; then
  TRIVY_ARGS+=(--ignore-unfixed)
fi

case "$FORMAT" in
  sarif)
    TRIVY_ARGS+=(--format sarif --output "$OUTPUT_PATH")
    ;;
  json)
    TRIVY_ARGS+=(--format json --output "$OUTPUT_PATH")
    ;;
  table)
    TRIVY_ARGS+=(--format table --output "$OUTPUT_PATH")
    ;;
  *)
    echo "[trivy] FAIL: unsupported format '$FORMAT'." >&2
    exit 2
    ;;
esac

TRIVY_ARGS+=(.)

echo "[trivy] START format=${FORMAT} severity=${SEVERITY} scanners=${SCANNERS}"
"${TRIVY_CMD[@]}" "${TRIVY_ARGS[@]}"
echo "[trivy] PASS output=${OUTPUT_PATH}"
