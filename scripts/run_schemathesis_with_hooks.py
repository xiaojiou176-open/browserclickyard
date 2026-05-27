#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import schemathesis
from schemathesis.cli import schemathesis as schemathesis_cli

SAFE_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
ALLOWED_HEADERS = {
    "x-automation-token",
    "x-automation-client-id",
    "content-type",
    "x-csrf-token",
}
HOOK_LOG = Path(".runtime-cache/logs/schemathesis-hook.log")
HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
CSRF_RE = re.compile(r"^[A-Za-z0-9._~-]{1,256}$")
ARTIFACT_ENDPOINTS = {
    "/api/command-tower/orchestrate-from-artifacts",
    "/api/templates/from-artifacts",
    "/api/profiles/resolve",
    "/api/reconstruction/preview",
}
RUNTIME_ROOT = Path(
    Path.cwd().joinpath(".runtime-cache").as_posix()
)  # fallback for local runs when env is absent


def _is_local_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.hostname in SAFE_LOCAL_HOSTS


def _is_safe_header_value(value: str) -> bool:
    if any(ch in value for ch in ("\r", "\n")):
        return False
    try:
        value.encode("latin-1")
    except UnicodeEncodeError:
        return False
    return True


def _matches_path(path: str | None, pattern: str) -> bool:
    if not path:
        return False
    regex = (
        "^" + re.sub(r"\{[^/]+\}", r"[^/]+", re.escape(pattern)).replace(r"\[^/\]\+", "[^/]+") + "$"
    )
    return re.fullmatch(regex, path) is not None


def _runtime_root() -> Path:
    configured_value = os.environ.get(
        "UNIVERSAL_AUTOMATION_RUNTIME_DIR", os.environ.get("SCHEMATHESIS_RUNTIME_ROOT", "")
    )
    if configured_value:
        configured = Path(configured_value)
        try:
            return configured.expanduser().resolve()
        except OSError:
            pass
    return RUNTIME_ROOT.resolve()


def _sanitize_headers(case: object, path: str | None, method: str | None) -> None:
    method_name = (method or "").lower()
    headers = getattr(case, "headers", None) or {}
    sanitized: dict[str, str] = {}
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        if key.lower() not in ALLOWED_HEADERS:
            continue
        if not HEADER_NAME_RE.fullmatch(key):
            continue
        if not _is_safe_header_value(value):
            continue
        if key.lower() == "content-type":
            normalized_value = value.strip().lower()
            if method_name not in {"post", "patch", "put"}:
                continue
            if normalized_value not in {"application/json", "application/json; charset=utf-8"}:
                continue
        sanitized[key] = value

    sanitized.pop("Cookie", None)
    sanitized.pop("cookie", None)

    if not _matches_path(path, "/api/register"):
        sanitized.pop("X-CSRF-Token", None)
        sanitized.pop("x-csrf-token", None)
        if hasattr(case, "cookies"):
            case.cookies = {}
    else:
        token = sanitized.get("X-CSRF-Token")
        if token is not None and not CSRF_RE.fullmatch(token):
            sanitized["X-CSRF-Token"] = "abc"
        case.cookies = {"csrf_token": "abc"}

    case.headers = sanitized or None


def _sanitize_query(case: object, path: str | None, method: str | None) -> None:
    method_name = (method or "").lower()
    query = getattr(case, "query", None)
    if not isinstance(query, dict):
        return
    if method_name == "post" and _matches_path(path, "/api/runs/{run_id}/cancel"):
        allowed = {"expected_version"}
    elif method_name == "get" and _matches_path(path, "/api/sessions"):
        allowed = {"limit"}
    elif method_name in {"get", "post"} and any(
        _matches_path(path, pattern)
        for pattern in {
            "/api/automation/tasks/{task_id}",
            "/api/automation/tasks/{task_id}/cancel",
            "/api/flows/{flow_id}",
            "/api/runs/{run_id}",
            "/api/sessions/{session_id}/finish",
            "/api/templates/{template_id}",
            "/api/templates/{template_id}/export",
        }
    ):
        allowed = set()
    else:
        return
    sanitized_query = {key: value for key, value in query.items() if key in allowed}
    if method_name == "post" and _matches_path(path, "/api/runs/{run_id}/cancel"):
        raw_expected_version = sanitized_query.get("expected_version")
        if raw_expected_version == "null":
            sanitized_query.pop("expected_version", None)
        elif isinstance(raw_expected_version, list):
            normalized_values = [
                value
                for value in raw_expected_version
                if not (isinstance(value, str) and value == "null")
            ]
            if normalized_values:
                sanitized_query["expected_version"] = normalized_values[0]
            else:
                sanitized_query.pop("expected_version", None)
    case.query = sanitized_query


def _sanitize_artifacts_payload(case: object, path: str | None) -> None:
    if not any(_matches_path(path, endpoint) for endpoint in ARTIFACT_ENDPOINTS):
        return
    body = getattr(case, "body", None)
    if not isinstance(body, dict):
        return

    artifacts = body.get("artifacts")
    if isinstance(artifacts, dict):
        runtime_root = _runtime_root()
        for key in ("session_dir", "video_path", "har_path", "html_path"):
            value = artifacts.get(key)
            if not isinstance(value, str):
                continue
            stripped = value.strip()
            if not stripped:
                artifacts[key] = None
                continue
            if any(ord(ch) < 32 or ord(ch) == 127 for ch in stripped):
                artifacts[key] = None
                continue
            candidate = Path(stripped)
            if candidate.is_absolute():
                try:
                    candidate.resolve().relative_to(runtime_root)
                except (OSError, ValueError):
                    artifacts[key] = None
                    continue
            artifacts[key] = stripped

    if body.get("create_run") is True and isinstance(body.get("run_params"), dict):
        raw_params = body["run_params"]
        sanitized_params: dict[str, str] = {}
        for key in ("email", "password"):
            value = raw_params.get(key)
            if isinstance(value, str) and value.strip():
                sanitized_params[key] = value.strip()
        body["run_params"] = sanitized_params

    case.body = body


def _sanitize_template_patch_payload(case: object, path: str | None, method: str | None) -> None:
    if (method or "").lower() != "patch" or not _matches_path(path, "/api/templates/{template_id}"):
        return
    body = getattr(case, "body", None)
    if not isinstance(body, dict):
        return
    defaults = body.get("defaults")
    params_schema = body.get("params_schema")
    if not isinstance(defaults, dict):
        return
    allowed_keys: set[str] = set()
    if isinstance(params_schema, list):
        for item in params_schema:
            if isinstance(item, dict):
                key = item.get("key")
                if isinstance(key, str) and key:
                    allowed_keys.add(key)
    if allowed_keys:
        body["defaults"] = {key: value for key, value in defaults.items() if key in allowed_keys}
    else:
        body["defaults"] = {}
    case.body = body


def _sanitize_reconstruction_generate_payload(
    case: object, path: str | None, method: str | None
) -> None:
    if (method or "").lower() != "post" or not _matches_path(path, "/api/reconstruction/generate"):
        return
    body = getattr(case, "body", None)
    if not isinstance(body, dict):
        return
    preview_id = body.get("preview_id")
    if isinstance(preview_id, str) and re.fullmatch(r"^prv_[0-9a-f]{32}$", preview_id):
        body.pop("preview", None)
    run_params = body.get("run_params")
    if isinstance(run_params, dict):
        sanitized_params: dict[str, str] = {}
        email = run_params.get("email")
        if isinstance(email, str) and re.fullmatch(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email.strip()):
            sanitized_params["email"] = email.strip()
        password = run_params.get("password")
        if isinstance(password, str) and password.strip():
            sanitized_params["password"] = password.strip()
        body["run_params"] = sanitized_params
    case.body = body


@schemathesis.hook
def before_call(context: schemathesis.HookContext, case: object, **kwargs: object) -> None:
    path = getattr(getattr(context, "operation", None), "path", None)
    method = getattr(getattr(context, "operation", None), "method", None)
    session = kwargs.get("session")
    if path and not _matches_path(path, "/api/register") and hasattr(session, "cookies"):
        try:
            session.cookies.clear()
        except Exception:
            pass
    _sanitize_headers(case, path, method)
    _sanitize_query(case, path, method)
    _sanitize_artifacts_payload(case, path)
    _sanitize_template_patch_payload(case, path, method)
    _sanitize_reconstruction_generate_payload(case, path, method)
    try:
        HOOK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HOOK_LOG.open("a", encoding="utf-8") as fh:
            fh.write(
                f"{method} {path}|headers={getattr(case, 'headers', None)}|query={getattr(case, 'query', None)}\n"
            )
    except OSError:
        pass


def main() -> int:
    args = [arg for arg in sys.argv[1:] if arg != "--"]
    for index, arg in enumerate(args):
        if arg in {"--url", "-u"} and index + 1 < len(args):
            if not _is_local_url(args[index + 1]):
                raise SystemExit(
                    "error: only local schemathesis targets are allowed by this wrapper"
                )
    return schemathesis_cli.main(args=args, prog_name="schemathesis", standalone_mode=False)


if __name__ == "__main__":
    raise SystemExit(main())
