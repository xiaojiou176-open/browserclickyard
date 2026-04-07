from __future__ import annotations

import os
from pathlib import Path

from app.core.settings import env_str


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _resolve_runtime_path(raw: str, default: Path, base_root: Path | None = None) -> Path:
    candidate = raw.strip()
    if not candidate:
        return default.resolve()
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = (base_root or repo_root()) / path
    try:
        return path.resolve()
    except OSError:
        return path


def runtime_cache_root(root: Path | None = None) -> Path:
    base_root = root or repo_root()
    explicit = env_str("UIQ_RUNTIME_CACHE_ROOT", "").strip() or os.getenv("RUNTIME_ROOT", "").strip()
    return _resolve_runtime_path(explicit, base_root / ".runtime-cache", base_root)


def runtime_root(root: Path | None = None) -> Path:
    return runtime_cache_root(root)


def runtime_path(*segments: str, root: Path | None = None) -> Path:
    return runtime_cache_root(root).joinpath(*segments).resolve()


def runtime_logs_root(root: Path | None = None) -> Path:
    base_root = root or repo_root()
    default_path = runtime_cache_root(base_root).joinpath("logs")
    explicit = os.getenv("RUNTIME_LOG_DIR", "").strip()
    return _resolve_runtime_path(explicit, default_path, base_root)


def runtime_logs_path(*segments: str, root: Path | None = None) -> Path:
    return runtime_logs_root(root).joinpath(*segments).resolve()


def automation_runtime_root(root: Path | None = None) -> Path:
    base_root = root or repo_root()
    explicit = env_str("UNIVERSAL_AUTOMATION_RUNTIME_DIR", "").strip()
    default_path = runtime_path("automation", root=base_root)
    return _resolve_runtime_path(explicit, default_path, base_root)
