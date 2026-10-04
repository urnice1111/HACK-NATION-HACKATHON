import json
import logging

from fastapi import APIRouter, Depends, Header
from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.followups import schedule_followup
from backend.app.graph.engine import recalculate
from backend.app.idempotency import idempotent, is_replay
from contracts.enums import DEMO_THREAT_CODE, EventType
from contracts.models import ReportCreate, ReportCreated, ReportDetail

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


def resolve_case(conn: Connection, body: ReportCreate, threat_code: str) -> str | None:
    if body.plot_id is None:
        if body.case_id is not None:
            raise ApiError(422, "case_id requiere plot_id", details=[{"field": "case_id", "reason": "requires_plot"}])
        return None

    plot = conn.execute("select is_demo from plots where id = %s", (body.plot_id,)).fetchone()
    if plot is None:
        raise ApiError(404, "Parcela no encontrada")
    if plot["is_demo"] != body.is_demo:
        raise ApiError(422, "is_demo no coincide con la parcela",
                       details=[{"field": "is_demo", "reason": "demo_mismatch"}])

    if body.case_id:
        case = conn.execute("select plot_id, status from cases where id = %s", (body.case_id,)).fetchone()
        if case is None or case["plot_id"] != body.plot_id:
            raise ApiError(422, "case_id no pertenece a la parcela",
                           details=[{"field": "case_id", "reason": "case_plot_mismatch"}])
        if case["status"] != "resolved":
            return body.case_id
    return open_case_for(conn, body.plot_id, threat_code, body.is_demo)


@router.post("", status_code=201, response_model=ReportCreated)
def create_report(
    body: ReportCreate,
    idempotency_key: str = Header(min_length=8, max_length=200),
    conn: Connection = Depends(get_conn),
):
    threat_code = DEMO_THREAT_CODE

    def run() -> tuple[int, dict]:
        case_id = resolve_case(conn, body, threat_code)
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

        if case_id:
            conn.execute(
                "update cases set last_observation_at = greatest(last_observation_at, %s) where id = %s",
                (report["received_at"], case_id),
            )
            schedule_followup(conn, case_id, body.is_demo)
        conn.execute(
            """
            insert into outbox_events (is_demo, event_type, aggregate_id, correlation_id, payload)
            values (%s, %s, %s, %s, %s)
            """,
            (body.is_demo, EventType.report_created, report["id"], body.session_id,
             Jsonb({"report_id": report["id"], "case_id": case_id, "plot_id": body.plot_id,
                    "assessment_id": body.assessment_id})),
        )
        return 201, ReportCreated(
            report_id=report["id"], case_id=case_id, received_at=report["received_at"],
            processing_status=report["processing_status"], correlation_id=body.session_id,
        ).model_dump(mode="json")

    response = idempotent(conn, idempotency_key, "reports.create", body, run)

    # Until the worker exists, recalculate inline. A failure leaves the report saved as `pending`.
    report_id = json.loads(response.body)["report_id"]
    if not is_replay(response) and body.plot_id is not None:
        try:
            recalculate(conn, threat_code)
            conn.execute("update reports set processing_status = 'processed' where id = %s", (report_id,))
        except Exception:
            log.exception("recalculation failed after report %s", report_id)
    return response


@router.get("/{report_id}", response_model=ReportDetail)
def get_report(report_id: str, conn: Connection = Depends(get_conn)):
    row = conn.execute(
        """
        select id as report_id, case_id, plot_id, session_id, channel, provider_reference, observed_at,
               received_at, symptoms, measurements, coalesce(user_statement, '') as user_statement,
               completeness, assessment_id, processing_status, created_at, is_demo
        from reports where id = %s
        """,
        (report_id,),
    ).fetchone()
    if row is None:
        raise ApiError(404, "Reporte no encontrado")
    return ReportDetail(**row)
