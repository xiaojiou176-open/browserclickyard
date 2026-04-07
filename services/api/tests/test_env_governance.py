from __future__ import annotations

from pathlib import Path

import app.core.env_governance as env_gov


def test_parse_scalar_variants() -> None:
    assert env_gov._parse_scalar(" value ") == "value"
    assert env_gov._parse_scalar(" 'quoted' ") == "quoted"
    assert env_gov._parse_scalar(' "quoted2" ') == "quoted2"
    assert env_gov._parse_scalar("null") is None
    assert env_gov._parse_scalar("~") is None
    assert env_gov._parse_scalar(" # comment-only") is None
    assert env_gov._parse_scalar("v # x") == "v"


def test_get_env_governance_policy_defaults_when_missing(monkeypatch) -> None:
    env_gov.refresh_env_governance_policy_cache()
    missing = Path("/tmp/non-existing-env-governance-policy.yaml")
    monkeypatch.setattr(env_gov, "_policy_path", lambda: missing)

    policy = env_gov.get_env_governance_policy()
    assert policy.automation_run_payload_mode == "strict"
    assert env_gov.is_automation_run_payload_strict() is True


def test_get_env_governance_policy_parsing(monkeypatch, tmp_path: Path) -> None:
    env_gov.refresh_env_governance_policy_cache()
    policy_file = tmp_path / "env-governance-policy.yaml"
    policy_file.write_text(
        """
# comment line
automation_run_payload_mode: strict
ignored_line_without_colon
unknown: value
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(env_gov, "_policy_path", lambda: policy_file)

    policy = env_gov.get_env_governance_policy()
    assert policy.automation_run_payload_mode == "strict"
    assert env_gov.is_automation_run_payload_strict() is True


def test_get_env_governance_policy_invalid_mode_falls_back(monkeypatch, tmp_path: Path) -> None:
    env_gov.refresh_env_governance_policy_cache()
    policy_file = tmp_path / "env-governance-policy.yaml"
    policy_file.write_text(
        "automation_run_payload_mode: random\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(env_gov, "_policy_path", lambda: policy_file)

    policy = env_gov.get_env_governance_policy()
    assert policy.automation_run_payload_mode == "strict"

    env_gov.refresh_env_governance_policy_cache()
