from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.graph.engine import recalculate
from contracts.enums import DEMO_THREAT_CODE
from contracts.models import GraphResponse

router = APIRouter(prefix="/v1/graph", tags=["graph"])


@router.get("", response_model=GraphResponse)
def get_graph(threat_code: str = DEMO_THREAT_CODE, conn: Connection = Depends(get_conn)):
    nodes = conn.execute(
        """
        select p.id, p.name as label, p.latitude, p.longitude, p.is_demo,
               coalesce(r.inspection_priority, 'unknown') as inspection_priority,
               r.score, coalesce(r.contributions, '[]') as contributions, r.model_version,
               coalesce(r.data_freshness, 'unknown') as data_freshness,
               r.id as risk_evaluation_id, coalesce(r.reasons, '{}') as reasons,
               coalesce(r.evidence_report_ids, '{}') as evidence_report_ids,
               coalesce(r.heuristic, true) as heuristic,
               coalesce(
                 (select c.status from cases c
                  where c.plot_id = p.id and c.threat_code = %(t)s and c.status <> 'resolved' limit 1),
                 (select 'resolved' from cases c
                  where c.plot_id = p.id and c.threat_code = %(t)s and c.status = 'resolved' limit 1),
                 'none') as local_case_status
        from plots p
        left join lateral (
          select * from risk_evaluations re
          where re.plot_id = p.id and re.threat_code = %(t)s
          order by re.created_at desc limit 1
        ) r on true
        order by p.id
        """,
        {"t": threat_code},
    ).fetchall()

    edges = conn.execute(
        """
        select id, source_plot_id as source, target_plot_id as target, distance_km, environment_similarity,
               exposure_type, exposure_strength, missing_features, rule_version
        from edges where threat_code = %s order by id
        """,
        (threat_code,),
    ).fetchall()

    version = conn.execute(
        "select version from graph_versions where threat_code = %s", (threat_code,)
    ).fetchone()

    return GraphResponse(
        graph_version=version["version"] if version else 0,
        generated_at=datetime.now(UTC),
        threat_code=threat_code,
        nodes=nodes,
        edges=edges,
    )


@router.post("/recalculate")
def recalculate_graph(threat_code: str = DEMO_THREAT_CODE, conn: Connection = Depends(get_conn)):
    return recalculate(conn, threat_code)
