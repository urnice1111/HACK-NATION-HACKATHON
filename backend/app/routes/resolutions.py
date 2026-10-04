import math
import re

from fastapi import APIRouter, Depends, Query
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.graph.engine import haversine_km
from contracts.models import (
    ResolutionList,
    ResolvedCaseResult,
    ResolvedCaseSearchRequest,
    ResolvedCaseSearchResponse,
)

router = APIRouter(prefix="/v1/resolved-cases", tags=["resolved-cases"])

SYMPTOM_WEIGHT = 0.6
PROXIMITY_DECAY_KM = 10.0


def words(symptoms: list[str]) -> set[str]:
    """Short words ("en", "las") would make any two descriptions look alike."""
    return {w for s in symptoms for w in re.findall(r"\w+", s.lower()) if len(w) > 3}


def symptom_similarity(a: list[str], b: list[str]) -> float:
    wa, wb = words(a), words(b)
    return len(wa & wb) / len(wa | wb) if wa and wb else 0.0


def distance_band(km: float) -> str:
    if km < 5:
        return "menos de 5 km"
    if km < 10:
        return "entre 5 y 10 km"
    if km < 20:
        return "entre 10 y 20 km"
    return "más de 20 km"


@router.post("/search", response_model=ResolvedCaseSearchResponse)
def search(body: ResolvedCaseSearchRequest, conn: Connection = Depends(get_conn)):
    """For the advisor: anonymised, so no plot, name or coordinates leave this endpoint."""
    origin = None
    if body.near_plot_id:
        origin = conn.execute("select latitude, longitude from plots where id = %s", (body.near_plot_id,)).fetchone()
        if origin is None:
            raise ApiError(404, "Parcela no encontrada")

    rows = conn.execute(
        """
        select cr.id, cr.threat_code, cr.symptoms, cr.resolved_at, cr.solution_statement, cr.solution_codes,
               cr.matches_protocol, cr.verification, c.opened_at, p.latitude, p.longitude
        from case_resolutions cr
        join cases c on c.id = cr.case_id
        join plots p on p.id = cr.plot_id
        where cr.threat_code = %s and cr.verification <> 'disputed'
          and (not %s or cr.verification = 'verified')
        """,
        (body.threat_code, body.only_verified),
    ).fetchall()

    results = []
    for row in rows:
        km = haversine_km(origin["latitude"], origin["longitude"], row["latitude"], row["longitude"]) if origin else None
        if km is not None and km > body.max_distance_km:
            continue
        proximity = math.exp(-km / PROXIMITY_DECAY_KM) if km is not None else 0.0
        similarity = (SYMPTOM_WEIGHT * symptom_similarity(body.symptoms, row["symptoms"])
                      + (1 - SYMPTOM_WEIGHT) * proximity)
        results.append(ResolvedCaseResult(
            resolution_id=row["id"],
            threat_code=row["threat_code"],
            similarity=round(similarity, 2),
            distance_band=distance_band(km) if km is not None else None,
            resolved_at=row["resolved_at"],
            days_to_resolution=max(0, (row["resolved_at"] - row["opened_at"]).days),
            solution_summary=row["solution_statement"] or "Sin descripción de la solución",
            solution_codes=row["solution_codes"],
            matches_protocol=row["matches_protocol"],
            verification=row["verification"],
        ))

    results.sort(key=lambda r: (r.similarity, r.resolved_at), reverse=True)
    return ResolvedCaseSearchResponse(results=results[: body.limit])


@router.get("", response_model=ResolutionList)
def list_resolutions(plot_id: str | None = None, limit: int = Query(default=50, ge=1, le=200),
                     conn: Connection = Depends(get_conn)):
    """For the operator dashboard."""
    rows = conn.execute(
        """
        select cr.id as resolution_id, cr.case_id, cr.plot_id, p.name as plot_label, cr.threat_code,
               cr.symptoms, cr.resolved_at, cr.solution_statement, cr.solution_codes, cr.matches_protocol,
               cr.outcome, cr.verification, cr.followup_id, cr.verified_by, cr.is_demo
        from case_resolutions cr join plots p on p.id = cr.plot_id
        where %(plot)s::text is null or cr.plot_id = %(plot)s
        order by cr.resolved_at desc limit %(limit)s
        """,
        {"plot": plot_id, "limit": limit},
    ).fetchall()
    return ResolutionList(resolutions=rows)
