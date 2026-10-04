"""Carga local de .env sin sustituir variables ya exportadas."""

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv() -> None:
    """Busca `.env` en el cwd y en la raíz del repo. No pisa exports."""
    here = Path(__file__).resolve()
    candidates = [Path.cwd() / ".env"]
    if len(here.parents) > 3:
        candidates.append(here.parents[3] / ".env")
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen or not path.exists():
            continue
        seen.add(resolved)
        _apply(path)


def _apply(path: Path) -> None:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("\"'")
        if key and key.replace("_", "").isalnum():
            os.environ.setdefault(key, value)
