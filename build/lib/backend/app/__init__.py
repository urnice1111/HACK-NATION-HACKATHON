"""Ensure advisor/src is importable when the backend runs from the repo root."""

import sys
from pathlib import Path

_ADVISOR_SRC = Path(__file__).resolve().parents[2] / "advisor" / "src"
if _ADVISOR_SRC.is_dir() and str(_ADVISOR_SRC) not in sys.path:
    sys.path.insert(0, str(_ADVISOR_SRC))
