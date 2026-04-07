from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
NIGHTLY_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/nightly.yml"
CI_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/ci.yml"
PR_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/pr.yml"
NIGHTLY_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/nightly.yml"
WEEKLY_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/weekly.yml"
DESKTOP_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/desktop-smoke.yml"
LIVE_REALISM_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/live-realism.yml"
RELEASE_CANDIDATE_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/release-candidate.yml"
RUNTIME_GC_WEEKLY_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/runtime-gc-weekly.yml"
SYSTEM_AUDIT_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/system-audit.yml"
UPSTREAM_DRIFT_AUDIT_WORKFLOW_PATH = REPO_ROOT / ".github/workflows/upstream-drift-audit.yml"
JOB_REPRO_SCRIPT_PATH = REPO_ROOT / "scripts/ci/job-repro-command.sh"
FAILURE_BUNDLE_SCRIPT_PATH = REPO_ROOT / "scripts/ci/make-failure-bundle.sh"
CI_GOVERNANCE_REFERENCE_PATH = REPO_ROOT / "docs/reference/ci-governance.md"


def _workflow_text() -> str:
    return NIGHTLY_WORKFLOW_PATH.read_text(encoding="utf-8")


def _workflow_text_from(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _all_self_hosted_workflow_paths() -> tuple[Path, ...]:
    return (
        CI_WORKFLOW_PATH,
        PR_WORKFLOW_PATH,
        NIGHTLY_WORKFLOW_PATH,
        WEEKLY_WORKFLOW_PATH,
        DESKTOP_WORKFLOW_PATH,
        LIVE_REALISM_WORKFLOW_PATH,
        RELEASE_CANDIDATE_WORKFLOW_PATH,
        RUNTIME_GC_WEEKLY_WORKFLOW_PATH,
        SYSTEM_AUDIT_WORKFLOW_PATH,
        UPSTREAM_DRIFT_AUDIT_WORKFLOW_PATH,
    )


def _step_block_from(path: Path, step_name: str) -> str:
    text = _workflow_text_from(path)
    marker = f"      - name: {step_name}\n"
    start = text.find(marker)
    assert start != -1, f"step not found: {step_name}"
    next_step = text.find("\n      - name: ", start + len(marker))
    if next_step == -1:
        return text[start:]
    return text[start:next_step]


def _step_block(step_name: str) -> str:
    return _step_block_from(NIGHTLY_WORKFLOW_PATH, step_name)


def _extract_heredoc_python_blocks(step_block: str) -> list[str]:
    blocks: list[str] = []
    marker = "python - <<'PY'\n"
    cursor = 0
    while True:
        start = step_block.find(marker, cursor)
        if start == -1:
            return blocks
        body_start = start + len(marker)
        end = step_block.find("\n          PY", body_start)
        assert end != -1, "unterminated python heredoc block"
        blocks.append(textwrap.dedent(step_block[body_start:end]))
        cursor = end + 1


def _extract_run_script(step_block: str) -> str:
    lines = step_block.splitlines()
    run_index = -1
    for idx, line in enumerate(lines):
        if line.strip() == "run: |":
            run_index = idx
            break
    assert run_index != -1, "run: | block not found"

    script_lines: list[str] = []
    for line in lines[run_index + 1 :]:
        if not line.startswith("          "):
            break
        script_lines.append(line[10:])
    return "\n".join(script_lines) + "\n"


def _require_script(path: Path) -> None:
    assert path.exists(), f"missing script in this checkout: {path}"


def test_job_repro_command_script_usage_error() -> None:
    _require_script(JOB_REPRO_SCRIPT_PATH)
    result = subprocess.run(
        ["bash", str(JOB_REPRO_SCRIPT_PATH)],
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 2
    assert "Usage: scripts/ci/job-repro-command.sh <job-name>" in result.stderr


def test_job_repro_command_script_normalize_and_mapping() -> None:
    _require_script(JOB_REPRO_SCRIPT_PATH)
    backend = subprocess.run(
        ["bash", str(JOB_REPRO_SCRIPT_PATH), "backend"],
        check=True,
        text=True,
        capture_output=True,
    )
    assert "scripts/lib/python-exec.sh pytest" in backend.stdout
    assert "scripts/check-db-migrations.sh" in backend.stdout

    normalized = subprocess.run(
        ["bash", str(JOB_REPRO_SCRIPT_PATH), "CI / harness_web_ct"],
        check=True,
        text=True,
        capture_output=True,
    )
    assert "pnpm test:ct" in normalized.stdout

    unknown = subprocess.run(
        ["bash", str(JOB_REPRO_SCRIPT_PATH), "unknown-job"],
        check=True,
        text=True,
        capture_output=True,
    )
    assert "# Unknown CI job: unknown-job" in unknown.stdout
    assert ".github/workflows/ci.yml" in unknown.stdout


def test_make_failure_bundle_script_usage_and_outputs(tmp_path: Path) -> None:
    _require_script(FAILURE_BUNDLE_SCRIPT_PATH)
    shadow_repo = tmp_path / "repo"
    shadow_ci = shadow_repo / "scripts/ci"
    shadow_ci.mkdir(parents=True, exist_ok=True)
    shadow_job_repro = shadow_ci / "job-repro-command.sh"
    shadow_bundle = shadow_ci / "make-failure-bundle.sh"
    shutil.copy2(JOB_REPRO_SCRIPT_PATH, shadow_job_repro)
    shutil.copy2(FAILURE_BUNDLE_SCRIPT_PATH, shadow_bundle)
    shadow_job_repro.chmod(0o644)
    shadow_bundle.chmod(0o755)

    usage = subprocess.run(
        ["bash", str(shadow_bundle)],
        check=False,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "FAILURE_BUNDLE_JOB": "",
            "CI_JOB_NAME": "",
            "GITHUB_JOB": "",
        },
    )
    assert usage.returncode == 2
    assert "Usage: scripts/ci/make-failure-bundle.sh <job-name> [output-dir]" in usage.stderr

    out_dir = tmp_path / "bundle-out"
    run = subprocess.run(
        ["bash", str(shadow_bundle), "nightly-gate", str(out_dir)],
        check=True,
        text=True,
        capture_output=True,
    )
    assert f"bundle_dir={out_dir}" in run.stdout
    assert f"bundle_index={out_dir / 'bundle-index.json'}" in run.stdout

    bundle_index = out_dir / "bundle-index.json"
    repro = out_dir / "repro.md"
    env_file = out_dir / "env.txt"
    paths_file = out_dir / "paths.txt"
    assert bundle_index.exists()
    assert repro.exists()
    assert env_file.exists()
    assert paths_file.exists()

    payload = json.loads(bundle_index.read_text(encoding="utf-8"))
    assert payload["job_name"] == "nightly-gate"
    assert payload["safe_job"] == "nightly-gate"
    assert payload["bundle_dir"] == str(out_dir)
    assert payload["files"]["repro"] == str(repro)
    assert payload["files"]["env"] == str(env_file)
    assert payload["files"]["paths"] == str(paths_file)
    assert payload["runtime_cache"]["root_exists"] is False
    assert payload["runtime_cache"]["subset_count"] == 0
    assert payload["runtime_cache"]["manifest"] is None
    assert payload["runtime_cache"]["tar"] is None
    assert isinstance(payload["runtime_cache"]["tar_created"], bool)

    repro_text = repro.read_text(encoding="utf-8")
    assert "Minimal Reproduction Command" in repro_text
    assert "pnpm uiq run --profile nightly --target web.ci" in repro_text


def test_nightly_workflow_strict_fallback_and_bundle_paths() -> None:
    text = _workflow_text()
    assert "pnpm uiq run --profile nightly --target web.ci" in text
    assert ".runtime-cache/artifacts/runs/" in text

    nightly_run = _step_block("Run Nightly Profile")
    assert "pnpm uiq run --profile nightly --target web.ci" in nightly_run

    status_step = _step_block("Write nightly fallback status evidence")
    assert "PRIMARY_OUTCOME" in status_step
    assert "FALLBACK_OUTCOME" in status_step
    assert "nightly-fallback-status.json" in status_step

    upload = _step_block("Upload Artifacts")
    assert ".runtime-cache/artifacts/ci/" in upload
    assert ".runtime-cache/artifacts/perf/" in upload
    assert ".runtime-cache/artifacts/api/" in upload

    failure_build = _step_block("Build failure bundle")
    assert "if: ${{ failure() || cancelled() }}" in failure_build
    assert "bash scripts/ci/make-failure-bundle.sh || true" in failure_build
    failure_upload = _step_block("Upload failure bundle artifact")
    assert "if: ${{ failure() || cancelled() }}" in failure_upload
    assert ".runtime-cache/artifacts/ci/failure-bundles/" in failure_upload


def test_self_hosted_workflows_do_not_write_tool_caches_into_workspace() -> None:
    forbidden_tokens = (
        "PRE_COMMIT_HOME: ${{ github.workspace }}",
        "path: ~/.cache/pre-commit",
        "path: ~/.cache/ms-playwright",
        'uv_cache="${{ github.workspace }}',
        'pip_cache="${{ github.workspace }}',
        'browser_cache="${{ github.workspace }}',
        "PRE_COMMIT_HOME: ~/.cache/pre-commit",
    )
    required_tokens = (
        "PRE_COMMIT_HOME: ${{ runner.temp }}/uiq-pre-commit/",
        'store_path="${RUNNER_TEMP}/uiq-pnpm-store"',
        'uv_cache="${RUNNER_TEMP}/uiq-python-cache/uv"',
        'pip_cache="${RUNNER_TEMP}/uiq-python-cache/pip"',
        'browser_cache="${RUNNER_TEMP}/uiq-ms-playwright/',
    )

    texts = {
        str(path.relative_to(REPO_ROOT)): _workflow_text_from(path)
        for path in _all_self_hosted_workflow_paths()
    }
    texts[".github/actions/setup-python-smart/action.yml"] = (
        REPO_ROOT / ".github/actions/setup-python-smart/action.yml"
    ).read_text(encoding="utf-8")
    texts[".github/actions/setup-node-pnpm/action.yml"] = (
        REPO_ROOT / ".github/actions/setup-node-pnpm/action.yml"
    ).read_text(encoding="utf-8")
    texts[".github/actions/setup-playwright/action.yml"] = (
        REPO_ROOT / ".github/actions/setup-playwright/action.yml"
    ).read_text(encoding="utf-8")

    for rel_path, text in texts.items():
        for token in forbidden_tokens:
            assert token not in text, f"{rel_path} still writes tool cache into workspace: {token}"

    ci_text = texts[str(CI_WORKFLOW_PATH.relative_to(REPO_ROOT))]
    assert required_tokens[0] in ci_text
    assert required_tokens[1] in texts[".github/actions/setup-node-pnpm/action.yml"]
    assert required_tokens[2] in texts[".github/actions/setup-python-smart/action.yml"]
    assert required_tokens[3] in texts[".github/actions/setup-python-smart/action.yml"]
    assert required_tokens[4] in texts[".github/actions/setup-playwright/action.yml"]


def test_automation_backend_job_records_pid_and_cleans_up() -> None:
    ci_text = _workflow_text_from(CI_WORKFLOW_PATH)
    governance_text = _workflow_text_from(CI_GOVERNANCE_REFERENCE_PATH)
    assert "| ci | `.github/workflows/ci.yml` | `required_ci_gate` | 1 | `ci-quick-gate` |" in governance_text
    assert "printf '%s\\n' \"$backend_pid\" > .runtime-cache/automation/backend.pid" not in ci_text
    assert "- name: Cleanup automation backend" not in ci_text
    assert 'pid_file=".runtime-cache/automation/backend.pid"' not in ci_text
    assert "- name: Fast matrix" in ci_text


def test_self_hosted_workflows_set_checkout_clean_true_explicitly() -> None:
    for workflow_path in _all_self_hosted_workflow_paths():
        text = _workflow_text_from(workflow_path)
        for step in text.split("- uses: actions/checkout@")[1:]:
            leading_context = step[:200]
            assert "clean: true" in leading_context, (
                f"{workflow_path.relative_to(REPO_ROOT)} checkout step must declare clean: true explicitly"
            )


def test_nightly_fallback_status_schema_and_defaults() -> None:
    status_step = _step_block("Write nightly fallback status evidence")
    assert "PRIMARY_OUTCOME" in status_step
    assert "FALLBACK_OUTCOME" in status_step
    assert "nightly-fallback-status.json" in status_step

    python_blocks = _extract_heredoc_python_blocks(status_step)
    assert len(python_blocks) >= 2
    status_writer = python_blocks[-1]

    for key in (
        "primary_outcome",
        "fallback_outcome",
        "strict_failure_enforced",
        "session_dir",
        "generated_at",
    ):
        assert f'"{key}"' in status_writer

    assert 'os.environ.get("PRIMARY_OUTCOME", "unknown")' in status_writer
    assert 'os.environ.get("FALLBACK_OUTCOME", "skipped")' in status_writer
    assert 'os.environ.get("SESSION_DIR", "")' in status_writer
    assert 'os.environ.get("GENERATED_AT", "")' in status_writer
    assert 'os.environ.get("STRICT_FAILURE_ENFORCED", "false").lower() == "true"' in status_writer


def test_nightly_fallback_status_writer_runtime_semantics(tmp_path: Path) -> None:
    status_step = _step_block("Write nightly fallback status evidence")
    status_writer = _extract_heredoc_python_blocks(status_step)[-1]
    cases = (
        ("success", "skipped", "false", False),
        ("failure", "success", "true", True),
    )
    for primary_outcome, fallback_outcome, strict_env, strict_expected in cases:
        env = os.environ.copy()
        env.update(
            {
                "PRIMARY_OUTCOME": primary_outcome,
                "FALLBACK_OUTCOME": fallback_outcome,
                "STRICT_FAILURE_ENFORCED": strict_env,
                "SESSION_DIR": "",
                "GENERATED_AT": "2026-02-21T09:00:00Z",
            }
        )
        (tmp_path / ".runtime-cache/automation").mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [sys.executable, "-c", status_writer],
            check=True,
            cwd=tmp_path,
            env=env,
            text=True,
            capture_output=True,
        )
        status_file = tmp_path / ".runtime-cache/automation/nightly-fallback-status.json"
        payload = json.loads(status_file.read_text(encoding="utf-8"))
        assert payload["primary_outcome"] == primary_outcome
        assert payload["fallback_outcome"] == fallback_outcome
        assert payload["strict_failure_enforced"] is strict_expected
        assert payload["generated_at"] == "2026-02-21T09:00:00Z"
        assert payload["session_dir"] == ""


def test_ci_required_gate_duration_artifact_contract() -> None:
    text = _workflow_text_from(CI_WORKFLOW_PATH)
    governance_text = _workflow_text_from(CI_GOVERNANCE_REFERENCE_PATH)
    assert "| ci | `.github/workflows/ci.yml` | `required_ci_gate` | 1 | `ci-quick-gate` |" in governance_text
    assert "name: Collect required gate durations" not in text
    assert ".runtime-cache/artifacts/ci/gate-duration-report.json" not in text
    required_gate_step = _step_block_from(CI_WORKFLOW_PATH, "Aggregate required CI quick gate")
    assert 'if [[ "$CI_QUICK_GATE_RESULT" != "success" ]]; then' in required_gate_step
    assert 'echo "ci-quick-gate did not succeed: $CI_QUICK_GATE_RESULT"' in required_gate_step


def test_ci_failure_bundle_hooks_use_cancelled_or_failure_and_expected_paths() -> None:
    ci_text = _workflow_text_from(CI_WORKFLOW_PATH)
    nightly_text = _workflow_text()
    assert "if: ${{ failure() || cancelled() }}" not in ci_text
    assert "bash scripts/ci/make-failure-bundle.sh || true" not in ci_text
    assert ".runtime-cache/artifacts/ci/failure-bundles/" not in ci_text
    assert "if: ${{ failure() || cancelled() }}" in nightly_text
    assert "bash scripts/ci/make-failure-bundle.sh || true" in nightly_text
    assert ".runtime-cache/artifacts/ci/failure-bundles/" in nightly_text
