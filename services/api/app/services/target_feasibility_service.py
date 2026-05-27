from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.core.runtime_paths import repo_root


_ACTION_CAPABILITY_MAP = {
    "navigate": "navigate",
    "click": "interact",
    "type": "interact",
    "select": "interact",
    "wait_for": "interact",
    "assert": "interact",
    "extract": "capture",
    "branch": "interact",
    "manual_gate": "interact",
}


class TargetFeasibilityService:
    def __init__(self) -> None:
        self._root = repo_root()

    def evaluate_template(
        self, template: Any, flow: Any, *, target_name: str
    ) -> dict[str, Any]:
        registry = self._load_registry()
        target = self._load_target(target_name)
        driver_id = str(target.get("driver") or "").strip()
        driver = registry.get(driver_id) or {}
        capabilities = driver.get("capabilities") if isinstance(driver, dict) else {}
        capabilities = capabilities if isinstance(capabilities, dict) else {}

        required_capabilities = self._required_capabilities_from_flow(flow)
        blocked_reasons: list[str] = []
        for capability in required_capabilities:
            if capabilities.get(capability) is True:
                continue
            blocked_reasons.append(
                f"target '{target_name}' missing capability '{capability}' for template '{template.template_id}'"
            )

        migration_hints = self._build_migration_hints(
            target_name=target_name,
            required_capabilities=required_capabilities,
            blocked_reasons=blocked_reasons,
        )

        return {
            "template_id": template.template_id,
            "target": target_name,
            "supported": len(blocked_reasons) == 0,
            "blocked_reasons": blocked_reasons,
            "migration_hints": migration_hints,
            "required_capabilities": required_capabilities,
        }

    def _required_capabilities_from_flow(self, flow: Any) -> list[str]:
        required: list[str] = []
        seen: set[str] = set()
        for step in getattr(flow, "steps", []):
            action = str(getattr(step, "action", "") or "").strip().lower()
            capability = _ACTION_CAPABILITY_MAP.get(action)
            if capability and capability not in seen:
                seen.add(capability)
                required.append(capability)
        if "capture" not in seen:
            required.append("capture")
        return required

    def _build_migration_hints(
        self,
        *,
        target_name: str,
        required_capabilities: list[str],
        blocked_reasons: list[str],
    ) -> list[str]:
        hints: list[str] = []
        if not blocked_reasons:
            hints.append(f"target '{target_name}' satisfies current template capability needs")
            return hints
        if "navigate" in required_capabilities:
            hints.append("replace browser-side navigation assumptions with target bootstrap hooks")
        if "capture" in required_capabilities:
            hints.append("verify screenshot/evidence capture support on the target before promotion")
        hints.append("if blocked reasons remain, keep this template web-only and create a target-specific version")
        return hints

    def _load_target(self, target_name: str) -> dict[str, Any]:
        target_path = self._root / "configs" / "targets" / f"{target_name}.yaml"
        if not target_path.exists():
            raise ValueError(f"target not found: {target_name}")
        return self._load_yaml(target_path)

    def _load_registry(self) -> dict[str, Any]:
        registry_path = self._root / "configs" / "drivers" / "capabilities.registry.json"
        if not registry_path.exists():
            raise ValueError("driver capability registry missing")
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
        drivers = payload.get("drivers")
        if not isinstance(drivers, dict):
            raise ValueError("driver capability registry invalid")
        return drivers

    def _load_yaml(self, path: Path) -> dict[str, Any]:
        try:
            import yaml
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("PyYAML is required for target feasibility service") from exc
        payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(payload, dict):
            raise ValueError(f"invalid yaml payload: {path}")
        return payload


target_feasibility_service = TargetFeasibilityService()
