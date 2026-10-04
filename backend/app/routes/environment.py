"""Endpoints del esquema env (INSTRUCTIONS.md sección 10; dueño: integrante 4). Todos de solo lectura.

env_query: el asesor manda una especificación estructurada, nunca SQL. Cada variable se valida contra
env.variable_catalog; fuera de cobertura se responde value null y coverage 0, no un error.
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.graph.engine import haversine_km
from backend.app.routes.plots import environment_summary
from contracts.models import (
    EnvCatalogResponse,
    EnvQueryRequest,
    EnvQueryResponse,
    EnvResult,
    ExternalContextResponse,
    PlotEnvironmentSummary,
    PlotTarget,
)

router = APIRouter(prefix="/v1", tags=["environment"])

# Media diagonal de una celda de NASA POWER (0.5° x 0.625°) en la región: más lejos, sin cobertura.
MAX_CELL_DISTANCE_KM = 45.0
FRESH_MAX_AGE_DAYS = 7
# Por debajo de esta cobertura no se agrega: un promedio o suma con muchos huecos engaña.
MIN_COVERAGE = 0.8
# Solo hay normal comparable para promedios y sumas; un mínimo o máximo no se compara con la media mensual.
NORMAL_AGGREGATIONS = {"mean", "sum"}


def aggregate(values: list[float], aggregation: str) -> float | None:
    if not values:
        return None
    match aggregation:
        case "sum":
            return sum(values)
        case "mean":
            return sum(values) / len(values)
        case "min":
            return min(values)
        case "max":
            return max(values)
    return None


def expected_normal(days: list[date], monthly: dict[int, float], aggregation: str) -> float | None:
    """Normal para los mismos días con dato: suma o promedio de la media diaria del mes de cada día."""
    if aggregation not in NORMAL_AGGREGATIONS or not days or any(d.month not in monthly for d in days):
        return None
    total = sum(monthly[d.month] for d in days)
    return total if aggregation == "sum" else total / len(days)


def freshness(latest: date | None, today: date) -> str:
    if latest is None:
        return "unknown"
    return "fresh" if (today - latest).days <= FRESH_MAX_AGE_DAYS else "stale"


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def validate_variables(conn: Connection, body: EnvQueryRequest) -> dict[str, dict]:
    catalog = {
        r["variable_code"]: r
        for r in conn.execute("select variable_code, unit, allowed_aggregations, dataset_id from env.variable_catalog")
    }
    details = []
    for i, spec in enumerate(body.variables):
        entry = catalog.get(spec.code)
        if entry is None:
            details.append({"field": f"variables[{i}].code", "reason": "unknown_variable"})
        elif spec.aggregation not in entry["allowed_aggregations"]:
            details.append({"field": f"variables[{i}].aggregation", "reason": "aggregation_not_allowed"})
    if details:
        first = details[0]
        message = (f"{first['field']} no existe en el catálogo" if first["reason"] == "unknown_variable"
                   else f"{first['field']} no está permitida para esa variable")
        raise ApiError(422, message, details=details)
    return catalog


def resolve_cell(conn: Connection, body: EnvQueryRequest) -> tuple[str | None, float | None]:
    if isinstance(body.target, PlotTarget):
        if conn.execute("select 1 from public.plots where id = %s", (body.target.plot_id,)).fetchone() is None:
            raise ApiError(404, "Parcela no encontrada")
        row = conn.execute("select cell_id, distance_km from env.plot_cell_map where plot_id = %s",
                           (body.target.plot_id,)).fetchone()
        return (row["cell_id"], row["distance_km"]) if row else (None, None)

    lat, lon = body.target.latitude, body.target.longitude
    nearest = min(
        ((haversine_km(lat, lon, c["latitude"], c["longitude"]), c["cell_id"])
         for c in conn.execute("select cell_id, latitude, longitude from env.grid_cells")),
        default=None,
    )
    if nearest is None or nearest[0] > MAX_CELL_DISTANCE_KM:
        return None, None
    return nearest[1], round(nearest[0], 2)


def require_env(conn: Connection) -> None:
    if conn.execute("select to_regclass('env.variable_catalog') as t").fetchone()["t"] is None:
        raise ApiError(503, "Datos ambientales no disponibles", retryable=True)


@router.get("/environment/catalog", response_model=EnvCatalogResponse)
def env_catalog(conn: Connection = Depends(get_conn)):
    """Lo que el asesor puede pedir a env_query; debe ir en su prompt para que no adivine códigos."""
    require_env(conn)
    rows = conn.execute(
        """
        select variable_code as code, label, unit, description, temporal_resolution,
               coverage_start, coverage_end, allowed_aggregations, dataset_id
        from env.variable_catalog order by variable_code
        """
    ).fetchall()
    return EnvCatalogResponse(variables=rows)


@router.get("/plots/{plot_id}/environment-summary", response_model=PlotEnvironmentSummary)
def plot_environment_summary(plot_id: str, conn: Connection = Depends(get_conn)):
    plot = conn.execute("select is_demo from public.plots where id = %s", (plot_id,)).fetchone()
    if plot is None:
        raise ApiError(404, "Parcela no encontrada")
    summary = environment_summary(conn, plot_id)
    return PlotEnvironmentSummary(
        plot_id=plot_id,
        environment_summary=summary,
        data_freshness=summary.data_freshness if summary else "unknown",
        is_demo=plot["is_demo"],
    )


@router.get("/external-context", response_model=ExternalContextResponse)
def external_context(
    region: str = Query(min_length=1, max_length=200),
    threat_code: str = Query(min_length=1, max_length=100),
    limit: int = Query(default=5, ge=1, le=20),
    conn: Connection = Depends(get_conn),
):
    """Solo contexto revisado y vigente (sección 7.1). Una región sin contexto devuelve items vacío, no 404."""
    require_env(conn)
    rows = conn.execute(
        """
        select source_id, url, title, retrieved_at, valid_until, region, data_type, content
        from env.external_context
        where quality_status = 'reviewed'
          and (valid_until is null or valid_until > now())
          and (threat_code is null or threat_code = %(threat)s)
          and (region is null or region ilike '%%' || %(region)s || '%%' or %(region)s ilike '%%' || region || '%%')
        order by retrieved_at desc limit %(limit)s
        """,
        {"region": region.strip(), "threat": threat_code, "limit": limit},
    ).fetchall()
    return ExternalContextResponse(region=region, threat_code=threat_code, items=rows)


@router.post("/environment/query", response_model=EnvQueryResponse)
def env_query(body: EnvQueryRequest, conn: Connection = Depends(get_conn)):
    require_env(conn)

    with conn.transaction():
        conn.execute("set transaction read only")
        conn.execute("set local statement_timeout = 2000")  # presupuesto por consulta (sección 17)

        catalog = validate_variables(conn, body)
        cell_id, distance_km = resolve_cell(conn, body)
        days_back = body.window.days_back
        codes = [v.code for v in body.variables]

        end = body.window.end_date
        if cell_id is not None and end is None:
            end = conn.execute(
                "select max(date) as d from env.daily_observations where cell_id = %s and variable_code = any(%s)",
                (cell_id, codes),
            ).fetchone()["d"]

        series: dict[str, dict[date, float]] = {c: {} for c in codes}
        normals: dict[str, dict[int, float]] = {c: {} for c in codes}
        dataset_ids: set[str] = set()
        if cell_id is not None and end is not None:
            start = end - timedelta(days=days_back - 1)
            for r in conn.execute(
                """
                select variable_code, date, value, dataset_id from env.daily_observations
                where cell_id = %s and variable_code = any(%s) and date between %s and %s
                """,
                (cell_id, codes, start, end),
            ):
                series[r["variable_code"]][r["date"]] = r["value"]
                dataset_ids.add(r["dataset_id"])
            if body.compare_to_normal:
                for r in conn.execute(
                    "select variable_code, month, mean from env.climatology where cell_id = %s and variable_code = any(%s)",
                    (cell_id, codes),
                ):
                    normals[r["variable_code"]][r["month"]] = r["mean"]

    results = []
    for spec in body.variables:
        observed = series[spec.code]
        coverage = len(observed) / days_back
        value = aggregate(list(observed.values()), spec.aggregation) if coverage >= MIN_COVERAGE else None
        normal = expected_normal(sorted(observed), normals[spec.code], spec.aggregation) if value is not None else None
        results.append(EnvResult(
            code=spec.code,
            unit=catalog[spec.code]["unit"],
            aggregation=spec.aggregation,
            value=_round(value),
            normal=_round(normal),
            anomaly_ratio=_round(value / normal) if value is not None and normal else None,
            coverage=round(coverage, 2),
            missing_days=days_back - len(observed),
        ))

    latest = max((d for s in series.values() for d in s), default=None)
    return EnvQueryResponse(
        query_id=body.query_id,
        cell_id=cell_id,
        distance_km=distance_km,
        results=results,
        data_freshness=freshness(latest, datetime.now(timezone.utc).date()),
        latest_data_date=latest,
        dataset_ids=sorted(dataset_ids),
        is_demo=body.is_demo,
    )
