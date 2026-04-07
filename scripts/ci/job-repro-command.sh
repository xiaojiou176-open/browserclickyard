#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/ci/job-repro-command.sh <job-name>

Print a minimal local reproduction command for a CI job.
USAGE
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_job_name() {
  local raw
  raw="$(trim "$1")"
  case "$raw" in
    *" / "*) raw="${raw##* / }" ;;
  esac
  printf '%s' "$raw"
}

emit_default() {
  local job_name="$1"
  cat <<GUIDE
# Unknown CI job: ${job_name}
# Try one of: backend core_contract_load external_tooling_precheck mcp_tests orchestrator_tests
#             harness_web_typecheck harness_web_unit harness_web_ct harness_web_e2e harness_web_gate
#             frontend automation required_ci_gate nightly-gate
# Guidance: inspect .github/workflows/ci.yml (or nightly.yml), then run the matching local gate command.
GUIDE
}

job_raw="${1:-}"
if [[ -z "$job_raw" ]]; then
  usage >&2
  exit 2
fi

job_name="$(normalize_job_name "$job_raw")"

case "$job_name" in
  backend)
    cat <<'CMD'
python -m pip install --upgrade pip uv && bash scripts/lib/python-exec.sh sync && cd services/api && ../../scripts/lib/python-exec.sh ruff check . && ../../scripts/lib/python-exec.sh pytest && cd ../.. && bash scripts/check-db-migrations.sh
CMD
    ;;
  core_contract_load)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm contracts:check-openapi-coverage && pnpm audit:prod && pnpm audit:tooling && ./scripts/run-contract-scan.sh && ./scripts/run-load-k6-smoke.sh
CMD
    ;;
  external_tooling_precheck)
    cat <<'CMD'
python -m pip install --upgrade pip uv && bash scripts/lib/python-exec.sh sync && pnpm install --frozen-lockfile && printf '%s\n' '{"log":{"entries":[{"request":{"url":"http://127.0.0.1:8080/health","method":"GET"},"response":{"status":200}}]}}' > /tmp/uiq-har-smoke.har && pnpm run automation:convert:curl -- --curl "curl http://127.0.0.1:8080/health" -- --language python && pnpm run automation:har:k6 -- --input /tmp/uiq-har-smoke.har -- --stdout && pnpm run test:schemathesis -- --help
CMD
    ;;
  mcp_tests)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm mcp:smoke && pnpm mcp:test
CMD
    ;;
  orchestrator_tests)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm test:orchestrator
CMD
    ;;
  harness_web_typecheck)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm typecheck
CMD
    ;;
  harness_web_unit)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm test:unit
CMD
    ;;
  harness_web_ct)
    cat <<'CMD'
pnpm install --frozen-lockfile && bash scripts/lib/node-bin.sh playwright install --with-deps chromium && pnpm test:ct
CMD
    ;;
  harness_web_e2e)
    cat <<'CMD'
pnpm install --frozen-lockfile && bash scripts/lib/node-bin.sh playwright install --with-deps chromium && pnpm test:e2e
CMD
    ;;
  harness_web_gate)
    cat <<'CMD'
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:unit && bash scripts/lib/node-bin.sh playwright install --with-deps chromium && pnpm test:ct && pnpm test:e2e
CMD
    ;;
  frontend)
    cat <<'CMD'
cd apps/command-center && pnpm install --frozen-lockfile && pnpm lint && pnpm audit --audit-level=high && pnpm test && pnpm build && pnpm exec playwright install --with-deps chromium && pnpm audit:ui
CMD
    ;;
  automation)
    cat <<'CMD'
python -m pip install --upgrade pip uv && bash scripts/lib/python-exec.sh sync && cd tooling/automation && pnpm install --frozen-lockfile && pnpm lint && pnpm audit --audit-level=high && pnpm check && pnpm test
CMD
    ;;
  required_ci_gate|required-ci-gate)
    cat <<'CMD'
bash scripts/ci/job-repro-command.sh <failed-upstream-job>
CMD
    ;;
  nightly-gate|nightly_gate)
    cat <<'CMD'
pnpm install --frozen-lockfile && python -m pip install --upgrade pip uv && bash scripts/lib/python-exec.sh sync && (cd tooling/automation && pnpm install --frozen-lockfile) && bash scripts/lib/node-bin.sh playwright install --with-deps chromium && pnpm uiq run --profile nightly --target web.ci && MIDSCENE_STRICT=false MIDSCENE_ALLOW_FALLBACK=true REPLAY_PASSWORD="${REPLAY_PASSWORD:?set a non-production replay password}" bash scripts/run-pipeline.sh midscene full
CMD
    ;;
  *)
    emit_default "$job_name"
    ;;
esac
