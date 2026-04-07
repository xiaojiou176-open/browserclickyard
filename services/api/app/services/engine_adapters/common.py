from __future__ import annotations

from app.core.settings import env_str

import json
import ipaddress
import http.client
import re
import socket
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

_REMOTE_ENGINE_TIMEOUT_SECONDS = 20
_REMOTE_ENGINE_ALLOWED_HOSTS: frozenset[str] = frozenset()


@dataclass
class EngineInput:
    start_url: str
    har_entries: list[dict[str, Any]]
    html_content: str
    extractor_strategy: str


def _score_entry(entry: dict[str, Any], preferred_host: str | None) -> int:
    method = str(entry.get("method") or "").upper()
    url = str(entry.get("url") or "")
    status = int(entry.get("status") or 0)
    if not url:
        return -999
    parsed = urlparse(url)
    path = parsed.path.lower()
    score = 0
    if method in {"POST", "PUT", "PATCH", "DELETE"}:
        score += 60
    elif method == "GET":
        score += 5
    if preferred_host and parsed.netloc == preferred_host:
        score += 8
    if status in {0, 200, 201, 202, 204, 302, 303}:
        score += 10
    if re.search(r"register|signup|sign-up|create|submit|auth|account|user|graphql", path):
        score += 10
    if re.search(r"\.(png|jpg|jpeg|css|js|svg|woff2?)$", path):
        score -= 40
    return score


def pick_primary_entry(har_entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not har_entries:
        return None
    preferred_host: str | None = None
    for candidate in reversed(har_entries):
        url = str(candidate.get("url") or "")
        if url:
            preferred_host = urlparse(url).netloc
            break
    ranked = sorted(
        har_entries,
        key=lambda entry: _score_entry(entry, preferred_host),
        reverse=True,
    )
    return ranked[0] if ranked else None


def _selector_from_html(html_content: str, kind: str) -> dict[str, Any]:
    html = html_content.lower()
    if kind == "email":
        if re.search(r'name=["\']email["\']', html):
            return {"selectors": [{"kind": "name", "value": "[name='email']", "score": 86}]}
        return {"selectors": [{"kind": "css", "value": "input[type='email']", "score": 74}]}
    if kind == "password":
        if re.search(r'name=["\']password["\']', html):
            return {"selectors": [{"kind": "name", "value": "[name='password']", "score": 86}]}
        return {"selectors": [{"kind": "css", "value": "input[type='password']", "score": 74}]}
    if kind == "submit":
        if re.search(r"type=[\"']submit[\"']", html):
            return {"selectors": [{"kind": "css", "value": "button[type='submit']", "score": 80}]}
        return {"selectors": [{"kind": "role", "value": "button[name='Submit']", "score": 70}]}
    return {"selectors": []}


def build_heuristic_steps(
    engine_name: str, payload: EngineInput, confidence: float
) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = [
        {
            "action": "navigate",
            "url": payload.start_url,
            "confidence": min(1.0, confidence + 0.1),
            "source_engine": engine_name,
            "evidence_ref": f"{engine_name}:navigate",
        }
    ]
    primary = pick_primary_entry(payload.har_entries)
    if primary is None:
        steps.append(
            {
                "action": "manual_gate",
                "confidence": confidence,
                "source_engine": engine_name,
                "evidence_ref": f"{engine_name}:missing-primary-entry",
                "manual_handoff_required": True,
                "unsupported_reason": "no actionable request found in HAR",
            }
        )
        return steps

    entry_path = urlparse(str(primary.get("url") or "")).path or payload.start_url
    steps.extend(
        [
            {
                "action": "type",
                "value_ref": "${params.email}",
                "target": _selector_from_html(payload.html_content, "email"),
                "confidence": confidence,
                "source_engine": engine_name,
                "evidence_ref": f"har:{entry_path}:email",
            },
            {
                "action": "type",
                "value_ref": "${secrets.password}",
                "target": _selector_from_html(payload.html_content, "password"),
                "confidence": confidence,
                "source_engine": engine_name,
                "evidence_ref": f"har:{entry_path}:password",
            },
            {
                "action": "click",
                "target": _selector_from_html(payload.html_content, "submit"),
                "confidence": max(0.0, confidence - 0.04),
                "source_engine": engine_name,
                "evidence_ref": f"har:{entry_path}:submit",
            },
            {
                "action": "assert",
                "value_ref": "${assert.success}",
                "confidence": max(0.0, confidence - 0.08),
                "source_engine": engine_name,
                "evidence_ref": f"har:{entry_path}:response",
            },
        ]
    )
    return steps


def call_remote_engine(
    endpoint_env_key: str, payload: EngineInput, engine_name: str
) -> list[dict[str, Any]] | None:
    endpoint = env_str(endpoint_env_key, "").strip()
    if not endpoint:
        return None
    parsed_endpoint = _parse_remote_endpoint(endpoint)
    if parsed_endpoint is None:
        return None
    timeout_seconds = max(2, _REMOTE_ENGINE_TIMEOUT_SECONDS)
    request_payload = {
        "engine": engine_name,
        "start_url": payload.start_url,
        "har_entries": payload.har_entries,
        "html_content": payload.html_content[:12000],
        "extractor_strategy": payload.extractor_strategy,
    }
    try:
        raw = _post_json(parsed_endpoint, request_payload, timeout_seconds)
        parsed = json.loads(raw)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    steps = parsed.get("steps")
    if not isinstance(steps, list):
        return None
    normalized: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        action = str(step.get("action") or "").strip()
        if not action:
            continue
        normalized.append(
            {
                **step,
                "source_engine": str(step.get("source_engine") or engine_name),
                "confidence": max(0.0, min(1.0, float(step.get("confidence", 0.7)))),
            }
        )
    return normalized if normalized else None


def _parse_remote_endpoint(endpoint: str) -> tuple[str, str, int, str] | None:
    parsed = urlparse(endpoint)
    if parsed.scheme.lower() != "https":
        return None
    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        return None
    if _is_forbidden_host(hostname):
        return None
    allowed = _REMOTE_ENGINE_ALLOWED_HOSTS
    if allowed and hostname not in allowed:
        return None
    port = parsed.port or 443
    request_path = parsed.path or "/"
    if parsed.query:
        request_path = f"{request_path}?{parsed.query}"
    return parsed.scheme.lower(), hostname, port, request_path


def _is_forbidden_host(hostname: str) -> bool:
    candidates: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    try:
        candidates.add(ipaddress.ip_address(hostname))
    except ValueError:
        try:
            address_info = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            return False
        for _family, _type, _proto, _canonname, sockaddr in address_info:
            if not sockaddr:
                continue
            try:
                candidates.add(ipaddress.ip_address(sockaddr[0]))
            except ValueError:
                continue
        if not candidates:
            return False
    return any(
        candidate.is_private
        or candidate.is_loopback
        or candidate.is_link_local
        or candidate.is_multicast
        or candidate.is_reserved
        or candidate.is_unspecified
        for candidate in candidates
    )


def _post_json(
    parsed_endpoint: tuple[str, str, int, str], payload: dict[str, Any], timeout_seconds: int
) -> str:
    scheme, host, port, request_path = parsed_endpoint
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if scheme != "https":
        raise ValueError("unsupported scheme")
    context = ssl.create_default_context()
    connection = http.client.HTTPSConnection(
        host=host, port=port, timeout=timeout_seconds, context=context
    )
    try:
        connection.request("POST", request_path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8", errors="replace")
        if response.status < 200 or response.status >= 300:
            raise ValueError(f"remote engine returned {response.status}")
        return raw
    finally:
        connection.close()
