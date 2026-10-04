from fastapi import APIRouter, Depends, Header, Query
from psycopg import Connection

from backend.app.alerts import review_alert
from backend.app.db import get_conn
from backend.app.errors import ApiError
from contracts.enums import AlertStatus
from contracts.models import AlertList, AlertOut, AlertReview

router = APIRouter(prefix="/v1/alerts", tags=["alerts"])

ALERT_SELECT = """
    select a.id as alert_id, a.plot_id, p.name as plot_label, f.name as recipient_label, a.threat_code,
           a.status, a.version, a.message, re.inspection_priority, re.score, re.reasons,
           a.risk_evaluation_id, a.created_at, a.review_reason, a.approved_by, a.approved_at, a.is_demo,
           coalesce((
             select json_agg(json_build_object(
               'notification_id', n.id, 'channel', n.channel, 'status', n.status,
               'attempt_count', n.attempt_count, 'last_error', n.last_error) order by n.created_at)
             from notifications n where n.alert_id = a.id), '[]') as notifications
    from alerts a
    join plots p on p.id = a.plot_id
    join farmers f on f.id = p.farmer_id
    join risk_evaluations re on re.id = a.risk_evaluation_id
"""


def get_alert(conn: Connection, alert_id: str) -> AlertOut:
    row = conn.execute(ALERT_SELECT + " where a.id = %s", (alert_id,)).fetchone()
    if row is None:
        raise ApiError(404, "Alerta no encontrada")
    return AlertOut(**row)


@router.get("", response_model=AlertList)
def list_alerts(
    status: AlertStatus | None = None,
    plot_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    conn: Connection = Depends(get_conn),
):
    rows = conn.execute(
        ALERT_SELECT + """
        where (%(status)s::text is null or a.status = %(status)s)
          and (%(plot)s::text is null or a.plot_id = %(plot)s)
        order by a.created_at desc limit %(limit)s
        """,
        {"status": status, "plot": plot_id, "limit": limit},
    ).fetchall()
    return AlertList(alerts=rows)


@router.get("/{alert_id}", response_model=AlertOut)
def read_alert(alert_id: str, conn: Connection = Depends(get_conn)):
    return get_alert(conn, alert_id)


@router.post("/{alert_id}/review", response_model=AlertOut)
def review(
    alert_id: str,
    body: AlertReview,
    x_operator_id: str = Header(default="operator_demo"),
    conn: Connection = Depends(get_conn),
):
    """Reviewer comes from X-Operator-Id until dashboard auth exists."""
    review_alert(conn, alert_id, body.decision, body.expected_version, body.reason, body.message, x_operator_id)
    return get_alert(conn, alert_id)
