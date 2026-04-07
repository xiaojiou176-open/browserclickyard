set shell := ["bash", "-euo", "pipefail", "-c"]

setup:
    ./scripts/setup.sh

script-pipeline-full:
    ./scripts/run-pipeline.sh manual

script-pipeline-full-midscene:
    ./scripts/run-pipeline.sh midscene

script-pipeline-capture:
    ./scripts/run-pipeline.sh manual ui-only

script-pipeline-capture-midscene:
    ./scripts/run-pipeline.sh midscene ui-only

clean:
    mkdir -p .runtime-cache/temp
    find .runtime-cache/temp -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    find . -type d -name "__pycache__" -prune -exec rm -rf {} +
    find . -type f -name "*.pyc" -delete

map:
    tree -I '.git|.runtime-cache|__pycache__|dist' -L 4 > .codex/repo-map.tree

diagnose:
    @echo "Checking for files > 500 lines"
    @find services/api apps/command-center -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} + | awk '$1 > 500 { print }'

dev-backend:
    zsh -lc 'p=${TM_BACKEND_PORT:-17380}; while lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; do p=$((p+1)); done; echo "backend on :$p"; ./scripts/lib/python-exec.sh uvicorn app.main:app --reload --port $p'

dev-up:
    ./scripts/dev-up.sh

dev-down:
    ./scripts/dev-down.sh

dev-status:
    ./scripts/dev-status.sh

dev-frontend:
    cd apps/command-center && pnpm dev

lint-frontend:
    cd apps/command-center && pnpm lint

automation-install:
    cd tooling/automation && pnpm install

automation-lint:
    cd tooling/automation && pnpm lint

automation-record:
    cd tooling/automation && pnpm record

automation-record-manual:
    cd tooling/automation && pnpm record:manual

automation-record-midscene:
    cd tooling/automation && pnpm record:midscene

automation-extract:
    cd tooling/automation && pnpm extract

automation-generate-case:
    cd tooling/automation && pnpm generate-case

automation-replay:
    cd tooling/automation && pnpm replay

run-register-flow mode="manual" flow="ui-only":
    ./scripts/run-register-flow.sh "{{mode}}" "{{flow}}"

train-and-auto-replay:
    ./scripts/train-and-auto-replay.sh

automation-test:
    cd tooling/automation && pnpm test

backup-runtime:
    ./scripts/backup-runtime.sh

rollback-runtime backup_file:
    ./scripts/rollback-runtime.sh "{{backup_file}}"

compose-up:
    docker compose up -d --build

compose-down:
    docker compose down

preflight:
    ./scripts/preflight.sh

security-scan:
    ./scripts/security-scan.sh
