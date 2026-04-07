from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal


AutomationRunPayloadMode = Literal["strict"]


@dataclass(frozen=True)
class EnvGovernancePolicy:
    automation_run_payload_mode: AutomationRunPayloadMode = "strict"


def _policy_path() -> Path:
    # .../services/api/app/core -> repo root
    return Path(__file__).resolve().parents[4] / "configs" / "env" / "governance-policy.yaml"


def _parse_scalar(raw: str) -> str | None:
    value = raw.split("#", 1)[0].strip()
    if not value:
        return None
    if value in {"null", "~"}:
        return None
    if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
        return value[1:-1]
    return value


@lru_cache(maxsize=1)
def get_env_governance_policy() -> EnvGovernancePolicy:
    path = _policy_path()
    if not path.exists():
        return EnvGovernancePolicy()

    values: dict[str, str | None] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, raw = stripped.split(":", 1)
        values[key.strip()] = _parse_scalar(raw)

    mode: AutomationRunPayloadMode = "strict"
    if values.get("automation_run_payload_mode") not in {None, "strict"}:
        mode = "strict"

    return EnvGovernancePolicy(automation_run_payload_mode=mode)


def is_automation_run_payload_strict() -> bool:
    return get_env_governance_policy().automation_run_payload_mode == "strict"


def refresh_env_governance_policy_cache() -> None:
    get_env_governance_policy.cache_clear()
