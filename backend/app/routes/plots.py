from fastapi import APIRouter, Depends
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from contracts.models import EnvironmentSummary, PlotContext

router = APIRouter(prefix="/v1/plots", tags=["plots"])


def environment_summary(conn: Connection, plot_id: str) -> EnvironmentSummary:
    """Reads env.plot_summary (owner: integrante 4). Missing table or row -> unknown, not an error."""
    if conn.execute("select to_regclass('env.plot_summary') as t").fetchone()["t"] is None:
        return EnvironmentSummary(computed_at=None, features={}, data_freshness="unknown")
    row = conn.execute(
        """
        select computed_at, features, data_freshness from env.plot_summary
        where plot_id = %s order by computed_at desc limit 1
        """,
        (plot_id,),
    ).fetchone()
    if row is None:
        return EnvironmentSummary(computed_at=None, features={}, data_freshness="unknown")
    return EnvironmentSummary(**row)


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

    risk = conn.execute(
        """
        select distinct on (threat_code)
               threat_code, inspection_priority, score, reasons, model_version, heuristic
        from risk_evaluations where plot_id = %s
        order by threat_code, created_at desc
        """,
        (plot_id,),
    ).fetchall()

    return PlotContext(
        plot_id=plot["id"],
        name=plot["name"],
        crop=plot["crop"],
        variety=plot["variety"],
        altitude_m=plot["altitude_m"],
        active_cases=cases,
        risk=risk,
        environment_summary=environment_summary(conn, plot_id),
        is_demo=plot["is_demo"],
    )
