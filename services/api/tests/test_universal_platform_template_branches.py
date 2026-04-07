from __future__ import annotations

import copy
import re
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

import pytest
from fastapi import HTTPException

from app.models.template import TemplateParamSpec, TemplatePolicies, TemplateRecord
from app.services.universal_platform import template as template_ops


def _make_template(
    *,
    template_id: str,
    updated_at: datetime,
    created_by: str | None,
    name: str = "template",
) -> TemplateRecord:
    return TemplateRecord(
        template_id=template_id,
        flow_id="fl-1",
        name=name,
        params_schema=[TemplateParamSpec(key="username", type="string", required=True)],
        defaults={"username": "fallback"},
        policies=TemplatePolicies(),
        created_by=created_by,
        created_at=updated_at - timedelta(minutes=5),
        updated_at=updated_at,
    )


def test_autofill_required_run_params_covers_helper_branches() -> None:
    now = datetime.now(UTC)
    template = TemplateRecord(
        template_id="tp-fill",
        flow_id="fl-1",
        name="fill",
        params_schema=[
            TemplateParamSpec(key="email", type="email"),
            TemplateParamSpec(key="password", type="secret"),
            TemplateParamSpec(key="username", type="string"),
        ],
        defaults={"username": "from-default"},
        policies=TemplatePolicies(),
        created_by="owner-a",
        created_at=now,
        updated_at=now,
    )

    filled = template_ops.autofill_required_run_params(template)

    assert re.fullmatch(r"auto\+[0-9a-f]{8}@example\.com", filled["email"])
    assert re.fullmatch(r"auto-secret-[0-9a-f]{12}", filled["password"])
    assert filled["username"] == "from-default"


def test_list_templates_filters_requester_sorts_and_applies_limit_floor() -> None:
    now = datetime.now(UTC)
    newest_owner = _make_template(
        template_id="tp-newest-owner", updated_at=now, created_by="owner-a"
    )
    middle_other = _make_template(
        template_id="tp-middle-other", updated_at=now - timedelta(minutes=1), created_by="owner-b"
    )
    oldest_owner = _make_template(
        template_id="tp-oldest-owner", updated_at=now - timedelta(minutes=2), created_by="owner-a"
    )
    raw = [
        oldest_owner.model_dump(mode="json"),
        newest_owner.model_dump(mode="json"),
        middle_other.model_dump(mode="json"),
    ]

    class ListService:
        _templates_path = "templates.json"

        def _read_json(self, path: str) -> list[dict[str, Any]]:
            assert path == self._templates_path
            return copy.deepcopy(raw)

        def _template_owner(self, item: TemplateRecord) -> str | None:
            return item.created_by

    service = ListService()

    listed = template_ops.list_templates(service, limit=10)
    assert [item.template_id for item in listed] == [
        "tp-newest-owner",
        "tp-middle-other",
        "tp-oldest-owner",
    ]

    owned_limited = template_ops.list_templates(service, limit=0, requester="owner-a")
    assert [item.template_id for item in owned_limited] == ["tp-newest-owner"]


def test_get_template_missing_raises_404() -> None:
    now = datetime.now(UTC)
    only_item = _make_template(template_id="tp-1", updated_at=now, created_by="owner-a")

    class GetService:
        _templates_path = "templates.json"

        def _read_json(self, path: str) -> list[dict[str, Any]]:
            assert path == self._templates_path
            return [only_item.model_dump(mode="json")]

        def _ensure_template_access(self, template: TemplateRecord, requester: str | None) -> None:
            raise AssertionError(
                f"unexpected access check for missing id: {template.template_id} {requester}"
            )

    with pytest.raises(HTTPException) as missing:
        template_ops.get_template(GetService(), "tp-missing", requester="owner-a")
    assert missing.value.status_code == 404
    assert missing.value.detail == "template not found"


def test_update_template_defaults_only_uses_existing_schema_and_audits() -> None:
    now = datetime.now(UTC)
    existing = _make_template(
        template_id="tp-1", updated_at=now - timedelta(minutes=1), created_by="owner-a"
    )
    templates = [existing.model_dump(mode="json")]

    class UpdateService:
        _templates_path = "templates.json"

        def __init__(self) -> None:
            self._lock = Lock()
            self.sanitize_calls: list[tuple[list[dict[str, Any]], dict[str, str]]] = []
            self.audit_calls: list[tuple[str, str | None, dict[str, Any]]] = []
            self.written: list[dict[str, Any]] | None = None

        def _read_json(self, path: str) -> list[dict[str, Any]]:
            assert path == self._templates_path
            return copy.deepcopy(templates)

        def _ensure_template_access(self, template: TemplateRecord, requester: str | None) -> None:
            assert template.template_id == "tp-1"
            assert requester == "owner-a"

        def _sanitize_defaults(
            self, params_schema: list[dict[str, Any]], defaults: dict[str, str]
        ) -> dict[str, str]:
            self.sanitize_calls.append((copy.deepcopy(params_schema), dict(defaults)))
            return {"username": "sanitized"}

        def _write_json(self, path: str, payload: list[dict[str, Any]]) -> None:
            assert path == self._templates_path
            self.written = copy.deepcopy(payload)

        def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
            self.audit_calls.append((action, actor, dict(payload)))

    service = UpdateService()
    updated = template_ops.update_template(
        service,
        "tp-1",
        defaults={"username": "input"},
        actor="owner-a",
    )

    assert updated.name == "template"
    assert updated.defaults == {"username": "sanitized"}
    assert updated.updated_at > existing.updated_at
    assert service.sanitize_calls and service.sanitize_calls[0][0][0]["key"] == "username"
    assert service.sanitize_calls[0][1] == {"username": "input"}
    assert service.written is not None
    assert service.written[0]["defaults"] == {"username": "sanitized"}
    assert service.audit_calls == [
        ("template.update", "owner-a", {"template_id": "tp-1", "name": "template"})
    ]


def test_update_template_missing_raises_404_after_scanning_items() -> None:
    now = datetime.now(UTC)
    existing = _make_template(template_id="tp-existing", updated_at=now, created_by="owner-a")

    class MissingUpdateService:
        _templates_path = "templates.json"

        def __init__(self) -> None:
            self._lock = Lock()
            self.write_called = False

        def _read_json(self, path: str) -> list[dict[str, Any]]:
            assert path == self._templates_path
            return [existing.model_dump(mode="json")]

        def _ensure_template_access(self, template: TemplateRecord, requester: str | None) -> None:
            raise AssertionError(
                f"unexpected access check for missing id: {template.template_id} {requester}"
            )

        def _write_json(self, path: str, payload: list[dict[str, Any]]) -> None:
            self.write_called = True

        def _audit(self, action: str, actor: str | None, payload: dict[str, Any]) -> None:
            raise AssertionError(f"unexpected audit call: {action} {actor} {payload}")

    service = MissingUpdateService()
    with pytest.raises(HTTPException) as missing:
        template_ops.update_template(service, "tp-unknown", name="new-name", actor="owner-a")
    assert missing.value.status_code == 404
    assert missing.value.detail == "template not found"
    assert service.write_called is False
