from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CommandSpec:
    command_id: str
    title: str
    description: str
    argv: list[str]
    tags: list[str]


# Commands explicitly allowed from remote automation APIs.
# High-risk commands are intentionally excluded and must return 403.
SAFE_AUTOMATION_COMMANDS: frozenset[str] = frozenset(
    {
        "script-pipeline-full",
        "script-pipeline-full-midscene",
        "script-pipeline-capture",
        "script-pipeline-capture-midscene",
        "lint-frontend",
        "automation-lint",
        "automation-extract",
        "automation-extract-video",
        "automation-generate-case",
        "automation-generate-reconstruction",
        "automation-replay",
        "automation-reconstruct-and-replay",
        "automation-replay-flow",
        "automation-replay-flow-step",
        "automation-test",
        "backend-test",
    }
)

# Commands rejected from remote automation APIs because they can mutate local
# development environment, delete data, or keep long-running local processes.
HIGH_RISK_AUTOMATION_COMMANDS: frozenset[str] = frozenset(
    {
        "setup",
        "clean",
        "map",
        "diagnose",
        "dev-frontend",
        "automation-install",
        "automation-record",
        "automation-record-manual",
        "automation-record-midscene",
    }
)


def is_safe_automation_command(command_id: str) -> bool:
    return command_id in SAFE_AUTOMATION_COMMANDS


def is_high_risk_automation_command(command_id: str) -> bool:
    return command_id in HIGH_RISK_AUTOMATION_COMMANDS


def build_command_specs() -> dict[str, CommandSpec]:
    return {
        "setup": CommandSpec(
            command_id="setup",
            title="Initialize local environment",
            description="Prepare the local runtime environment in one step via scripts/setup.sh.",
            argv=["./scripts/setup.sh"],
            tags=["init", "env"],
        ),
        "script-pipeline-full": CommandSpec(
            command_id="script-pipeline-full",
            title="Script pipeline: full replay (manual capture)",
            description=(
                "Run ./scripts/run-pipeline.sh manual full. "
                "This is the script-pipeline lane for record/extract/generate/replay, "
                "not the workflow /api/runs lane and not the governed pnpm uiq run lane."
            ),
            argv=["./scripts/run-pipeline.sh", "manual"],
            tags=["pipeline", "script-lane", "manual", "full"],
        ),
        "script-pipeline-full-midscene": CommandSpec(
            command_id="script-pipeline-full-midscene",
            title="Script pipeline: full replay (visual AI capture)",
            description=(
                "Run ./scripts/run-pipeline.sh midscene full. "
                "This is the script-pipeline lane with AI-assisted capture, "
                "not the workflow /api/runs lane and not the governed pnpm uiq run lane."
            ),
            argv=["./scripts/run-pipeline.sh", "midscene"],
            tags=["pipeline", "script-lane", "ai", "full"],
        ),
        "script-pipeline-capture": CommandSpec(
            command_id="script-pipeline-capture",
            title="Script pipeline: capture only (manual)",
            description=(
                "Run ./scripts/run-pipeline.sh manual ui-only. "
                "This lane records the browser flow and skips replay. "
                "It is not the workflow /api/runs lane and not the governed pnpm uiq run lane."
            ),
            argv=["./scripts/run-pipeline.sh", "manual", "ui-only"],
            tags=["pipeline", "script-lane", "manual", "capture-only"],
        ),
        "script-pipeline-capture-midscene": CommandSpec(
            command_id="script-pipeline-capture-midscene",
            title="Script pipeline: capture only (visual AI)",
            description=(
                "Run ./scripts/run-pipeline.sh midscene ui-only. "
                "This lane records the browser flow with AI-assisted capture and skips replay. "
                "It is not the workflow /api/runs lane and not the governed pnpm uiq run lane."
            ),
            argv=["./scripts/run-pipeline.sh", "midscene", "ui-only"],
            tags=["pipeline", "script-lane", "ai", "capture-only"],
        ),
        "clean": CommandSpec(
            command_id="clean",
            title="Clean temporary files",
            description="Remove runtime cache leftovers and Python bytecode artifacts.",
            argv=[
                "zsh",
                "-lc",
                "mkdir -p .runtime-cache/temp && find .runtime-cache/temp -mindepth 1 -maxdepth 1 -exec rm -rf {} + && find . -type d -name '__pycache__' -prune -exec rm -rf {} + && find . -type f -name '*.pyc' -delete",
            ],
            tags=["maintenance"],
        ),
        "map": CommandSpec(
            command_id="map",
            title="Refresh repository structure map",
            description="Regenerate the repository tree map at .codex/repo-map.tree.",
            argv=[
                "zsh",
                "-lc",
                "tree -I '.git|.runtime-cache|__pycache__|dist' -L 4 > .codex/repo-map.tree",
            ],
            tags=["maintenance"],
        ),
        "diagnose": CommandSpec(
            command_id="diagnose",
            title="Diagnose large files",
            description="Scan services/api and apps/command-center for Python or TypeScript files over 500 lines.",
            argv=[
                "zsh",
                "-lc",
                "echo 'Checking for files > 500 lines' && find services/api apps/command-center -type f \\( -name '*.py' -o -name '*.ts' -o -name '*.tsx' \\) -exec wc -l {} + | awk '$1 > 500 { print }'",
            ],
            tags=["maintenance", "diagnose"],
        ),
        "dev-frontend": CommandSpec(
            command_id="dev-frontend",
            title="Start frontend preview server",
            description="Start the frontend development server as a long-running local process.",
            argv=["zsh", "-lc", "cd apps/command-center && pnpm dev"],
            tags=["frontend", "dev", "long-running"],
        ),
        "lint-frontend": CommandSpec(
            command_id="lint-frontend",
            title="Lint frontend code",
            description="Run the frontend ESLint checks.",
            argv=["zsh", "-lc", "cd apps/command-center && pnpm lint"],
            tags=["frontend", "lint"],
        ),
        "automation-install": CommandSpec(
            command_id="automation-install",
            title="Install automation dependencies",
            description="Install runtime dependencies for the automation workspace.",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm install"],
            tags=["automation", "install"],
        ),
        "automation-lint": CommandSpec(
            command_id="automation-lint",
            title="Lint automation code",
            description="Run the automation workspace ESLint checks.",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm lint"],
            tags=["automation", "lint"],
        ),
        "automation-record": CommandSpec(
            command_id="automation-record",
            title="Start recording (default mode)",
            description="Run the default recording command (pnpm record).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm record"],
            tags=["automation", "record"],
        ),
        "automation-record-manual": CommandSpec(
            command_id="automation-record-manual",
            title="Start recording (manual mode)",
            description="Run the manual recording command (pnpm record:manual).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm record:manual"],
            tags=["automation", "record", "manual"],
        ),
        "automation-record-midscene": CommandSpec(
            command_id="automation-record-midscene",
            title="Start recording (visual AI mode)",
            description="Run the visual AI recording command (pnpm record:midscene).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm record:midscene"],
            tags=["automation", "record", "ai"],
        ),
        "automation-extract": CommandSpec(
            command_id="automation-extract",
            title="Extract flow specification",
            description="Extract the flow and generate flow_request.spec.json.",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm extract"],
            tags=["automation", "extract"],
        ),
        "automation-extract-video": CommandSpec(
            command_id="automation-extract-video",
            title="Extract video step candidates",
            description="Run the video step extraction command (pnpm extract:video).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm extract:video"],
            tags=["automation", "extract", "video"],
        ),
        "automation-generate-case": CommandSpec(
            command_id="automation-generate-case",
            title="Generate test case",
            description="Run the test case generation command (pnpm generate-case).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm generate-case"],
            tags=["automation", "generate"],
        ),
        "automation-generate-reconstruction": CommandSpec(
            command_id="automation-generate-reconstruction",
            title="Generate reconstruction artifacts",
            description="Run the reconstruction artifact generation command (pnpm generate:reconstruction).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm generate:reconstruction"],
            tags=["automation", "generate", "reconstruction"],
        ),
        "automation-replay": CommandSpec(
            command_id="automation-replay",
            title="Replay registration flow",
            description="Run the flow replay command (pnpm replay).",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm replay"],
            tags=["automation", "replay"],
        ),
        "automation-reconstruct-and-replay": CommandSpec(
            command_id="automation-reconstruct-and-replay",
            title="Reconstruct and replay",
            description="Reconstruct the flow first and then replay it automatically.",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm reconstruct-and-replay"],
            tags=["automation", "reconstruction", "replay"],
        ),
        "automation-replay-flow": CommandSpec(
            command_id="automation-replay-flow",
            title="Workflow lane: replay latest flow draft",
            description=(
                "Replay the latest saved flow draft for the workflow /api/runs and command-tower lane. "
                "This is a workflow-backed replay task, not the governed pnpm uiq run lane."
            ),
            argv=["zsh", "-lc", "cd tooling/automation && pnpm replay-flow"],
            tags=["automation", "workflow-run", "replay", "flow"],
        ),
        "automation-replay-flow-step": CommandSpec(
            command_id="automation-replay-flow-step",
            title="Workflow lane: replay one flow step",
            description=(
                "Replay the latest saved flow draft one step at a time by step ID. "
                "This belongs to the workflow /api/runs and command-tower lane, "
                "not the governed pnpm uiq run lane."
            ),
            argv=["zsh", "-lc", "cd tooling/automation && pnpm replay-flow-step"],
            tags=["automation", "workflow-run", "replay", "flow", "step"],
        ),
        "automation-test": CommandSpec(
            command_id="automation-test",
            title="Run automation tests",
            description="Run the browser automation test suite with Playwright.",
            argv=["zsh", "-lc", "cd tooling/automation && pnpm test"],
            tags=["automation", "test"],
        ),
        "backend-test": CommandSpec(
            command_id="backend-test",
            title="Run backend tests",
            description="Run the backend pytest suite.",
            argv=["uv", "run", "--extra", "dev", "pytest"],
            tags=["backend", "test"],
        ),
    }
