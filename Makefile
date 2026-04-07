.PHONY: setup script-pipeline-full script-pipeline-full-midscene script-pipeline-capture script-pipeline-capture-midscene clean map diagnose dev-up dev-down dev-status preflight security-scan

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
	tree -I 'node_modules|.git|.runtime-cache|__pycache__|.venv|dist' -L 4 > .codex/repo-map.tree

diagnose:
	@echo "Checking for files > 500 lines"
	@find services/api apps/command-center -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} + | awk '$$1 > 500 { print }'

dev-up:
	./scripts/dev-up.sh

dev-down:
	./scripts/dev-down.sh

dev-status:
	./scripts/dev-status.sh

preflight:
	./scripts/preflight.sh

security-scan:
	./scripts/security-scan.sh
