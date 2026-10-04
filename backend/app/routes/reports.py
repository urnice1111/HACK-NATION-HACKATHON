import logging

from fastapi import APIRouter, Depends, Header
from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.graph.engine import recalculate
from backend.app.idempotency import body_hash, claim_key, store_response
from contracts.enums import DEMO_THREAT_CODE, EventType
from contracts.models import ReportCreate, ReportCreated

router = APIRouter(prefix="/v1/reports", tags=["reports"])
log = logging.getLogger("api.reports")


def open_case_for(conn: Connection, plot_id: str, threat_code: str, is_demo: bool) -> str:
    """Repeated reports of the same episode join the plot's open case instead of opening a new one."""
    conn.execute(
        """
        insert into cases (plot_id, threat_code, is_demo) values (%s, %s, %s)
        on conflict (plot_id, threat_code) where status <> 'resolved' do nothing
        """,
        (plot_id, threat_code, is_demo),
    )
    return conn.execute(
        "select id from cases where plot_id = %s and threat_code = %s and status <> 'resolved'",
        (plot_id, threat_code),
    ).fetchone()["id"]


@router.post("", status_code=201, response_model=ReportCreated)
def create_report(
    body: ReportCreate,
    idempotency_key: str = Header(min_length=8, max_length=200),
    conn: Connection = Depends(get_conn),
):
    threat_code = DEMO_THREAT_CODE

    with conn.transaction():
        stored = claim_key(conn, idempotency_key, "reports.create", body_hash(body))
        if stored is not None:
            return stored

        plot = conn.execute("select id, is_demo from plots where id = %s", (body.plot_id,)).fetchone()
        if plot is None:
            raise ApiError(404, "Parcela no encontrada")
        if plot["is_demo"] != body.is_demo:
            raise ApiError(422, "is_demo no coincide con la parcela",
                           details=[{"field": "is_demo", "reason": "demo_mismatch"}])

        case_id = None
        if body.case_id:
            case = conn.execute(
                "select plot_id, status from cases where id = %s", (body.case_id,)
            ).fetchone()
            if case is None or case["plot_id"] != body.plot_id:
                raise ApiError(422, "case_id no pertenece a la parcela",
                               details=[{"field": "case_id", "reason": "case_plot_mismatch"}])
            if case["status"] != "resolved":
                case_id = body.case_id
        if case_id is None:
            case_id = open_case_for(conn, body.plot_id, threat_code, body.is_demo)

        report = conn.execute(
            """
            insert into reports (is_demo, case_id, plot_id, session_id, channel, observed_at, symptoms,
                                 measurements, user_statement, completeness, provider_reference, assessment_id)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id, received_at, processing_status
            """,
            (body.is_demo, case_id, body.plot_id, body.session_id, body.channel, body.observed_at,
             body.symptoms, Jsonb([m.model_dump(mode="json") for m in body.measurements]),
             body.user_statement, body.completeness, body.provider_reference, body.assessment_id),
        ).fetchone()

        conn.execute(
            """
            update cases set last_observation_at = greatest(last_observation_at, %s)
            where id = %s
            """,
            (report["received_at"], case_id),
        )

        conn.execute(
            """
            insert into outbox_events (is_demo, event_type, aggregate_id, correlation_id, payload)
            values (%s, %s, %s, %s, %s)
            """,
            (body.is_demo, EventType.report_created, report["id"], body.session_id,
             Jsonb({"report_id": report["id"], "case_id": case_id, "plot_id": body.plot_id,
                    "assessment_id": body.assessment_id})),
        )

        result = ReportCreated(
            report_id=report["id"],
            case_id=case_id,
            received_at=report["received_at"],
            processing_status=report["processing_status"],
            correlation_id=body.session_id,
        ).model_dump(mode="json")
        store_response(conn, idempotency_key, 201, result)

    # Until the worker exists, recalculate inline. A failure leaves the report saved as `pending`.
    try:
        recalculate(conn, threat_code)
        conn.execute("update reports set processing_status = 'processed' where id = %s", (result["report_id"],))
    except Exception:
        log.exception("recalculation failed after report %s", result["report_id"])
    return result
