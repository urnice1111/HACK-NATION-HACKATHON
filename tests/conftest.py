import subprocess
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from backend.app.config import settings

ROOT = Path(__file__).parent.parent


def db_available() -> bool:
    try:
        psycopg.connect(settings.database_url, connect_timeout=2).close()
        return True
    except psycopg.OperationalError:
        return False


@pytest.fixture(scope="session")
def client():
    if not db_available():
        pytest.skip("demo database not running (docker compose up -d db)")
    from backend.app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def fresh_db():
    """Reloads the demo seed. Use in modules that write."""
    if not db_available():
        pytest.skip("demo database not running (docker compose up -d db)")
    subprocess.run([ROOT / "backend/scripts/reset_db.sh"], check=True, capture_output=True,
                   env={"DATABASE_URL": settings.database_url, "PATH": "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"})


@pytest.fixture
def db():
    with psycopg.connect(settings.database_url) as conn:
        yield conn
