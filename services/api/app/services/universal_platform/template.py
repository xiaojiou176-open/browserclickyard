from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status
from pydantic import ValidationError

from app.models.template import TemplateParamSpec, TemplatePolicies, TemplateRecord


def autofill_required_run_params(template: TemplateRecord) -> dict[str, str]:
    params: dict[str, str] = {}
    for spec in template.params_schema:
        if spec.type == "email":
            params[spec.key] = f"auto+{uuid4().hex[:8]}@example.com"
        elif spec.type == "secret":
            params[spec.key] = f"auto-secret-{uuid4().hex[:12]}"
        else:
            params[spec.key] = template.defaults.get(spec.key, "")
    return params


def list_templates(
    service: Any, limit: int = 100, requester: str | None = None
) -> list[TemplateRecord]:
    items = [
        TemplateRecord.model_validate(item) for item in service._read_json(service._templates_path)
    ]
    if requester:
        items = [item for item in items if service._template_owner(item) == requester]
    items.sort(key=lambda item: item.updated_at, reverse=True)
    return items[: max(1, min(limit, 300))]


def get_template(service: Any, template_id: str, requester: str | None = None) -> TemplateRecord:
    for item in service._read_json(service._templates_path):
        if item.get("template_id") == template_id:
            template = TemplateRecord.model_validate(item)
            service._ensure_template_access(template, requester)
            return template
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="template not found")


def create_template(
    service: Any,
    *,
    flow_id: str,
    name: str,
    params_schema: list[dict[str, Any] | TemplateParamSpec],
    defaults: dict[str, str],
    policies: dict[str, Any] | TemplatePolicies,
    created_by: str | None = None,
) -> TemplateRecord:
    service.get_flow(flow_id, requester=created_by)
    now = datetime.now(UTC)
    template_id = f"tp_{uuid4().hex}"
    model = TemplateRecord(
        template_id=template_id,
        template_family_id=template_id,
        flow_id=flow_id,
        name=name.strip() or "untitled-template",
        params_schema=params_schema,  # type: ignore[arg-type]
        defaults=service._sanitize_defaults(params_schema, defaults),
        policies=TemplatePolicies.model_validate(policies),
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )
    with service._lock:
        templates = service._read_json(service._templates_path)
        templates.append(model.model_dump(mode="json"))
        service._write_json(service._templates_path, templates)
        service._audit(
            "template.create",
            created_by,
            {"template_id": model.template_id, "flow_id": flow_id, "name": model.name},
        )
    return model


def update_template(
    service: Any,
    template_id: str,
    *,
    name: str | None = None,
    params_schema: list[dict[str, Any] | TemplateParamSpec] | None = None,
    defaults: dict[str, str] | None = None,
    policies: dict[str, Any] | TemplatePolicies | None = None,
    actor: str | None = None,
) -> TemplateRecord:
    with service._lock:
        templates = service._read_json(service._templates_path)
        found = None
        for idx, item in enumerate(templates):
            if item.get("template_id") != template_id:
                continue
            model = TemplateRecord.model_validate(item)
            service._ensure_template_access(model, actor)
            if name is not None:
                model.name = name.strip() or model.name
            schema_dict = [x.model_dump() for x in model.params_schema]
            if params_schema is not None:
                try:
                    model.params_schema = [
                        TemplateParamSpec.model_validate(x) for x in params_schema
                    ]
                except ValidationError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail={
                            "message": "invalid template params_schema payload",
                            "errors": exc.errors(),
                        },
                    ) from exc
                schema_dict = [x.model_dump() for x in model.params_schema]
            if defaults is not None:
                allowed_keys = {
                    item["key"]
                    for item in schema_dict
                    if isinstance(item, dict) and isinstance(item.get("key"), str)
                }
                sanitized_defaults = {
                    key: value for key, value in defaults.items() if key in allowed_keys
                }
                model.defaults = service._sanitize_defaults(schema_dict, sanitized_defaults)
            if policies is not None:
                try:
                    model.policies = TemplatePolicies.model_validate(policies)
                except ValidationError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail={
                            "message": "invalid template policies payload",
                            "errors": exc.errors(),
                        },
                    ) from exc
            model.updated_at = datetime.now(UTC)
            templates[idx] = model.model_dump(mode="json")
            found = model
            break
        if found is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="template not found")
        service._write_json(service._templates_path, templates)
        service._audit("template.update", actor, {"template_id": template_id, "name": found.name})
        return found


def export_template(service: Any, template_id: str, actor: str | None = None) -> dict[str, Any]:
    template = service.get_template(template_id, requester=actor)
    exported = template.model_dump(mode="json")
    exported["defaults"] = service._export_scrubbed_defaults(template)
    service._audit("template.export", actor, {"template_id": template_id})
    return exported


def list_template_history(
    service: Any, template_id: str, requester: str | None = None
) -> list[TemplateRecord]:
    template = service.get_template(template_id, requester=requester)
    family_id = template.template_family_id or template.template_id
    items = [
        TemplateRecord.model_validate(item)
        for item in service._read_json(service._templates_path)
        if (item.get("template_family_id") or item.get("template_id")) == family_id
    ]
    if requester:
        items = [item for item in items if service._template_owner(item) == requester]
    items.sort(key=lambda item: (item.version, item.updated_at), reverse=True)
    return items


def mark_template_recommended(
    service: Any, template_id: str, actor: str | None = None
) -> TemplateRecord:
    target = service.get_template(template_id, requester=actor)
    family_id = target.template_family_id or target.template_id
    with service._lock:
        templates = service._read_json(service._templates_path)
        found: TemplateRecord | None = None
        for idx, item in enumerate(templates):
            model = TemplateRecord.model_validate(item)
            if (model.template_family_id or model.template_id) == family_id:
                model.recommended = model.template_id == template_id
                model.updated_at = datetime.now(UTC)
                templates[idx] = model.model_dump(mode="json")
                if model.template_id == template_id:
                    found = model
        if found is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="template not found")
        service._write_json(service._templates_path, templates)
        service._audit(
            "template.mark_recommended",
            actor,
            {"template_id": template_id, "template_family_id": family_id},
        )
        return found


def fork_template_version(
    service: Any,
    template_id: str,
    *,
    template_name: str | None = None,
    change_note: str | None = None,
    params_schema: list[dict[str, Any] | TemplateParamSpec] | None = None,
    defaults: dict[str, str] | None = None,
    policies: dict[str, Any] | TemplatePolicies | None = None,
    actor: str | None = None,
) -> TemplateRecord:
    source = service.get_template(template_id, requester=actor)
    family_id = source.template_family_id or source.template_id
    history = list_template_history(service, template_id, requester=actor)
    next_version = max((item.version for item in history), default=0) + 1
    now = datetime.now(UTC)
    resolved_schema = params_schema if params_schema is not None else source.params_schema
    resolved_defaults = defaults if defaults is not None else dict(source.defaults)
    resolved_policies = policies if policies is not None else source.policies
    model = TemplateRecord(
        template_id=f"tp_{uuid4().hex}",
        template_family_id=family_id,
        parent_template_id=source.template_id,
        flow_id=source.flow_id,
        version=next_version,
        status="active",
        name=(template_name or source.name).strip() or source.name,
        params_schema=resolved_schema,  # type: ignore[arg-type]
        defaults=service._sanitize_defaults(
            [spec.model_dump() if isinstance(spec, TemplateParamSpec) else spec for spec in resolved_schema],
            resolved_defaults,
        ),
        policies=TemplatePolicies.model_validate(resolved_policies),
        recommended=False,
        promotion_source={
            "kind": "fork_version",
            "source_template_id": source.template_id,
            "change_note": change_note or "",
        },
        created_by=actor,
        created_at=now,
        updated_at=now,
    )
    with service._lock:
        templates = service._read_json(service._templates_path)
        templates.append(model.model_dump(mode="json"))
        service._write_json(service._templates_path, templates)
        service._audit(
            "template.fork_version",
            actor,
            {
                "template_id": model.template_id,
                "template_family_id": family_id,
                "parent_template_id": source.template_id,
                "version": model.version,
            },
        )
    return model


def promote_template(
    service: Any,
    *,
    flow_id: str | None = None,
    run_id: str | None = None,
    template_name: str,
    change_note: str | None = None,
    recommended: bool = False,
    actor: str | None = None,
) -> TemplateRecord:
    source_template: TemplateRecord | None = None
    resolved_flow_id = flow_id
    if run_id:
        run = service.get_run(run_id, requester=actor)
        source_template = service.get_template(run.template_id, requester=actor)
        resolved_flow_id = source_template.flow_id
    if not resolved_flow_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="flow_id or run_id is required for template promotion",
        )
    service.get_flow(resolved_flow_id, requester=actor)
    if source_template is None:
        model = create_template(
            service,
            flow_id=resolved_flow_id,
            name=template_name,
            params_schema=[],
            defaults={},
            policies={},
            created_by=actor,
        )
        model.promotion_source = {
            "kind": "promote_flow",
            "flow_id": resolved_flow_id,
            "change_note": change_note or "",
        }
    else:
        model = fork_template_version(
            service,
            source_template.template_id,
            template_name=template_name,
            change_note=change_note,
            actor=actor,
        )
        model.promotion_source = {
            "kind": "promote_run",
            "run_id": run_id,
            "source_template_id": source_template.template_id,
            "change_note": change_note or "",
        }
    with service._lock:
        templates = service._read_json(service._templates_path)
        for idx, item in enumerate(templates):
            if item.get("template_id") != model.template_id:
                continue
            templates[idx] = model.model_dump(mode="json")
            service._write_json(service._templates_path, templates)
            break
    if recommended:
        model = mark_template_recommended(service, model.template_id, actor=actor)
    service._audit(
        "template.promote",
        actor,
        {
            "template_id": model.template_id,
            "flow_id": resolved_flow_id,
            "run_id": run_id,
            "recommended": recommended,
        },
    )
    return model
