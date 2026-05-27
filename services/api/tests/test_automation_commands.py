from __future__ import annotations

import app.services.automation_commands as automation_commands


def test_safe_and_high_risk_sets_are_disjoint_and_classified_correctly() -> None:
    overlap = (
        automation_commands.SAFE_AUTOMATION_COMMANDS
        & automation_commands.HIGH_RISK_AUTOMATION_COMMANDS
    )
    assert overlap == set()

    assert automation_commands.is_safe_automation_command("script-pipeline-full") is True
    assert automation_commands.is_safe_automation_command("automation-replay-flow") is True
    assert automation_commands.is_high_risk_automation_command("clean") is True
    assert automation_commands.is_high_risk_automation_command("automation-record") is True

    # Unknown commands must not be accidentally treated as safe/high-risk.
    assert automation_commands.is_safe_automation_command("unknown-cmd") is False
    assert automation_commands.is_high_risk_automation_command("unknown-cmd") is False


def test_build_command_specs_matches_command_policies_and_contract_shape() -> None:
    specs = automation_commands.build_command_specs()

    # Every policy command must have a concrete executable spec.
    for command_id in (
        automation_commands.SAFE_AUTOMATION_COMMANDS
        | automation_commands.HIGH_RISK_AUTOMATION_COMMANDS
    ):
        assert command_id in specs

    # No unknown policy ids should leak into specs.
    unknown_policy_ids = (
        automation_commands.SAFE_AUTOMATION_COMMANDS
        | automation_commands.HIGH_RISK_AUTOMATION_COMMANDS
    ) - set(specs)
    assert unknown_policy_ids == set()

    for command_id, spec in specs.items():
        assert spec.command_id == command_id
        assert spec.title.strip() != ""
        assert spec.description.strip() != ""
        assert len(spec.argv) >= 1
        assert all(arg.strip() != "" for arg in spec.argv)
        assert len(spec.tags) >= 1

    clean_spec = specs["clean"]
    assert clean_spec.argv[:2] == ["zsh", "-lc"]
    assert "rm -rf" in clean_spec.argv[2]

    backend_test_spec = specs["backend-test"]
    assert backend_test_spec.argv == ["uv", "run", "--extra", "dev", "pytest"]

    run_spec = specs["script-pipeline-full"]
    assert "script-pipeline lane" in run_spec.description
    assert "script-lane" in run_spec.tags

    run_ui_midscene_spec = specs["script-pipeline-capture-midscene"]
    assert run_ui_midscene_spec.argv == ["./scripts/run-pipeline.sh", "midscene", "ui-only"]
    assert "script-lane" in run_ui_midscene_spec.tags

    replay_flow_spec = specs["automation-replay-flow"]
    assert "workflow /api/runs" in replay_flow_spec.description
    assert "workflow-run" in replay_flow_spec.tags
