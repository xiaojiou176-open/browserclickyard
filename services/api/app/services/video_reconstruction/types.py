from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class ResolvedArtifacts:
    start_url: str
    session_dir: Path
    video_path: Path | None
    har_path: Path | None
    html_path: Path | None
    html_content: str
    har_entries: list[dict[str, Any]]
