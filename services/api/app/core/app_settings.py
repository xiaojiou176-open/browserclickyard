from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel


class BackendSettings(BaseModel):
    host: str
    port: int


class AppSettings(BaseModel):
    app_name: str
    environment: str
    backend: BackendSettings


def _resolve_app_env() -> str:
    raw = (os.getenv("APP_ENV", "development") or "development").strip().lower()
    return raw


def load_app_settings() -> AppSettings:
    env = _resolve_app_env()
    repo_root = Path(__file__).resolve().parents[4]
    path = repo_root / "configs" / "runtime" / f"{env}.json"
    if not path.exists():
        raise ValueError(f"unsupported APP_ENV '{env}': config file not found at {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return AppSettings.model_validate(data)
