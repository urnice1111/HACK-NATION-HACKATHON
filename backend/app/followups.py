"""Follow-up scheduling (INSTRUCTIONS.md sections 2.2 and 6).

Communications polls GET /v1/followups for due ones; the worker will also emit followup.due later.
"""

from datetime import datetime

from psycopg import Connection

from backend.app.config import settings

OPEN_STATUSES = ("scheduled", "contacting", "no_response")


def schedule_followup(conn: Connection, case_id: str, is_demo: bool) -> datetime | None:
    """Schedules the case's next follow-up unless one is already open. Returns its due_at."""
    row = conn.execute(
        """
        insert into followups (is_demo, case_id, due_at)
        values (%s, %s, now() + make_interval(secs => %s))
        on conflict (case_id) where status in ('scheduled', 'contacting', 'no_response') do nothing
        returning due_at
        """,
        (is_demo, case_id, settings.followup_interval_s),
    ).fetchone()
    return row["due_at"] if row else None
