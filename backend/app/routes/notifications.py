"""Alert notification queue for communications (INSTRUCTIONS.md sections 11 and 17).

Alerts are delivered by the ElevenLabs "Alerts" voice agent: communications polls GET /v1/notifications and reports
each call's outcome to /status. The backend never places calls.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.idempotency import idempotent
from contracts.enums import EventType, NotificationStatus
from contracts.models import NotificationList, NotificationStatusRecorded, NotificationStatusUpdate

router = APIRouter(prefix="/v1/notifications", tags=["notifications"])
log = logging.getLogger("api.notifications")

# Out-of-order callbacks never degrade a terminal state (section 11).
TERMINAL = ("delivered", "failed", "cancelled")


@router.get("", response_model=NotificationList)
def list_notifications(
    status: NotificationStatus | None = None,
    channel: Literal["voice", "sms"] | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    conn: Connection = Depends(get_conn),
):
    """Alert notifications only, oldest first, with the contact so communications can call within the rules."""
    rows = conn.execute(
        """
        select n.id as notification_id, n.alert_id, a.plot_id, p.name as plot_label, f.name as farmer_name,
               n.channel, n.status, n.attempt_count, n.provider_reference, a.message,
               json_build_object(
                 'phone_e164', ct.phone_e164, 'preferred_language', f.preferred_language,
                 'timezone', f.timezone, 'allowed_hours', ct.allowed_hours,
                 'notification_consent', ct.notification_consent
               ) as contact,
               n.created_at, n.updated_at, n.is_demo
        from notifications n
        join alerts a on a.id = n.alert_id
        join plots p on p.id = a.plot_id
        join farmers f on f.id = p.farmer_id
        join contacts ct on ct.id = n.contact_id
        where (%(status)s::text is null or n.status = %(status)s)
          and (%(channel)s::text is null or n.channel = %(channel)s)
        order by n.created_at limit %(limit)s
        """,
        {"status": status, "channel": channel, "limit": limit},
    ).fetchall()
    return NotificationList(notifications=rows, is_demo=all(r["is_demo"] for r in rows))


@router.post("/{notification_id}/status", response_model=NotificationStatusRecorded)
def record_status(notification_id: str, body: NotificationStatusUpdate,
                  idempotency_key: str = Header(min_length=8, max_length=200),
                  conn: Connection = Depends(get_conn)):
    """`delivered` = the farmer confirmed on the call that they heard the alert; never "read" or "acted on"."""

    def run() -> tuple[int, dict]:
        current = conn.execute(
            """
            select id, alert_id, status, attempt_count, provider_reference, is_demo
            from notifications where id = %s for update
            """,
            (notification_id,),
        ).fetchone()
        if current is None:
            raise ApiError(404, "Notificación no encontrada")

        if current["status"] in TERMINAL:
            log.info("notification status ignored id=%s current=%s update=%s",
                     notification_id, current["status"], body.status)
            return 200, NotificationStatusRecorded(
                notification_id=notification_id, status=current["status"], attempt_count=current["attempt_count"],
                provider_reference=current["provider_reference"], applied=False, is_demo=current["is_demo"],
            ).model_dump(mode="json")

        updated = conn.execute(
            """
            update notifications set
              status = %(status)s,
              attempt_count = attempt_count + case when %(status)s::text = 'sending' then 1 else 0 end,
              provider_reference = coalesce(%(ref)s::text, provider_reference),
              last_error = case when %(status)s::text = 'failed' then %(error)s::text else last_error end
            where id = %(id)s
            returning status, attempt_count, provider_reference, version
            """,
            {"status": body.status, "ref": body.provider_reference, "error": body.error_code, "id": notification_id},
        ).fetchone()
        conn.execute(
            "insert into outbox_events (is_demo, event_type, occurred_at, aggregate_id, aggregate_version, payload) "
            "values (%s, %s, %s, %s, %s, %s)",
            (current["is_demo"], EventType.notification_status_changed, body.occurred_at, notification_id,
             updated["version"],
             Jsonb({"notification_id": notification_id, "alert_id": current["alert_id"],
                    "status": updated["status"], "provider_reference": updated["provider_reference"]})),
        )
        log.info("notification status id=%s %s->%s attempts=%d",
                 notification_id, current["status"], updated["status"], updated["attempt_count"])
        return 200, NotificationStatusRecorded(
            notification_id=notification_id, status=updated["status"], attempt_count=updated["attempt_count"],
            provider_reference=updated["provider_reference"], applied=True, is_demo=current["is_demo"],
        ).model_dump(mode="json")

    return idempotent(conn, idempotency_key, f"notifications.status:{notification_id}", body, run)
