import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, Query
from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.config import settings
from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.followups import OPEN_STATUSES, schedule_followup
from backend.app.graph.engine import recalculate
from backend.app.idempotency import idempotent, is_replay
from contracts.enums import EventType, FollowUpStatus
from contracts.models import (
    FollowupAttemptRecorded,
    FollowupAttemptRequest,
    FollowupList,
    FollowUpResponseRequest,
    FollowUpResponseResult,
)

router = APIRouter(prefix="/v1/followups", tags=["followups"])
log = logging.getLogger("api.followups")


@router.get("", response_model=FollowupList)
def list_followups(
    status: FollowUpStatus | None = None,
    due_before: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    conn: Connection = Depends(get_conn),
):
    """Includes the contact (phone, hours, consent) so communications can dial within the rules."""
    rows = conn.execute(
        """
        select f.id as followup_id, f.case_id, c.plot_id, f.due_at, f.status, f.channel, f.attempt_count,
               f.questionnaire_version, f.call_reference, f.is_demo,
               json_build_object(
                 'farmer_name', fa.name, 'threat_code', c.threat_code, 'case_status', c.status,
                 'opened_at', c.opened_at,
                 'symptoms', coalesce((select array_agg(distinct s) from reports r, unnest(r.symptoms) s
                                       where r.case_id = c.id), '{}'),
                 'guidance_given', (
                   select string_agg(rec->>'text', '; ')
                   from (select a.recommendations from assessments a
                         join reports r on r.id = a.report_id or r.assessment_id = a.id
                         where r.case_id = c.id order by a.created_at desc limit 1) latest,
                        jsonb_array_elements(latest.recommendations) rec)
               ) as case_summary,
               json_build_object(
                 'phone_e164', ct.phone_e164, 'preferred_language', fa.preferred_language,
                 'timezone', fa.timezone, 'allowed_hours', ct.allowed_hours,
                 'followup_call_consent', ct.followup_call_consent,
                 'notification_consent', ct.notification_consent
               ) as contact
        from followups f
        join cases c on c.id = f.case_id
        join plots p on p.id = c.plot_id
        join farmers fa on fa.id = p.farmer_id
        join contacts ct on ct.id = fa.contact_id
        where (%(status)s::text is null or f.status = %(status)s)
          and (%(due)s::timestamptz is null or f.due_at <= %(due)s)
        order by f.due_at limit %(limit)s
        """,
        {"status": status, "due": due_before, "limit": limit},
    ).fetchall()
    return FollowupList(followups=rows, is_demo=all(r["is_demo"] for r in rows))


def lock_open_followup(conn: Connection, followup_id: str) -> dict:
    followup = conn.execute(
        """
        select f.id, f.case_id, f.status, f.attempt_count, f.channel, f.is_demo, c.plot_id, c.status as case_status
        from followups f join cases c on c.id = f.case_id
        where f.id = %s for update of f
        """,
        (followup_id,),
    ).fetchone()
    if followup is None:
        raise ApiError(404, "Seguimiento no encontrado")
    if followup["status"] not in OPEN_STATUSES:
        raise ApiError(409, f"El seguimiento ya está en estado {followup['status']}", code="FOLLOWUP_CLOSED")
    return followup


@router.post("/{followup_id}/attempts", response_model=FollowupAttemptRecorded)
def record_attempt(followup_id: str, body: FollowupAttemptRequest,
                   idempotency_key: str = Header(min_length=8, max_length=200),
                   conn: Connection = Depends(get_conn)):
    """No answer only changes the follow-up: never the case or the risk."""

    def run() -> tuple[int, dict]:
        followup = lock_open_followup(conn, followup_id)
        contacting = body.status == "contacting"
        attempts = followup["attempt_count"] + (1 if contacting else 0)
        channel = body.channel if contacting else followup["channel"]
        retry_in = None
        if body.status == "no_response" and channel == "voice":
            # After the last call the SMS fallback is due immediately.
            retry_in = settings.followup_retry_s if attempts < settings.followup_call_attempts else 0

        updated = conn.execute(
            """
            update followups set
              status = %(status)s, attempt_count = %(attempts)s, channel = %(channel)s,
              call_reference = case when %(contacting)s then %(ref)s else call_reference end,
              due_at = case when %(retry)s::int is null then due_at else now() + make_interval(secs => %(retry)s) end
            where id = %(id)s
            returning status, attempt_count
            """,
            {"status": body.status, "attempts": attempts, "channel": channel, "contacting": contacting,
             "ref": body.call_reference, "retry": retry_in, "id": followup_id},
        ).fetchone()
        log.info("followup attempt id=%s status=%s attempts=%d", followup_id, body.status, attempts)
        return 200, FollowupAttemptRecorded(followup_id=followup_id, status=updated["status"],
                                            attempt_count=updated["attempt_count"],
                                            is_demo=followup["is_demo"]).model_dump(mode="json")

    return idempotent(conn, idempotency_key, f"followups.attempt:{followup_id}", body, run)


@router.post("/{followup_id}/responses", status_code=201, response_model=FollowUpResponseResult)
def record_response(followup_id: str, body: FollowUpResponseRequest,
                    idempotency_key: str = Header(min_length=8, max_length=200),
                    conn: Connection = Depends(get_conn)):
    def run() -> tuple[int, dict]:
        followup = lock_open_followup(conn, followup_id)
        case_id, plot_id, is_demo = followup["case_id"], followup["plot_id"], followup["is_demo"]

        report = conn.execute(
            """
            insert into reports (is_demo, case_id, plot_id, session_id, channel, user_statement, completeness,
                                 provider_reference)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            returning id, received_at
            """,
            (is_demo, case_id, plot_id, body.session_id, body.channel, body.user_statement,
             "partial" if body.status_reported == "unknown" else "sufficient", body.provider_reference),
        ).fetchone()
        conn.execute(
            "update followups set status = 'responded', channel = %s, response_report_id = %s where id = %s",
            (body.channel, report["id"], followup_id),
        )
        conn.execute(
            "update cases set last_observation_at = greatest(last_observation_at, %s) where id = %s",
            (report["received_at"], case_id),
        )

        resolution_id, next_followup_at, case_status = None, None, followup["case_status"]
        if body.status_reported == "resolved":
            resolution_id = create_resolution(conn, followup, body)
            case_status = "resolved"
        else:
            next_followup_at = schedule_followup(conn, case_id, is_demo)

        conn.execute(
            "insert into outbox_events (is_demo, event_type, aggregate_id, correlation_id, payload) "
            "values (%s, %s, %s, %s, %s)",
            (is_demo, EventType.followup_responded, followup_id, body.session_id,
             Jsonb({"followup_id": followup_id, "report_id": report["id"], "case_id": case_id,
                    "status_reported": body.status_reported,
                    "review_proposed": body.status_reported in ("worse", "same")})),
        )
        log.info("followup responded id=%s status=%s resolution=%s", followup_id, body.status_reported, resolution_id)
        return 201, FollowUpResponseResult(report_id=report["id"], case_id=case_id, case_status=case_status,
                                           resolution_id=resolution_id,
                                           next_followup_at=next_followup_at).model_dump(mode="json")

    response = idempotent(conn, idempotency_key, f"followups.response:{followup_id}", body, run)

    if not is_replay(response):
        report_id = json.loads(response.body)["report_id"]
        try:
            recalculate(conn, "coffee_leaf_rust")
            conn.execute("update reports set processing_status = 'processed' where id = %s", (report_id,))
        except Exception:
            log.exception("recalculation failed after follow-up %s", followup_id)
    return response


def create_resolution(conn: Connection, followup: dict, body: FollowUpResponseRequest) -> str:
    """One resolution per case: a second "resolved" answer returns the existing one."""
    case_id = followup["case_id"]
    existing = conn.execute("select id from case_resolutions where case_id = %s", (case_id,)).fetchone()
    if existing:
        return existing["id"]

    resolution = conn.execute(
        """
        insert into case_resolutions (is_demo, case_id, plot_id, threat_code, symptoms, resolved_at,
                                      solution_statement, outcome, verification, followup_id)
        select c.is_demo, c.id, c.plot_id, c.threat_code,
               coalesce((select array_agg(distinct s) from reports r, unnest(r.symptoms) s where r.case_id = c.id), '{}'),
               coalesce(%(noticed)s, now()), %(solution)s, 'resolved', 'farmer_reported', %(followup)s
        from cases c where c.id = %(case)s
        returning id, threat_code, plot_id
        """,
        {"noticed": body.change_noticed_at, "solution": body.actions_taken or body.user_statement,
         "followup": followup["id"], "case": case_id},
    ).fetchone()
    conn.execute(
        """
        update cases set status = 'resolved', closed_at = now(), close_reason = 'Resuelto según seguimiento',
                         closed_by = 'followup'
        where id = %s
        """,
        (case_id,),
    )
    conn.execute(
        "insert into outbox_events (is_demo, event_type, aggregate_id, payload) values (%s, %s, %s, %s)",
        (followup["is_demo"], EventType.case_resolved, case_id,
         Jsonb({"case_id": case_id, "resolution_id": resolution["id"], "plot_id": resolution["plot_id"],
                "threat_code": resolution["threat_code"]})),
    )
    return resolution["id"]
