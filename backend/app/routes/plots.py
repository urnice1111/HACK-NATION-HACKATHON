from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from contracts.models import EnvFeature, EnvironmentSummary, PlotContext, PlotTimeline

router = APIRouter(prefix="/v1/plots", tags=["plots"])

# Units for env.plot_summary features (section 8: variables always carry a unit).
FEATURE_UNITS = {
    "humidity_mean_14d": "%",
    "rain_anomaly_30d": "ratio",
    "temp_optimal_days_14d": "d",
}


def environment_summary(conn: Connection, plot_id: str) -> EnvironmentSummary | None:
    """Reads env.plot_summary (owner: integrante 4). Missing table or row -> None, not an error."""
    if conn.execute("select to_regclass('env.plot_summary') as t").fetchone()["t"] is None:
        return None
    row = conn.execute(
        """
        select computed_at, features, data_freshness from env.plot_summary
        where plot_id = %s order by computed_at desc limit 1
        """,
        (plot_id,),
    ).fetchone()
    if row is None:
        return None
    features = dict(row["features"])
    dataset_ids = features.pop("dataset_ids", [])
    return EnvironmentSummary(
        computed_at=row["computed_at"],
        data_freshness=row["data_freshness"],
        features=[EnvFeature(name=name, value=value, unit=FEATURE_UNITS.get(name, "unknown"))
                  for name, value in sorted(features.items())],
        dataset_ids=dataset_ids,
    )


@router.get("/{plot_id}/context", response_model=PlotContext)
def plot_context(plot_id: str, conn: Connection = Depends(get_conn)):
    plot = conn.execute(
        "select id, name, crop, variety, altitude_m, is_demo from plots where id = %s", (plot_id,)
    ).fetchone()
    if plot is None:
        raise ApiError(404, "Parcela no encontrada")

    cases = conn.execute(
        """
        select id as case_id, threat_code, status, opened_at, last_observation_at
        from cases where plot_id = %s and status <> 'resolved'
        order by opened_at desc
        """,
        (plot_id,),
    ).fetchall()

    followups = conn.execute(
        """
        select f.id as followup_id, f.case_id, f.due_at, f.status
        from followups f join cases c on c.id = f.case_id
        where c.plot_id = %s and c.status <> 'resolved'
          and f.status in ('scheduled', 'contacting', 'no_response')
        order by f.due_at
        """,
        (plot_id,),
    ).fetchall()

    summary = environment_summary(conn, plot_id)
    return PlotContext(
        plot_id=plot["id"],
        label=plot["name"],
        crop=plot["crop"],
        variety=plot["variety"],
        altitude_m=plot["altitude_m"],
        data_freshness=summary.data_freshness if summary else "unknown",
        environment_summary=summary,
        active_cases=cases,
        pending_followups=followups,
        is_demo=plot["is_demo"],
    )


def parse_cursor(cursor: str | None) -> tuple[datetime | None, str | None]:
    if not cursor:
        return None, None
    try:
        occurred_at, event_id = cursor.rsplit("|", 1)
        when = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
        if not event_id:
            raise ValueError
    except ValueError as exc:
        raise ApiError(422, "Cursor inválido") from exc
    return when, event_id


def encode_cursor(occurred_at: datetime, event_id: str) -> str:
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=UTC)
    stamp = occurred_at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return f"{stamp}|{event_id}"


@router.get("/{plot_id}/timeline", response_model=PlotTimeline)
def plot_timeline(
    plot_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
    conn: Connection = Depends(get_conn),
):
    """Paginated history for the dashboard: reports, risk, follow-ups, resolutions."""
    plot = conn.execute("select id, is_demo from plots where id = %s", (plot_id,)).fetchone()
    if plot is None:
        raise ApiError(404, "Parcela no encontrada")

    cursor_at, cursor_id = parse_cursor(cursor)
    rows = conn.execute(
        """
        select * from (
          select r.id as event_id, 'report.created' as event_type, r.received_at as occurred_at,
                 coalesce(nullif(r.user_statement, ''), 'Reporte recibido') as summary,
                 c.threat_code, r.case_id, r.id as report_id, null::text as followup_id,
                 null::text as resolution_id, r.is_demo
          from reports r
          left join cases c on c.id = r.case_id
          where r.plot_id = %(plot)s

          union all

          select re.id, 'risk.updated', re.created_at,
                 'Prioridad de inspección: ' || re.inspection_priority,
                 re.threat_code, null, null, null, null, re.is_demo
          from risk_evaluations re
          where re.plot_id = %(plot)s

          union all

          select f.id,
                 case when f.status = 'responded' then 'followup.responded' else 'followup.due' end,
                 case
                   when f.status = 'responded' and resp.received_at is not null then resp.received_at
                   when f.status = 'responded' then f.updated_at
                   else f.due_at
                 end,
                 case f.status
                   when 'responded' then 'Seguimiento respondido'
                   when 'no_response' then 'Seguimiento sin respuesta'
                   when 'contacting' then 'Seguimiento en curso'
                   when 'failed' then 'Seguimiento fallido'
                   when 'cancelled' then 'Seguimiento cancelado'
                   else 'Seguimiento programado'
                 end,
                 c.threat_code, f.case_id, f.response_report_id, f.id, null, f.is_demo
          from followups f
          join cases c on c.id = f.case_id
          left join reports resp on resp.id = f.response_report_id
          where c.plot_id = %(plot)s

          union all

          select cr.id, 'case.resolved', cr.resolved_at,
                 coalesce(nullif(cr.solution_statement, ''), 'Caso resuelto'),
                 cr.threat_code, cr.case_id, null, cr.followup_id, cr.id, cr.is_demo
          from case_resolutions cr
          where cr.plot_id = %(plot)s
        ) e
        where %(cursor_at)s::timestamptz is null
           or (e.occurred_at, e.event_id) < (%(cursor_at)s, %(cursor_id)s)
        order by e.occurred_at desc, e.event_id desc
        limit %(limit)s
        """,
        {"plot": plot_id, "cursor_at": cursor_at, "cursor_id": cursor_id, "limit": limit + 1},
    ).fetchall()

    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = encode_cursor(last["occurred_at"], last["event_id"])
        rows = rows[:limit]

    return PlotTimeline(plot_id=plot_id, events=rows, next_cursor=next_cursor, is_demo=plot["is_demo"])
