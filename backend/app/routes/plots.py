from fastapi import APIRouter, Depends
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from contracts.models import EnvFeature, EnvironmentSummary, PlotContext

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
