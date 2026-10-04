from collections.abc import Iterator

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.config import settings

pool = ConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    open=False,
    kwargs={"row_factory": dict_row, "options": "-c statement_timeout=5000"},
)


def get_conn() -> Iterator[Connection]:
    with pool.connection() as conn:
        yield conn
